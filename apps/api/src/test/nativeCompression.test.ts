import { randomUUID } from "node:crypto";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env.js";
import { websocketPlugin } from "../plugins/websocket.js";
import { nativeJellyfinRoutes } from "../routes/nativeJellyfin.js";
import { nativePartyRoutes } from "../routes/nativeParty.js";
import { createAppSession } from "../services/appSession.js";
import { getNativePartyService, type NativePartyService } from "../services/nativeParty.js";
import { sessionStore } from "../services/sessionStore.js";
import { validateUpstream } from "../services/upstreamPolicy.js";

const USER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ITEM = "11111111111111111111111111111111";
const GROUP = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "fixture-upstream-secret-never-browser";
const library = { Items: Array.from({ length: 500 }, (_, i) => ({
  Id: i.toString(16).padStart(32, "0"), Name: `Library title ${i}`, Type: "Movie",
  Overview: `A fictional item ${i} with a synopsis, cast, genre and production information. `.repeat(5),
  UserData: { Played: i % 3 === 0, PlaybackPositionTicks: i * 10_000_000 },
  MediaSources: [{ Id: ITEM, Path: "/private/library/movie.mkv", TranscodingUrl: `Videos/${ITEM}/master.m3u8?api_key=${TOKEN}` }],
  AccessToken: TOKEN
})), TotalRecordCount: 500 };
const playlist = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n" + Array.from({ length: 2200 }, (_, i) =>
  `#EXTINF:3,\nhls1/main/${i}.ts?NativeProfile=${"codec-profile-and-channel-layout-".repeat(35)}&api_key=${TOKEN}\n`
).join("") + "#EXT-X-ENDLIST\n";
let app: FastifyInstance;
let service: NativePartyService;
let baseUrl: string;
let sessionId: string;
let upstreamStatus: number;
let upstreamCalls: number;

function decoded(response: { headers: Record<string, unknown>; rawPayload: Buffer }): string {
  return response.headers["content-encoding"] === "br" ? brotliDecompressSync(response.rawPayload).toString()
    : response.headers["content-encoding"] === "gzip" ? gunzipSync(response.rawPayload).toString() : response.rawPayload.toString();
}

