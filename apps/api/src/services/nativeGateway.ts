import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyReply, FastifyRequest } from "fastify";
import WebSocket, { type RawData } from "ws";
import { upstreamWebSocketOptions } from "./upstreamPolicy.js";
import { NativeError, nativeAuthorization, nativeSessionId, type NativePartyService, type NativeViewer } from "./nativeParty.js";
import { isNativeQueuePath, nativeQueueShape } from "./nativeQueueDiagnostics.js";
import { sendNativeText } from "./nativeResponse.js";

const ID = "[a-zA-Z0-9_-]{1,128}";
const SECRET_KEYS = new Set(["apikey", "api_key", "access_token", "accesstoken", "token", "password", "pw", "authorization", "x-emby-token", "x-mediabrowser-token"]);
const MAX_JSON = 16 * 1024 * 1024;
// Native VOD playlists repeat the complete transcode query for every segment.
// Feature films can exceed 2MiB; retain a bounded 32MiB allowance.
const MAX_PLAYLIST = 32 * 1024 * 1024;
const MAX_SOCKET_BUFFER = 1024 * 1024;
const readRules = [
  /^\/System\/Info(?:\/Public)?$/i,
  /^\/System\/Endpoint$/i,
  /^\/Playback\/BitrateTest$/i,
  new RegExp(`^/Videos/${ID}/Trickplay/[0-9]+/(?:tiles\\.m3u8|[0-9]+\\.jpg)$`, "i"),
  /^\/(?:UserViews|GetUTCTime)$/i,
  /^\/Branding\/Configuration$/i,
  /^\/Localization\/(?:Cultures|Countries|ParentalRatings|Options)$/i,
  /^\/Items(?:\/(?:Filters|Filters2|Counts|Root))?$/i,
  new RegExp(`^/Items/${ID}(?:/(?:Ancestors|Similar|ThemeMedia|ThemeSongs|ThemeVideos|PlaybackInfo|Chapters))?$`, "i"),
  new RegExp(`^/(?:Items|Persons|Artists|Studios|Genres|MusicGenres|Users)/${ID}/Images/[a-z]+(?:/\\d+)?$`, "i"),
  /^\/(?:Genres|MusicGenres|Artists|Artists\/AlbumArtists|Persons|Studios|Years)$/i,
  /^\/Search\/Hints$/i,
  /^\/Shows\/(?:NextUp|Upcoming)$/i,
  new RegExp(`^/Shows/${ID}/(?:Episodes|Seasons)$`, "i"),
  new RegExp(`^/Videos/${ID}/(?:AdditionalParts|AlternateSources|Subtitles|Attachments)(?:/${ID})*$`, "i"),
  new RegExp(`^/Videos/${ID}/(?:stream(?:\\.[a-z0-9]+)?|master\\.m3u8|main\\.m3u8|hls(?:1)?/${ID}(?:/${ID})*/${ID}\\.[a-z0-9]+|${ID}/Subtitles/\\d+/(?:Stream\\.[a-z0-9]+|\\d+/Stream\\.[a-z0-9]+)|${ID}/Attachments/\\d+)$`, "i"),
  new RegExp(`^/Audio/${ID}/(?:stream(?:\\.[a-z0-9]+)?|universal|master\\.m3u8|main\\.m3u8|hls(?:1)?/${ID}(?:/${ID})*/${ID}\\.[a-z0-9]+)$`, "i"),
  new RegExp(`^/MediaSegments/${ID}$`, "i"),
  new RegExp(`^/DisplayPreferences/${ID}$`, "i"),
  /^\/Sessions$/i,
  /^\/SyncPlay\/(?:List|[a-f0-9-]{32,36})$/i
];
const syncActions = new Set(["join", "leave", "setnewqueue", "setplaylistitem", "removefromplaylist", "moveplaylistitem", "queue", "unpause", "pause", "stop", "seek", "buffering", "ready", "setignorewait", "nextitem", "previousitem", "setrepeatmode", "setshufflemode", "ping"]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Reject ambiguous paths before URL normalization can erase traversal evidence. */
export function canonicalNativePath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\0#?]/.test(path) || /%(?:2f|5c|2e|00|25)/i.test(path)) throw new NativeError("native_path_denied");
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new NativeError("native_path_denied"); }
  if (decoded.split("/").some((part) => part === "." || part === "..") || /[\\\0?#]/.test(decoded)) throw new NativeError("native_path_denied");
  return decoded;
}

export function allowNativeRequest(viewer: NativeViewer, method: string, inputPath: string): string {
  const path = canonicalNativePath(inputPath);
  const own = viewer.connection.jellyfinUserId.replaceAll("-", "").toLowerCase();
  const userMatch = /^\/Users\/([^/]+)(?:\/|$)/i.exec(path);
  if (userMatch && userMatch[1]?.toLowerCase() !== "me" && userMatch[1]?.replaceAll("-", "").toLowerCase() !== own) throw new NativeError("native_user_denied");
  if (method === "GET" || method === "HEAD") {
    if (new RegExp(`^/Users/(?:Me|${ID})(?:/(?:Views|Items(?:/(?:Latest|Resume|${ID}|${ID}/Intros|${ID}/LocalTrailers|${ID}/SpecialFeatures))?|GroupingOptions))?$`, "i").test(path)) return path;
    if (readRules.some((rule) => rule.test(path))) return path;
  }
  if (method === "POST") {
    const sync = /^\/SyncPlay\/([a-z]+)$/i.exec(path);
    if (sync && syncActions.has(sync[1]!.toLowerCase())) return path;
    if (new RegExp(`^/Items/${ID}/PlaybackInfo$`, "i").test(path)) return path;
    if (/^\/Sessions\/(?:Capabilities(?:\/Full)?|Playing(?:\/(?:Progress|Stopped))?)$/i.test(path)) return path;
    if (new RegExp(`^/DisplayPreferences/${ID}$`, "i").test(path)) return path;
    if (new RegExp(`^/Users/${ID}/(?:Configuration|PlayedItems/${ID}|FavoriteItems/${ID})$`, "i").test(path)) return path;
  }
  if (method === "DELETE" && (new RegExp(`^/Users/${ID}/(?:PlayedItems|FavoriteItems)/${ID}$`, "i").test(path) || /^\/Videos\/ActiveEncodings$/i.test(path))) return path;
  throw new NativeError("native_route_denied");
}

export function nativeRequestTarget(viewer: NativeViewer, path: string, query: URLSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of query) {
    const lower = key.toLowerCase();
    if (SECRET_KEYS.has(lower) || ["userid", "userids", "deviceid", "sessionid", "controllinguserid", "groupid"].includes(lower)) continue;
    if (["url", "path", "redirect", "redirecturl"].includes(lower)) throw new NativeError("native_parameter_denied");
    params.append(key, value);
  }
  params.set("UserId", viewer.connection.jellyfinUserId);
  params.set("DeviceId", viewer.deviceId);
  // Native web playback reports use their server-created PlaySessionId unchanged.
  if (/^\/Sessions(?:\/Capabilities(?:\/Full)?)?$/i.test(path)) params.set("Id", nativeSessionId(viewer));
  return `${path}?${params}`;
}

