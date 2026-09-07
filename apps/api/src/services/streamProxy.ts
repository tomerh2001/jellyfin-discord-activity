import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppEnv } from "../env.js";
import { decryptString } from "./crypto.js";
import { streamTicketStore, type StreamTicket } from "./tickets.js";
import { sessionStore } from "./sessionStore.js";
import { renewActivityMembership } from "./appSession.js";

const playlistContentTypes = [
  "application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"
];
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;
const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;
const MAX_STREAM_DURATION_MS = 6 * 60 * 60 * 1000;

type Upstream = {
  response: Response;
  signal: AbortSignal;
  touch: () => void;
  dispose: () => void;
};

export async function proxyHlsPlaylist(
  env: AppEnv,
  ticket: StreamTicket,
  token: string,
  request: FastifyRequest,
  reply: FastifyReply,
  upstreamPath: string
): Promise<FastifyReply> {
  const upstreamUrl = resolveUpstreamUrl(ticket.serverUrl, upstreamPath);
  const upstream = await fetchUpstream(env, ticket, upstreamUrl, request, reply);
  return sendPlaylist(upstream, upstreamUrl, ticket, token, reply);
}

export async function proxyHlsAsset(
  env: AppEnv,
  ticket: StreamTicket,
  token: string,
  request: FastifyRequest,
  reply: FastifyReply,
  assetId: string
): Promise<FastifyReply> {
  const target = ticket.assets.get(assetId);
  if (!target) {
    throw new StreamProxyError("invalid_media_target", "HLS asset was not issued for this stream.");
  }
  const upstreamUrl = resolveUpstreamUrl(ticket.serverUrl, target);
  const upstream = await fetchUpstream(env, ticket, upstreamUrl, request, reply, request.headers.range);
  const contentType = upstream.response.headers.get("content-type") ?? "";

  if (isPlaylistContent(contentType) || upstreamUrl.pathname.endsWith(".m3u8")) {
    return sendPlaylist(upstream, upstreamUrl, ticket, token, reply);
  }
  return sendStreamResponse(upstream, reply);
}

export async function proxyDirectStream(
  env: AppEnv,
  ticket: StreamTicket,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  if (!ticket.directPath) {
    throw new StreamProxyError("direct_stream_unavailable", "Direct stream is not available for this ticket.");
  }
  const upstreamUrl = resolveUpstreamUrl(ticket.serverUrl, ticket.directPath);
  const upstream = await fetchUpstream(env, ticket, upstreamUrl, request, reply, request.headers.range);
  const fallbackType = upstreamUrl.pathname.endsWith(".webm") ? "video/webm" : "video/mp4";
  return sendStreamResponse(upstream, reply, fallbackType);
}

async function sendPlaylist(upstream: Upstream, url: URL, ticket: StreamTicket, token: string, reply: FastifyReply): Promise<FastifyReply> {
  try {
    if (!upstream.response.ok) return sendUpstreamError(upstream.response, reply);
    const playlist = await readPlaylist(upstream);
    if (!playlist.trimStart().startsWith("#EXTM3U")) {
      throw new StreamProxyError("invalid_playlist", "Jellyfin returned an invalid HLS playlist.");
    }
    const rewritten = rewriteHlsPlaylist(playlist, url, ticket, token);
    return reply.code(200)
      .header("Content-Type", "application/vnd.apple.mpegurl")
      .header("Cache-Control", "no-store")
      .send(rewritten);
  } finally {
    upstream.dispose();
  }
}

async function readPlaylist(upstream: Upstream): Promise<string> {
  if (!upstream.response.body) return "";
  const stream = Readable.fromWeb(upstream.response.body as unknown as NodeReadableStream, { signal: upstream.signal });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > MAX_PLAYLIST_BYTES) {
        throw new StreamProxyError("invalid_playlist", "Jellyfin returned an oversized HLS playlist.");
      }
      upstream.touch();
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof StreamProxyError) throw error;
    throw new StreamProxyError("upstream_stream_failed", "Jellyfin media transfer was interrupted.");
  } finally {
    stream.destroy();
  }
}

function rewriteHlsPlaylist(playlist: string, playlistUrl: URL, ticket: StreamTicket, token: string): string {
  return playlist.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith("#")) {
      return line.replaceAll(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${mediaProxyUrl(ticket, token, uri, playlistUrl)}"`);
    }
    return mediaProxyUrl(ticket, token, line.trim(), playlistUrl);
  }).join("\n");
}

function mediaProxyUrl(ticket: StreamTicket, token: string, reference: string, playlistUrl: URL): string {
  // Validate the original reference before stripping secrets. Never rebase an
  // external URI onto the Jellyfin origin or accept a redirect to another host.
  const upstreamUrl = resolveUpstreamUrl(ticket.serverUrl, new URL(reference, playlistUrl).href);
  const assetId = streamTicketStore.issueAsset(ticket, upstreamUrl.href);
  return `/media/hls/${encodeURIComponent(token)}/asset?a=${encodeURIComponent(assetId)}`;
}

function resolveUpstreamUrl(serverUrl: string, target: string): URL {
  const base = new URL(serverUrl);
  const resolved = new URL(target, base);
  if (resolved.origin !== base.origin || resolved.username || resolved.password || !["http:", "https:"].includes(resolved.protocol)) {
    throw new StreamProxyError("invalid_media_target", "Media target is outside the configured Jellyfin server.");
  }
  for (const key of [...resolved.searchParams.keys()]) {
    if (["apikey", "api_key", "access_token", "token"].includes(key.toLowerCase())) resolved.searchParams.delete(key);
  }
  resolved.hash = "";
  return resolved;
}

