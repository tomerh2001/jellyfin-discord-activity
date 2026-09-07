import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { createAppSession } from "../services/appSession.js";
import { encryptString } from "../services/crypto.js";
import { sessionStore } from "../services/sessionStore.js";
import { proxyDirectStream } from "../services/streamProxy.js";
import { streamTicketStore } from "../services/tickets.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const serverUrl = "https://jellyfin.example.com";

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  streamTicketStore.clear();
});

async function setup(direct = false) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "djf-media-security-"));
  const env = loadEnv({
    NODE_ENV: "test", DEV_AUTH_MOCK: "true",
    APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    DATABASE_URL: `file:${path.join(dataDir, "app.db")}`,
    JELLYFIN_DEFAULT_SERVER_URL: serverUrl
  });
  const app = await buildApp(env);
  apps.push(app);
  const { session } = await createAppSession({ env, user: { id: "test-watcher", username: "Watcher", avatar: null } });
  const createTicket = () => streamTicketStore.create({
    appSessionId: session.id,
    serverUrl, jellyfinUserId: "jellyfin-user",
    encryptedAccessToken: encryptString(env, "secret-server-token"),
    itemId: "movie-1", mediaSourceId: "media-1", sessionExpiresAt: session.expiresAt,
    ...(direct ? { directPath: "/Videos/movie-1/stream.mp4?Static=true&MediaSourceId=media-1" } : { hlsPath: "/Videos/movie-1/master.m3u8?MediaSourceId=media-1" })
  }, 300);
  const { token, ticket } = createTicket();
  const streamUrl = direct ? `/media/direct/${token}/stream.mp4` : `/media/hls/${token}/master.m3u8`;
  return { app, env, session, token, ticket, streamUrl, createTicket };
}