function scopedBody(viewer: NativeViewer, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((part) => scopedBody(viewer, part));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, part] of Object.entries(record(value))) {
    const lower = key.toLowerCase();
    if (SECRET_KEYS.has(lower)) continue;
    if (lower === "userid" || lower === "controllinguserid") result[key] = viewer.connection.jellyfinUserId;
    else if (lower === "userids") result[key] = [viewer.connection.jellyfinUserId];
    else if (lower === "deviceid") result[key] = viewer.deviceId;
    else if (lower === "sessionid") result[key] = nativeSessionId(viewer);
    else result[key] = scopedBody(viewer, part);
  }
  return result;
}

export function nativeRequestBody(service: NativePartyService, viewer: NativeViewer, path: string, input: unknown): unknown {
  const body = scopedBody(viewer, input);
  if (/^\/SyncPlay\/Join$/i.test(path)) return { GroupId: service.parties.get(viewer.partyId)!.groupId };
  if (/^\/SyncPlay\//i.test(path) && body && typeof body === "object") {
    // Current Jellyfin commands select their group by authenticated session. Never
    // pass client group selectors through if future upstream APIs add one.
    for (const key of Object.keys(record(body))) if (key.toLowerCase() === "groupid") delete record(body)[key];
  }
  if (/^\/Sessions\/Capabilities(?:\/Full)?$/i.test(path)) {
    return { ...record(body), SupportsMediaControl: false, SupportsRemoteControl: false, SupportsSync: true };
  }
  return body;
}