beforeEach(async () => {
  upstreamStatus = 200; upstreamCalls = 0;
  const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", JELLYFIN_DEFAULT_SERVER_URL: "http://127.0.0.1:8096", DATABASE_URL: `file:/tmp/unused-compression-${randomUUID()}.db` });
  app = Fastify({ logger: false }); app.decorate("envConfig", env); app.decorateRequest("appSession");
  service = getNativePartyService(app);
  const target = await validateUpstream(env, env.JELLYFIN_DEFAULT_SERVER_URL!);
  service.dependencies.resolve = vi.fn(async (_env, _user, id) => ({ id, serverId: "fixture-server", serverUrl: env.JELLYFIN_DEFAULT_SERVER_URL!,
    serverName: "Fixture", jellyfinUserId: USER, jellyfinUsername: "fixture", kind: "personal" as const,
    createdAt: "2026-01-01", updatedAt: "2026-01-01", accessToken: TOKEN, target }));
  service.dependencies.current = vi.fn();
  service.dependencies.fetch = vi.fn(async (_target, path, init) => {
    upstreamCalls++;
    const pathname = new URL(path, "http://fixture").pathname;
    if (pathname === "/SyncPlay/New") return Response.json({ GroupId: GROUP });
    if (pathname.startsWith("/SyncPlay/")) return new Response(null, { status: 204 });
    if (pathname === `/Users/${USER}/Items/${ITEM}`) return Response.json({ Id: ITEM, MediaSources: [{ Id: ITEM }] });
    if (upstreamStatus !== 200) return new Response(upstreamStatus === 204 ? null : "private upstream error", { status: upstreamStatus });
    if (pathname.endsWith(".m3u8")) return new Response(playlist, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    if (pathname.endsWith(".mp4")) {
      const range = new Headers(init?.headers).has("range");
      return new Response(Buffer.alloc(4096, 7), { status: range ? 206 : 200, headers: {
        "Content-Type": "video/mp4", "Content-Length": "4096", "Accept-Ranges": "bytes", ...(range ? { "Content-Range": "bytes 0-4095/8192" } : {})
      } });
    }
    return Response.json(pathname === `/Users/${USER}` ? { Id: USER, AccessToken: TOKEN } : library);
  });
  await app.register(websocketPlugin);
  await app.register(nativePartyRoutes);
  await app.register(nativeJellyfinRoutes);
  // This sibling represents broker credentials, deliberately outside compression.
  app.get("/broker-fixture", () => ({ accessToken: "x".repeat(2048) }));
  await app.ready();
  const actor = await createAppSession({ env, user: { id: "compression-viewer", username: "Fixture" }, discordContext: { instanceId: randomUUID(), guildId: "fixture-guild", channelId: "fixture-channel" } });
  sessionId = actor.session.id;
  await service.bind(actor.session, "fixture-connection");
  baseUrl = (await service.launch(actor.session, "fixture-connection", randomUUID())).baseUrl;
});

afterEach(async () => { await app?.close(); if (sessionId) sessionStore.deleteSession(sessionId); vi.restoreAllMocks(); });

describe("scoped native response compression", () => {
  it.each(["br", "gzip"])("compresses sanitized library JSON and rewritten long VOD playlists with %s", async (encoding) => {
    for (const path of [`/Users/${USER}/Items`, `/Videos/${ITEM}/main.m3u8`]) {
      const plain = await app.inject({ url: baseUrl + path });
      const compressed = await app.inject({ url: baseUrl + path, headers: { "accept-encoding": encoding } });
      expect(compressed.statusCode).toBe(200);
      expect(compressed.headers["content-encoding"]).toBe(encoding);
      expect(compressed.headers.vary).toContain("accept-encoding");
      expect(compressed.headers["cache-control"]).toBe("no-store");
      expect(compressed.headers["content-length"]).toBeUndefined();
      const body = decoded(compressed);
      expect(body === plain.body).toBe(true);
      expect(body.includes(TOKEN)).toBe(false);
      expect(body.includes("/private/library")).toBe(false);
      expect(body.includes(path.endsWith(".m3u8") ? baseUrl + "/Videos/" : `Videos/${ITEM}/master.m3u8`)).toBe(true);
      expect(compressed.rawPayload.length).toBeLessThan(plain.rawPayload.length / 5);
    }
  });

  it("honors encoding negotiation and leaves small native JSON and broker credentials unchanged", async () => {
    for (const [accept, encoding] of [["br;q=0,gzip;q=1", "gzip"], ["br;q=0.5,gzip;q=0.2", "br"], ["identity", undefined], ["unsupported", undefined]] as const) {
      const response = await app.inject({ url: `${baseUrl}/Users/${USER}/Items`, headers: { "accept-encoding": accept } });
      expect(response.statusCode).toBe(200); expect(response.headers["content-encoding"]).toBe(encoding);
      expect(JSON.parse(decoded(response)).Items).toHaveLength(500);
    }
    const small = await app.inject({ url: `${baseUrl}/Users/${USER}`, headers: { "accept-encoding": "br,gzip" } });
    expect(small.headers["content-encoding"]).toBeUndefined(); expect(small.json()).toEqual({ Id: USER });
    const broker = await app.inject({ url: "/broker-fixture", headers: { "accept-encoding": "br,gzip" } });
    expect(broker.headers["content-encoding"]).toBeUndefined(); expect(broker.json().accessToken).toHaveLength(2048);
  });

  it("preserves HEAD, Range, binary media, empty and upstream error responses", async () => {
    const head = await app.inject({ method: "HEAD", url: `${baseUrl}/Users/${USER}/Items`, headers: { "accept-encoding": "br" } });
    expect(head.statusCode).toBe(200); expect(head.body).toBe(""); expect(head.headers["content-encoding"]).toBeUndefined();
    const rangedJson = await app.inject({ url: `${baseUrl}/Users/${USER}/Items`, headers: { range: "bytes=0-4095", "accept-encoding": "br" } });
    expect(rangedJson.headers["content-encoding"]).toBeUndefined();
    for (const range of [undefined, "bytes=0-4095"]) {
      const response = await app.inject({ url: `${baseUrl}/Videos/${ITEM}/stream.mp4`, headers: { "accept-encoding": "br", ...(range ? { range } : {}) } });
      expect(response.statusCode).toBe(range ? 206 : 200); expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers["content-length"]).toBe("4096"); expect(response.headers["accept-ranges"]).toBe("bytes");
      expect(response.headers["content-range"]).toBe(range ? "bytes 0-4095/8192" : undefined);
      expect(response.rawPayload).toEqual(Buffer.alloc(4096, 7)); expect(response.headers["cache-control"]).toBe("no-store");
    }
    for (const status of [204, 403, 500]) {
      upstreamStatus = status;
      const response = await app.inject({ url: `${baseUrl}/Users/${USER}/Items`, headers: { "accept-encoding": "br" } });
      expect(response.statusCode).toBe(status); expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store"); expect(response.body).not.toContain("private upstream error");
    }
  });

  it("does not decompress incoming bodies or bypass capability validation", async () => {
    const before = upstreamCalls;
    const denied = await app.inject({ url: "/jf/invalid/Users/Me", headers: { "accept-encoding": "br" } });
    expect(denied.statusCode).toBe(401); expect(denied.headers["content-encoding"]).toBeUndefined();
    const zipped = await app.inject({ method: "POST", url: `${baseUrl}/SyncPlay/SetNewQueue`,
      headers: { "content-encoding": "gzip", "content-type": "application/json" }, payload: gzipSync(JSON.stringify({ PlayingQueue: [ITEM] })) });
    expect(zipped.statusCode).toBe(400); expect(upstreamCalls).toBe(before);
  });

  it("serves compressed native text that fetch transparently decodes over a real socket", async () => {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const path of [`/Users/${USER}/Items`, `/Videos/${ITEM}/main.m3u8`]) {
      const response = await fetch(address + baseUrl + path, { headers: { "accept-encoding": "br" } });
      expect(response.status).toBe(200); expect(response.headers.get("content-encoding")).toBe("br");
      expect(await response.text() === (await app.inject({ url: baseUrl + path })).body).toBe(true);
    }
  });
});