function manifest(body: string) {
  return new Response(body, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
}

function issuedUrls(body: string): string[] {
  return body.match(/\/media\/hls\/[^\s"]+/g) ?? [];
}

describe("media authorization boundary", () => {

  it("rechecks Discord membership during media-only streaming and revokes a departed participant", async () => {
    const { env, session, ticket } = await setup(true);
    session.discordContext = { instanceId: "instance", guildId: "guild", channelId: "channel" };
    env.DEV_AUTH_MOCK = false;
    env.DISCORD_BOT_TOKEN = "test-bot-token";
    vi.useFakeTimers();
    const cancelled = vi.fn();
    let mediaController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const upstream = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith("https://discord.com/")) {
        return new Response(JSON.stringify({ application_id: env.DISCORD_CLIENT_ID, instance_id: "instance", location: { guild_id: "guild", channel_id: "channel" }, users: [] }), { headers: { "content-type": "application/json" } });
      }
      return new Response(new ReadableStream({
        start(controller) { mediaController = controller; controller.enqueue(new Uint8Array([1, 2, 3])); },
        cancel: cancelled
      }), { headers: { "content-type": "video/mp4" } });
    });
    vi.stubGlobal("fetch", upstream);
    let stream: Readable | undefined;
    const request = { raw: new EventEmitter(), headers: {} } as unknown as FastifyRequest;
    const reply = { raw: new EventEmitter(), code() { return this; }, header() { return this; }, send(value: Readable) { stream = value; return this; } } as unknown as FastifyReply;
    await proxyDirectStream(env, ticket, request, reply);
    const iterator = stream![Symbol.asyncIterator]();
    await iterator.next();
    await vi.advanceTimersByTimeAsync(30_000);
    mediaController!.enqueue(new Uint8Array([4]));
    await iterator.next();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(upstream).toHaveBeenCalledOnce();
    const finished = expect(iterator.next()).rejects.toMatchObject({ code: "upstream_stream_failed" });
    await vi.advanceTimersByTimeAsync(1000);
    await finished;
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(sessionStore.getSession(session.id)).toBeUndefined();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each(["logout", "disconnect", "idle timeout", "session expiry"])("cancels an already streaming body on %s", async (reason) => {
    const { env, session, ticket } = await setup(true);
    vi.useFakeTimers();
    if (reason === "session expiry") ticket.sessionExpiresAt = new Date(Date.now() + 2000);
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      cancel: cancelled
    }), { headers: { "content-type": "video/mp4" } })));
    let stream: Readable | undefined;
    const request = { raw: new EventEmitter(), headers: {} } as unknown as FastifyRequest;
    const reply = {
      raw: new EventEmitter(),
      code() { return this; },
      header() { return this; },
      send(value: Readable) { stream = value; return this; }
    } as unknown as FastifyReply;
    await proxyDirectStream(env, ticket, request, reply);
    const iterator = stream![Symbol.asyncIterator]();
    expect(Array.from((await iterator.next()).value as Uint8Array)).toEqual([1, 2, 3]);
    const finished = expect(iterator.next()).rejects.toMatchObject({ code: "upstream_stream_failed" });
    if (reason === "logout") sessionStore.deleteSession(session.id);
    else if (reason === "disconnect") request.raw.emit("aborted");
    else await vi.advanceTimersByTimeAsync(reason === "session expiry" ? 2001 : 60_001);
    await finished;
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("rejects same-origin APIs, other titles, changed queries and external targets before making an upstream request", async () => {
    const { app, token } = await setup();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    for (const target of ["/Users", "/System/Info", "/Videos/movie-2/stream.mp4", "/Videos/movie-1/hls/main/0.ts?MediaSourceId=other", "https://attacker.example/collect"]) {
      const response = await app.inject({ url: `/media/hls/${token}/asset?u=${encodeURIComponent(target)}` });
      expect(response.statusCode).toBe(400);
    }
    const unissued = await app.inject({ url: `/media/hls/${token}/asset?a=unissued` });
    expect(unissued.statusCode).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("supports nested manifests, initialization maps, encryption keys and ranged segments without exposing URLs or tokens", async () => {
    const { app, streamUrl, token, createTicket } = await setup();
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toContain('Token="secret-server-token"');
      expect(url.searchParams.has("API_KEY")).toBe(false);
      expect(url.searchParams.has("ApiKey")).toBe(false);
      expect(url.searchParams.has("token")).toBe(false);
      if (url.pathname.endsWith("master.m3u8")) return manifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmain.m3u8?MediaSourceId=media-1&ApiKey=secret-key\n');
      if (url.pathname.endsWith("main.m3u8")) return manifest('#EXTM3U\n#EXT-X-MAP:URI="hls/init.mp4?API_KEY=secret-key"\n#EXT-X-KEY:METHOD=AES-128,URI="hls/key?token=secret-key"\n#EXTINF:3,\nhls/0.mp4?MediaSourceId=media-1&index=0\n');
      if (url.pathname.endsWith("0.mp4")) {
        expect(url.searchParams.get("index")).toBe("0");
        expect(new Headers(init?.headers).get("range")).toBe("bytes=0-3");
        return new Response("data", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-3/8", "accept-ranges": "bytes", "cache-control": "public, max-age=600" } });
      }
      return new Response("asset");
    });
    vi.stubGlobal("fetch", upstream);
    const master = await app.inject({ url: streamUrl });
    expect(master.statusCode).toBe(200);
    const variant = await app.inject({ url: issuedUrls(master.body)[0]! });
    expect(variant.statusCode).toBe(200);
    expect(master.body + variant.body).not.toMatch(/secret|jellyfin\.example|MediaSourceId|index=/);
    const assets = issuedUrls(variant.body);
    expect(assets).toHaveLength(3);
    for (const url of assets.slice(0, 2)) expect((await app.inject({ url })).body).toBe("asset");
    const segment = await app.inject({ url: assets[2]!, headers: { range: "bytes=0-3" } });
    expect(segment.statusCode).toBe(206);
    expect(segment.body).toBe("data");
    expect(segment.headers["content-range"]).toBe("bytes 0-3/8");
    expect(segment.headers["cache-control"]).toBe("no-store");
    const fetchCount = upstream.mock.calls.length;
    expect((await app.inject({ url: `${assets[2]}&index=1` })).statusCode).toBe(400);
    expect((await app.inject({ url: `${assets[2]}&u=%2FUsers` })).statusCode).toBe(400);
    const other = createTicket();
    expect((await app.inject({ url: assets[2]!.replace(token, other.token) })).statusCode).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(fetchCount);
  });

  it.each(["https://attacker.example/collect?ApiKey=secret", "//attacker.example/collect", "https://user:password@jellyfin.example.com/key"])("rejects external or credential-bearing manifest references: %s", async (reference) => {
    const { app, streamUrl } = await setup();
    const upstream = vi.fn(async () => manifest(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${reference}"\n`));
    vi.stubGlobal("fetch", upstream);
    const response = await app.inject({ url: streamUrl });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("attacker.example");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects upstream redirects without forwarding Location or the response body", async () => {
    const { app, streamUrl } = await setup(true);
    const upstream = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response("secret-server-token", { status: 302, headers: { Location: "https://attacker.example/?api_key=secret-server-token" } });
    });
    vi.stubGlobal("fetch", upstream);
    const response = await app.inject({ url: streamUrl });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("upstream_redirect_rejected");
    expect(response.headers.location).toBeUndefined();
    expect(response.body).not.toContain("secret-server-token");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("suppresses upstream error bodies while preserving range errors", async () => {
    const { app, streamUrl } = await setup(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("https://jellyfin.example.com/?ApiKey=secret-server-token", { status: 416, headers: { "content-range": "bytes */8" } })));
    const response = await app.inject({ url: streamUrl, headers: { range: "bytes=12-20" } });
    expect(response.statusCode).toBe(416);
    expect(response.headers["content-range"]).toBe("bytes */8");
    expect(response.body).not.toContain("secret-server-token");
  });

  it("revokes every ticket from a logged out app session", async () => {
    const { app, session, streamUrl, createTicket } = await setup();
    const another = createTicket();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    sessionStore.deleteSession(session.id);
    expect((await app.inject({ url: streamUrl })).statusCode).toBe(403);
    expect(streamTicketStore.get(another.token)).toBeUndefined();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not revive expired tickets or session-expired tickets when used", async () => {
    const { app, session, ticket, streamUrl } = await setup();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    ticket.expiresAt = new Date(Date.now() - 1);
    expect((await app.inject({ url: streamUrl })).statusCode).toBe(403);
    const second = await setup(true);
    sessionStore.getSession(second.session.id)!.expiresAt = new Date(Date.now() - 1);
    expect((await second.app.inject({ url: second.streamUrl })).statusCode).toBe(403);
    sessionStore.deleteSession(session.id);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("aborts an in-flight upstream media request immediately when its app session is revoked", async () => {
    const { app, session, streamUrl } = await setup();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      started();
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("secret upstream url")), { once: true }));
    }));
    const request = app.inject({ url: streamUrl });
    const responsePromise = Promise.resolve(request);
    await pending;
    sessionStore.deleteSession(session.id);
    const response = await responsePromise;
    expect(signal?.aborted).toBe(true);
    expect(response.body).not.toContain("secret upstream url");
    expect(response.statusCode).toBe(400);
  });

  it("bounds upstream header waits and cancels the request on timeout", async () => {
    const { app, streamUrl } = await setup();
    await app.ready();
    vi.useFakeTimers();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      started();
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("timed out")), { once: true }));
    }));
    const responsePromise = Promise.resolve(app.inject({ url: streamUrl }));
    await pending;
    await vi.advanceTimersByTimeAsync(30_001);
    const response = await responsePromise;
    expect(signal?.aborted).toBe(true);
    expect(response.statusCode).toBe(400);
  });
});