/** Every upstream URI stays below the server's configured base path. */
export function rewriteNativeUrl(viewer: NativeViewer, reference: string, relativeTo?: string): string {
  const base = new URL(viewer.connection.serverUrl.replace(/\/$/, "") + "/");
  const resolved = new URL(reference, relativeTo ?? base);
  if (resolved.origin !== base.origin || resolved.username || resolved.password || !resolved.pathname.startsWith(base.pathname)) throw new NativeError("native_media_target_denied", 502);
  const path = canonicalNativePath(`/${resolved.pathname.slice(base.pathname.length)}`);
  allowNativeRequest(viewer, "GET", path);
  const query = new URLSearchParams(resolved.search);
  for (const key of [...query.keys()]) if (SECRET_KEYS.has(key.toLowerCase())) query.delete(key);
  const search = query.toString();
  return `/jf/${viewer.capability}${path}${search ? `?${search}` : ""}`;
}

export function rewriteNativePlaylist(viewer: NativeViewer, playlist: string, upstreamUrl: string): string {
  if (!playlist.trimStart().startsWith("#EXTM3U")) throw new NativeError("native_invalid_playlist", 502);
  return playlist.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith("#")) return line.replaceAll(/URI=(?:"([^"]+)"|([^,\s]+))/g, (_match, quoted: string | undefined, unquoted: string | undefined) => `URI="${rewriteNativeUrl(viewer, quoted ?? unquoted ?? "", upstreamUrl)}"`);
    return rewriteNativeUrl(viewer, line.trim(), upstreamUrl);
  }).join("\n");
}

function rewriteApiReference(viewer: NativeViewer, reference: string): string {
  const base = viewer.connection.serverUrl.replace(/\/$/, "") + "/";
  // Jellyfin's API client concatenates its base with DTO URLs. A leading slash
  // in a native DTO is API-relative, whereas an HLS URI follows URL resolution.
  const resolved = /^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("//")
    ? reference : new URL(reference.replace(/^\//, ""), base).href;
  return rewriteNativeUrl(viewer, resolved);
}

export function sanitizeNativeJson(viewer: NativeViewer, value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((part) => sanitizeNativeJson(viewer, part));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [name, part] of Object.entries(record(value))) {
      if (SECRET_KEYS.has(name.toLowerCase())) continue;
      if (name === "CustomCss") { result[name] = ""; continue; }
      if (["InternalMetadataPath", "CachePath", "LogPath", "ProgramDataPath", "WebPath", "TranscodingTempPath", "PasswordResetProviderId", "AuthenticationProviderId"].includes(name)) continue;
      result[name] = sanitizeNativeJson(viewer, part, name);
    }
    if ("IsAdministrator" in result) result.IsAdministrator = false;
    if ("EnableRemoteAccess" in result) result.EnableRemoteAccess = false;
    if ("EnableContentDeletion" in result) result.EnableContentDeletion = false;
    // This gateway supports library playback, not Live TV. Advertising Live TV
    // makes native Home await a denied optional request before loading any rows.
    if ("EnableLiveTvAccess" in result) result.EnableLiveTvAccess = false;
    if ("EnableLiveTvManagement" in result) result.EnableLiveTvManagement = false;
    return result;
  }
  if (typeof value !== "string") return value;
  const text = value.replaceAll(viewer.connection.accessToken, viewer.capability);
  if (["TranscodingUrl", "DirectStreamUrl", "DeliveryUrl"].includes(key) && text) return rewriteApiReference(viewer, text).slice(`/jf/${viewer.capability}/`.length);
  if (key === "StreamUrl" && text) return rewriteApiReference(viewer, text);
  if (["ServerAddress", "LocalAddress", "WanAddress"].includes(key)) return `/jf/${viewer.capability}`;
  if (key === "Path") return ""; // Physical media paths are not browser credentials or useful UI data.
  if (text.startsWith(viewer.connection.serverUrl)) {
    try { return rewriteNativeUrl(viewer, text); } catch { return ""; }
  }
  return text;
}

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const stream = Readable.fromWeb(response.body as unknown as NodeReadableStream, { signal });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const part of stream) {
      const buffer = Buffer.from(part as Uint8Array);
      bytes += buffer.length;
      if (bytes > limit) throw new NativeError("native_response_too_large", 502);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { stream.destroy(); }
}