async function fetchUpstream(
  env: AppEnv,
  ticket: StreamTicket,
  upstreamUrl: URL,
  request: FastifyRequest,
  reply: FastifyReply,
  range?: string | string[]
): Promise<Upstream> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const unsubscribeRevocation = sessionStore.onRevoke((sessionId) => {
    if (sessionId === ticket.appSessionId) abort();
  });
  let idleTimer = setTimeout(abort, UPSTREAM_HEADERS_TIMEOUT_MS);
  const lifetimeTimer = setTimeout(abort, Math.max(0, Math.min(MAX_STREAM_DURATION_MS, ticket.sessionExpiresAt.getTime() - Date.now())));
  const verifyMembership = async () => {
    const session = sessionStore.getSession(ticket.appSessionId);
    if (!session || !streamTicketStore.sessionIsActive(ticket)) throw new Error("session_expired");
    await renewActivityMembership(env, session);
    if (!streamTicketStore.sessionIsActive(ticket)) throw new Error("session_expired");
  };
  const sessionTimer = setInterval(() => {
    void verifyMembership().catch(abort);
  }, 1000);
  idleTimer.unref();
  lifetimeTimer.unref();
  sessionTimer.unref();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);

  const dispose = () => {
    clearTimeout(idleTimer);
    clearTimeout(lifetimeTimer);
    clearInterval(sessionTimer);
    unsubscribeRevocation();
    request.raw.off("aborted", abort);
    reply.raw.off("close", abort);
    abort();
  };
  const touch = () => {
    if (!streamTicketStore.sessionIsActive(ticket)) abort();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(abort, UPSTREAM_IDLE_TIMEOUT_MS);
    idleTimer.unref();
  };
  try {
    await verifyMembership();
    const headers = new Headers({ Authorization: jellyfinAuthorizationHeader(decryptString(env, ticket.encryptedAccessToken)) });
    if (typeof range === "string") headers.set("Range", range);
    const response = await fetch(upstreamUrl, { headers, redirect: "manual", signal: controller.signal });
    // Do not return Location headers/bodies: both can contain Jellyfin tokens.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new StreamProxyError("upstream_redirect_rejected", "Jellyfin returned an unexpected media redirect.");
    }
    touch();
    return { response, signal: controller.signal, touch, dispose };
  } catch (error) {
    dispose();
    if (error instanceof StreamProxyError) throw error;
    throw new StreamProxyError("upstream_unavailable", "Could not load media from Jellyfin.");
  }
}

function sendUpstreamError(response: Response, reply: FastifyReply): FastifyReply {
  // Keep useful HTTP status/range information, never echo an upstream error body.
  if (response.status === 416 && response.headers.get("content-range")) reply.header("Content-Range", response.headers.get("content-range"));
  return reply.code(response.status).header("Cache-Control", "no-store").send({
    error: { code: "upstream_media_failed", message: "Jellyfin could not serve this media request." }
  });
}

function sendStreamResponse(upstream: Upstream, reply: FastifyReply, fallbackContentType?: string): FastifyReply {
  const { response } = upstream;
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    upstream.dispose();
    return sendUpstreamError(response, reply);
  }
  for (const [key, value] of Object.entries(proxyResponseHeaders(response, fallbackContentType))) reply.header(key, value);
  reply.code(response.status);
  if (!response.body) {
    upstream.dispose();
    return reply.send();
  }
  const source = Readable.fromWeb(response.body as unknown as NodeReadableStream, { signal: upstream.signal });
  const stream = Readable.from((async function* () {
    try {
      for await (const chunk of source) {
        upstream.touch();
        if (upstream.signal.aborted) break;
        yield chunk as Buffer;
      }
    } catch {
      throw new StreamProxyError("upstream_stream_failed", "Jellyfin media transfer was interrupted.");
    } finally {
      source.destroy();
      upstream.dispose();
    }
  })());
  stream.once("close", () => { source.destroy(); upstream.dispose(); });
  return reply.send(stream);
}

function proxyResponseHeaders(response: Response, fallbackContentType?: string): Record<string, string> {
  const allowedHeaders = ["accept-ranges", "content-length", "content-range", "content-type"];
  const headers: Record<string, string> = { "cache-control": "no-store" };
  for (const header of allowedHeaders) {
    const value = response.headers.get(header);
    if (value) headers[header] = value;
  }
  if ((!headers["content-type"] || headers["content-type"].includes("application/octet-stream")) && fallbackContentType) {
    headers["content-type"] = fallbackContentType;
  }
  return headers;
}

function isPlaylistContent(contentType: string): boolean {
  return playlistContentTypes.some((candidate) => contentType.toLowerCase().includes(candidate));
}

function jellyfinAuthorizationHeader(token: string): string {
  const parts = [
    'Client="Jellyfin Discord Activity"', 'Device="Discord Activity Backend"',
    'DeviceId="jellyfin-discord-activity-backend"', 'Version="0.1.0"',
    `Token="${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  ];
  return `MediaBrowser ${parts.join(", ")}`;
}

export class StreamProxyError extends Error {
  constructor(readonly code: string, readonly publicMessage: string) { super(code); }
}
