import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppEnv } from "../env.js";
import { decryptString } from "./crypto.js";
import type { StreamTicket } from "./tickets.js";

const playlistContentTypes = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl"
];

export async function proxyHlsPlaylist(
  env: AppEnv,
  ticket: StreamTicket,
  token: string,
  reply: FastifyReply,
  upstreamPath: string
): Promise<FastifyReply> {
  const upstreamUrl = resolveUpstreamUrl(ticket.serverUrl, upstreamPath);
  const response = await fetchUpstream(env, ticket, upstreamUrl);

  if (!response.ok) {
    return reply.code(response.status).send(await response.text().catch(() => ""));
  }

  const playlist = await response.text();
  const rewritten = rewriteHlsPlaylist(playlist, upstreamUrl, ticket, token);

  return reply
    .code(response.status)
    .header("Content-Type", "application/vnd.apple.mpegurl")
    .header("Cache-Control", "no-store")
    .send(rewritten);
}

export async function proxyHlsAsset(
  env: AppEnv,
  ticket: StreamTicket,
  token: string,
  request: FastifyRequest,
  reply: FastifyReply,
  target: string
): Promise<FastifyReply> {
  const upstreamUrl = resolveUpstreamUrl(ticket.serverUrl, target);
  const response = await fetchUpstream(env, ticket, upstreamUrl, request.headers.range);
  const contentType = response.headers.get("content-type") ?? "";

  if (isPlaylistContent(contentType) || upstreamUrl.pathname.endsWith(".m3u8")) {
    if (!response.ok) {
      return reply.code(response.status).send(await response.text().catch(() => ""));
    }

    const rewritten = rewriteHlsPlaylist(await response.text(), upstreamUrl, ticket, token);
    return reply
      .code(response.status)
      .header("Content-Type", "application/vnd.apple.mpegurl")
      .header("Cache-Control", "no-store")
      .send(rewritten);
  }

  return sendStreamResponse(response, reply);
}

export async function proxyDirectStream(
  env: AppEnv,
  ticket: StreamTicket,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  if (!ticket.directPath) {
    return reply.code(404).send({
      error: {
        code: "direct_stream_unavailable",
        message: "Direct stream is not available for this ticket."
      }
    });
  }

  const upstreamUrl = resolveUpstreamUrl(ticket.serverUrl, ticket.directPath);
  const response = await fetchUpstream(env, ticket, upstreamUrl, request.headers.range);

  const fallbackType = ticket.directPath?.includes(".webm")
    ? "video/webm"
    : "video/mp4";

  return sendStreamResponse(response, reply, fallbackType);
}

function rewriteHlsPlaylist(playlist: string, playlistUrl: URL, ticket: StreamTicket, token: string): string {
  return playlist
    .split(/\r?\n/)
    .map((line) => rewritePlaylistLine(line, playlistUrl, ticket, token))
    .join("\n");
}

function rewritePlaylistLine(line: string, playlistUrl: URL, ticket: StreamTicket, token: string): string {
  if (!line.trim()) {
    return line;
  }

  if (line.startsWith("#")) {
    return line.replaceAll(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${mediaProxyUrl(token, resolvePlaylistReference(uri, playlistUrl))}"`);
  }

  return mediaProxyUrl(token, resolvePlaylistReference(line, playlistUrl));
}

function mediaProxyUrl(token: string, upstreamUrl: URL): string {
  return `/media/hls/${encodeURIComponent(token)}/asset?u=${encodeURIComponent(mediaTarget(upstreamUrl))}`;
}

function mediaTarget(upstreamUrl: URL): string {
  upstreamUrl.searchParams.delete("ApiKey");
  upstreamUrl.searchParams.delete("api_key");

  return `${upstreamUrl.pathname}${upstreamUrl.search}${upstreamUrl.hash}`;
}

function resolvePlaylistReference(reference: string, playlistUrl: URL): URL {
  return new URL(reference, playlistUrl);
}

function resolveUpstreamUrl(serverUrl: string, target: string): URL {
  const base = new URL(serverUrl);
  const resolved = new URL(target, base);

  if (resolved.origin !== base.origin) {
    throw new StreamProxyError("invalid_media_target", "Media target is outside the configured Jellyfin server.");
  }

  return resolved;
}

async function fetchUpstream(env: AppEnv, ticket: StreamTicket, upstreamUrl: URL, range?: string | string[]): Promise<Response> {
  const token = decryptString(env, ticket.encryptedAccessToken);
  const headers = new Headers({
    Authorization: jellyfinAuthorizationHeader(token)
  });

  if (typeof range === "string") {
    headers.set("Range", range);
  }

  return fetch(upstreamUrl, { headers });
}

function sendStreamResponse(response: Response, reply: FastifyReply, fallbackContentType?: string): FastifyReply {
  const headers = proxyResponseHeaders(response, fallbackContentType);

  for (const [key, value] of Object.entries(headers)) {
    reply.header(key, value);
  }

  reply.code(response.status);

  if (!response.body) {
    return reply.send();
  }

  return reply.send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
}

function proxyResponseHeaders(response: Response, fallbackContentType?: string): Record<string, string> {
  const allowedHeaders = [
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified"
  ];
  const headers: Record<string, string> = {};

  for (const header of allowedHeaders) {
    const value = response.headers.get(header);

    if (value) {
      headers[header] = value;
    }
  }

  headers["cache-control"] = headers["cache-control"] ?? "no-store";

  if (!headers["content-type"] && fallbackContentType) {
    headers["content-type"] = fallbackContentType;
  }

  // Some Electron/Discord builds reject progressive streams with ambiguous MIME types.
  if (headers["content-type"]?.includes("application/octet-stream") && fallbackContentType) {
    headers["content-type"] = fallbackContentType;
  }

  return headers;
}

function isPlaylistContent(contentType: string): boolean {
  return playlistContentTypes.some((candidate) => contentType.toLowerCase().includes(candidate));
}

function jellyfinAuthorizationHeader(token: string): string {
  const parts = [
    `Client="${escapeHeaderValue("Jellyfin Discord Activity")}"`,
    `Device="${escapeHeaderValue("Discord Activity Backend")}"`,
    `DeviceId="${escapeHeaderValue("jellyfin-discord-activity-backend")}"`,
    `Version="${escapeHeaderValue("0.1.0")}"`,
    `Token="${escapeHeaderValue(token)}"`
  ];

  return `MediaBrowser ${parts.join(", ")}`;
}

function escapeHeaderValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

export class StreamProxyError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string
  ) {
    super(code);
  }
}