export async function proxyNativeRequest(service: NativePartyService, viewer: NativeViewer, request: FastifyRequest, reply: FastifyReply, path: string, query: URLSearchParams): Promise<FastifyReply> {
  allowNativeRequest(viewer, request.method, path);
  const itemMatch = /^\/(?:Items|Videos|Audio|MediaSegments|Persons|Artists|Studios|Genres|MusicGenres)\/([a-f0-9-]{32,36})(?:\/|$)/i.exec(path)
    ?? /^\/Users\/[^/]+\/(?:Items|PlayedItems|FavoriteItems)\/([a-f0-9-]{32,36})(?:\/|$)/i.exec(path);
  if (itemMatch) {
    const bodySource = Object.entries(record(request.body)).find(([key]) => key.toLowerCase() === "mediasourceid")?.[1];
    const source = [...query].find(([key]) => key.toLowerCase() === "mediasourceid")?.[1] ?? (typeof bodySource === "string" ? bodySource : undefined);
    await service.requireItem(viewer, itemMatch[1]!, source);
  }
  if (request.method === "POST" && /^\/Sessions\/Playing(?:\/(?:Progress|Stopped))?$/i.test(path)) {
    const itemId = Object.entries(record(request.body)).find(([key]) => key.toLowerCase() === "itemid")?.[1];
    if (typeof itemId === "string" && itemId) await service.requireItem(viewer, itemId);
  }
  await service.authorize(viewer.capability);
  if (/^\/SyncPlay\/Join$/i.test(path)) {
    if (!viewer.sockets) throw new NativeError("native_socket_required", 409);
    await service.requireViewerItems(viewer, service.parties.get(viewer.partyId)?.queueItemIds ?? []);
    await service.authorize(viewer.capability);
    if (!viewer.sockets) throw new NativeError("native_socket_required", 409);
    // Jellyfin 10.11 incorrectly increments its user counter on repeated joins.
    if (viewer.joined) return reply.code(204).send();
  }
  if (request.method === "POST" && /^\/SyncPlay\/(?:SetNewQueue|Queue)$/i.test(path)) {
    const value = record(request.body);
    const ids = value.PlayingQueue ?? value.ItemIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new NativeError("native_invalid_queue", 400);
    await service.requirePartyItems(viewer, ids as string[]);
    await service.authorize(viewer.capability);
  }
  const party = service.parties.get(viewer.partyId)!;
  if (/^\/SyncPlay\/(?:List|[a-f0-9-]{32,36})$/i.test(path)) {
    if (!path.toLowerCase().endsWith("/list") && path.split("/").pop() !== party.groupId) throw new NativeError("native_group_denied");
    const data = await service.execute(viewer, "GET", `/SyncPlay/${party.groupId}`);
    return sendNativeText(reply.type("application/json"), path.toLowerCase().endsWith("/list") ? [sanitizeNativeJson(viewer, data)] : sanitizeNativeJson(viewer, data));
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  viewer.aborters.add(abort);
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  const timeout = setTimeout(abort, 30_000);
  timeout.unref();
  const membership = setInterval(() => { void service.authorize(viewer.capability).catch(abort); }, 5_000);
  membership.unref();
  const dispose = () => {
    clearTimeout(timeout); clearInterval(membership); viewer.aborters.delete(abort);
    request.raw.off("aborted", abort); reply.raw.off("close", abort); abort();
  };
  try {
    const target = nativeRequestTarget(viewer, path, query);
    const headers: Record<string, string> = { Authorization: nativeAuthorization(viewer) };
    if (typeof request.headers.range === "string") headers.Range = request.headers.range;
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : nativeRequestBody(service, viewer, path, request.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await service.dependencies.fetch(viewer.connection.target, target, {
      method: request.method, headers, signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    clearTimeout(timeout);
    if (!response.ok) {
      await response.body?.cancel();
      if (isNativeQueuePath(path)) {
        request.log.warn({ code: "jellyfin_request_failed", upstreamStatus: response.status, ...nativeQueueShape(request) }, "Native queue request rejected by Jellyfin");
      }
      if (response.status === 401) await service.revoke(viewer);
      if (response.status === 403 && /^\/SyncPlay\/Join$/i.test(path)) throw new NativeError("syncplay_join_not_allowed", 403);
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
      if (response.status === 416 && response.headers.get("content-range")) reply.header("Content-Range", response.headers.get("content-range"));
      dispose();
      return reply.code(status).send({ error: { code: "jellyfin_request_failed", message: "Jellyfin could not complete this request." } });
    }
    if (/^\/SyncPlay\/Join$/i.test(path)) viewer.joined = true;
    if (/^\/SyncPlay\/Leave$/i.test(path)) viewer.joined = false;
    reply.code(response.status).header("Cache-Control", "no-store");
    if (request.method === "HEAD" || response.status === 204) { await response.body?.cancel(); dispose(); return reply.send(); }
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (contentType.includes("json")) {
      const text = await readBounded(response, MAX_JSON, controller.signal);
      let value: unknown;
      try { value = text ? JSON.parse(text) : null; } catch { throw new NativeError("native_invalid_json", 502); }
      if (/^\/Sessions$/i.test(path)) value = Array.isArray(value) ? value.filter((s) => record(s).Id === nativeSessionId(viewer)) : [];
      const safe = sanitizeNativeJson(viewer, value);
      dispose();
      return sendNativeText(reply.type("application/json"), safe);
    }
    if (contentType.toLowerCase().includes("mpegurl") || path.endsWith(".m3u8")) {
      const text = await readBounded(response, MAX_PLAYLIST, controller.signal);
      const upstreamUrl = new URL(viewer.connection.serverUrl.replace(/\/$/, "") + target).href;
      const rewritten = rewriteNativePlaylist(viewer, text, upstreamUrl);
      dispose();
      return sendNativeText(reply.type("application/vnd.apple.mpegurl"), rewritten);
    }
    if (/(?:html|xml|svg|javascript|ecmascript)/i.test(contentType)) throw new NativeError("native_content_denied", 502);
    for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = response.headers.get(header); if (value) reply.header(header, value);
    }
    if (!response.body) { dispose(); return reply.send(); }
    const source = Readable.fromWeb(response.body as unknown as NodeReadableStream, { signal: controller.signal });
    const stream = Readable.from((async function* () {
      try { for await (const chunk of source) { if (!service.active(viewer)) break; yield chunk as Buffer; } }
      catch { throw new NativeError("native_stream_interrupted", 502); }
      finally { source.destroy(); dispose(); }
    })());
    stream.once("close", () => { source.destroy(); dispose(); });
    return reply.send(stream);
  } catch (error) {
    dispose();
    if (error instanceof NativeError) throw error;
    throw new NativeError("jellyfin_unavailable", 502);
  }
}

export type PreparedNativeSocket = { socket: WebSocket; pending: Array<{ raw: RawData; binary: boolean }>; capture: (raw: RawData, binary: boolean) => void };

/** Establish native session before the browser's open event can send SyncPlay/Join. */
export async function prepareNativeSocket(viewer: NativeViewer, signal?: AbortSignal): Promise<PreparedNativeSocket> {
  const base = new URL(viewer.connection.serverUrl.replace(/\/$/, "") + "/socket");
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const upstream = new WebSocket(base, {
    ...upstreamWebSocketOptions(viewer.connection.target), headers: { Authorization: nativeAuthorization(viewer) },
    followRedirects: false, handshakeTimeout: 15_000, maxPayload: MAX_JSON
  });
  const abort = () => upstream.terminate();
  viewer.aborters.add(abort);
  signal?.addEventListener("abort", abort, { once: true });
  upstream.once("close", () => { viewer.aborters.delete(abort); signal?.removeEventListener("abort", abort); });
  const pending: PreparedNativeSocket["pending"] = [];
  const capture = (raw: RawData, binary: boolean) => {
    if (pending.length < 8 && raw.toString().length <= MAX_JSON) pending.push({ raw, binary });
    else upstream.terminate();
  };
  upstream.on("message", capture);
  // Keep an error listener installed across the await/upgrade boundary.
  upstream.on("error", () => { /* Errors become a generic upstream response or bridge closure. */ });
  await new Promise<void>((resolve, reject) => {
    upstream.once("open", resolve);
    upstream.once("error", () => reject(new NativeError("native_socket_unavailable", 502)));
    upstream.once("close", () => reject(new NativeError("native_socket_unavailable", 502)));
  });
  if (signal?.aborted || viewer.revoked) { upstream.terminate(); throw new NativeError("native_session_expired", 401); }
  return { socket: upstream, pending, capture };
}

/** Upgrade authentication occurs in the route preValidation, before this bridge exists. */
export function bridgeNativeSocket(service: NativePartyService, viewer: NativeViewer, socket: WebSocket, prepared: PreparedNativeSocket): void {
  const upstream = prepared.socket;
  viewer.sockets += 1;
  viewer.lastSocketClose = 0;
  let ended = false;
  let alive = true;
  const pending: string[] = [];
  const stop = () => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    viewer.aborters.delete(stop);
    upstream.terminate(); socket.terminate();
    void service.socketDisconnected(viewer);
  };
  viewer.aborters.add(stop);
  socket.on("pong", () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive || !service.active(viewer)) { stop(); return; }
    alive = false; socket.ping();
    void service.authorize(viewer.capability).catch(stop);
  }, 15_000);
  heartbeat.unref();
  const forward = (raw: RawData, binary: boolean) => {
    if (binary || raw.toString().length > 16_384) { stop(); return; }
    let message: unknown;
    try { message = JSON.parse(raw.toString()); } catch { stop(); return; }
    // Never subscribe to other sessions, scheduled tasks or administrative events.
    if (!["KeepAlive", "Ping"].includes(String(record(message).MessageType))) return;
    const text = JSON.stringify(message);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else if (pending.length < 8) pending.push(text);
    else stop();
  };
  socket.on("message", forward);
  socket.on("close", stop); socket.on("error", stop);
  upstream.on("error", stop); upstream.on("close", stop);
  upstream.on("open", () => { for (const text of pending) upstream.send(text); pending.length = 0; });
  const upstreamMessage = (raw: RawData, binary: boolean) => {
    if (ended || binary || socket.readyState !== WebSocket.OPEN) return;
    try {
      const message: unknown = JSON.parse(raw.toString());
      if (!service.observeMessage(viewer, message)) return;
      if (socket.bufferedAmount > MAX_SOCKET_BUFFER) { stop(); return; }
      socket.send(JSON.stringify(sanitizeNativeJson(viewer, message)));
    } catch { stop(); }
  };
  upstream.off("message", prepared.capture);
  upstream.on("message", upstreamMessage);
  for (const { raw, binary } of prepared.pending) upstreamMessage(raw, binary);
  prepared.pending.length = 0;
  if (upstream.readyState !== WebSocket.OPEN) stop();
}
