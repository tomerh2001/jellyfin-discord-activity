import { once } from "node:events";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env.js";
import { websocketPlugin } from "../plugins/websocket.js";
import { nativePartyRoutes } from "../routes/nativeParty.js";
import { nativeJellyfinRoutes } from "../routes/nativeJellyfin.js";
import { discordAuthRoutes } from "../routes/discordAuth.js";
import { createAppSession } from "../services/appSession.js";
import { sessionStore, type AppSession } from "../services/sessionStore.js";
import { getNativePartyService, nativeSessionId, type NativePartyService, type NativeViewer } from "../services/nativeParty.js";
import { allowNativeRequest, rewriteNativePlaylist, sanitizeNativeJson } from "../services/nativeGateway.js";
import { validateUpstream } from "../services/upstreamPolicy.js";

const ITEM = "11111111111111111111111111111111";
const DENIED = "22222222222222222222222222222222";
const USER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GROUP = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PLAYLIST_ITEM = "cccccccccccccccccccccccccccccccc";
const TOKEN = "test-upstream-token-never-browser";
type Call = { method: string; path: string; query: Record<string, string>; body: unknown; authorization: string };
let app: FastifyInstance;
let upstream: FastifyInstance;
let service: NativePartyService;
let appAddress: string;
let upstreamAddress: string;
let sessions: AppSession[];
let calls: Call[];
let upstreamSockets: Map<string, WebSocket>;
let deniedForUser: Set<string>;
let failItemStatus: number;
let slowTransferClosed: boolean;
let imageContentType: string;
let socketAcceptDelay: number;
let episodeMode: boolean;
let denyGroupCreation: boolean;
let largePlaylist: boolean;

function device(authorization: string): string { return /DeviceId="([^"]+)"/.exec(authorization)?.[1] ?? ""; }
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  expect(check()).toBe(true);
}

beforeEach(async () => {
  sessions = []; calls = []; upstreamSockets = new Map(); deniedForUser = new Set(); failItemStatus = 404; slowTransferClosed = false; imageContentType = "image/png"; socketAcceptDelay = 0; episodeMode = false; denyGroupCreation = false; largePlaylist = false;
  upstream = Fastify({ logger: false });
  await upstream.register(websocketPlugin);
  upstream.addHook("preValidation", async (request) => {
    if (request.url === "/socket" && socketAcceptDelay) await new Promise((resolve) => setTimeout(resolve, socketAcceptDelay));
  });
  upstream.get("/socket", { websocket: true }, (socket, request) => {
    const id = device(request.headers.authorization ?? "");
    upstreamSockets.set(id, socket);
    socket.on("close", () => { if (upstreamSockets.get(id) === socket) upstreamSockets.delete(id); });
    socket.send(JSON.stringify({ MessageType: "ForceKeepAlive", Data: 30 }));
  });
  upstream.route({ method: ["GET", "HEAD", "POST", "DELETE"], url: "/*", handler: async (request, reply) => {
    const url = new URL(request.url, "http://local");
    const authorization = request.headers.authorization ?? "";
    calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: request.body, authorization });
    if (url.pathname === "/SyncPlay/New") return denyGroupCreation ? reply.code(403).send({ secret: TOKEN }) : { GroupId: GROUP };
    if (url.pathname === `/SyncPlay/${GROUP}`) return { GroupId: GROUP, GroupName: "Discord watch party", Participants: ["shared"] };
    if (url.pathname.startsWith("/SyncPlay/")) {
      if (url.pathname.endsWith("/Join")) {
        const socket = upstreamSockets.get(device(authorization));
        socket?.send(JSON.stringify({ MessageType: "SyncPlayGroupUpdate", Data: { GroupId: GROUP, Type: "GroupJoined", Data: { GroupId: GROUP } } }));
        socket?.send(JSON.stringify({ MessageType: "SyncPlayGroupUpdate", Data: { GroupId: GROUP, Type: "PlayQueue", Data: { PlayingItemIndex: 0, Playlist: [{ ItemId: ITEM, PlaylistItemId: PLAYLIST_ITEM }] } } }));
      }
      return reply.code(204).send();
    }
    const homeItem = { Id: ITEM, Type: "Episode", UserData: { Played: false, PlaybackPositionTicks: 90_000_000 } };
    if (url.pathname === `/Users/${USER}/Items/Resume` || url.pathname === "/Shows/NextUp") return { Items: [homeItem], TotalRecordCount: 1 };
    if (url.pathname === `/Users/${USER}/Items/Latest`) return [homeItem];
    const item = /^\/Users\/([^/]+)\/Items\/([^/]+)$/.exec(url.pathname);
    if (item) {
      if (item[2] === DENIED || deniedForUser.has(item[1]!)) return reply.code(failItemStatus).send({ error: TOKEN });
      return { Id: item[2], Name: "Test movie", ...(episodeMode ? { Type: "Episode", SeriesId: GROUP } : {}), MediaSources: [{ Id: item[2], Path: "/private/media/movie.mkv" }] };
    }
    if (url.pathname === `/Shows/${GROUP}/Episodes`) return { Items: [{ Id: ITEM }, { Id: PLAYLIST_ITEM }] };
    if (url.pathname.endsWith("/PlaybackInfo")) return { AccessToken: TOKEN, MediaSources: [{ Id: ITEM, TranscodingUrl: `Videos/${ITEM}/master.m3u8?api_key=${TOKEN}`, Path: "/private/file.mkv" }] };
    if (url.pathname.endsWith("/Images/Primary")) return reply.type(imageContentType).send("<svg><script>bad()</script></svg>");
    if (largePlaylist && url.pathname.endsWith("main.m3u8")) return reply.type("application/vnd.apple.mpegurl").send(
      "#EXTM3U\n" + Array.from({ length: 2200 }, (_, i) => `#EXTINF:3,\nhls1/main/${i}.ts?NativeProfile=${"x".repeat(1100)}&api_key=${TOKEN}\n`).join("")
    );
    if (url.pathname.endsWith("master.m3u8")) return reply.type("application/vnd.apple.mpegurl").send(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="hls1/main/key.bin?api_key=${TOKEN}"\nhls1/main/0.ts?api_key=${TOKEN}\n`);
    if (url.pathname.endsWith("/stream.mp4")) {
      if (url.searchParams.get("slow") === "true") {
        reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "video/mp4" }); reply.raw.write("first");
        const interval = setInterval(() => reply.raw.write("chunk"), 20);
        reply.raw.once("close", () => { clearInterval(interval); slowTransferClosed = true; });
        return;
      }
      return reply.code(request.headers.range ? 206 : 200).header("Content-Range", "bytes 0-3/4").type("video/mp4").send(Buffer.from("data"));
    }
    if (url.pathname.endsWith("/0.ts")) return reply.type("video/mp2t").send(Buffer.from("segment"));
    if (url.pathname === "/Sessions") return [{ Id: "other-session", DeviceId: "other" }, { Id: nativeSessionId({ deviceId: device(authorization) } as NativeViewer), NowPlayingItem: { Id: ITEM, Name: "Test movie" }, PlayState: { PositionTicks: 50_000_000, IsPaused: false } }];
    if (url.pathname.startsWith("/Sessions/")) return reply.code(204).send();
    return { Id: USER, Name: "shared", Policy: { IsAdministrator: true, EnableLiveTvAccess: true, EnableLiveTvManagement: true, EnableMediaPlayback: true }, AccessToken: TOKEN, RequestedUser: url.searchParams.get("UserId") };
  } });
  upstreamAddress = await upstream.listen({ host: "127.0.0.1", port: 0 });
  const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", JELLYFIN_DEFAULT_SERVER_URL: upstreamAddress, DATABASE_URL: "file:/tmp/native-unused.db" });
  app = Fastify({ logger: false });
  app.decorate("envConfig", env); app.decorateRequest("appSession");
  service = getNativePartyService(app);
  const target = await validateUpstream(env, upstreamAddress);
  service.dependencies.resolve = vi.fn(async (_env, userId, connectionId) => ({
    id: connectionId, serverId: connectionId === "other-server" ? "other" : "server", serverUrl: upstreamAddress,
    serverName: "Test Jellyfin", jellyfinUserId: userId === "viewer-2" ? "dddddddddddddddddddddddddddddddd" : USER,
    jellyfinUsername: "shared", kind: "personal" as const, createdAt: "2026-01-01", updatedAt: "2026-01-01", accessToken: TOKEN, target
  }));
  service.dependencies.current = vi.fn();
  await app.register(websocketPlugin);
  await app.register(nativePartyRoutes);
  await app.register(nativeJellyfinRoutes);
  await app.register(discordAuthRoutes);
  appAddress = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  await app?.close();
  for (const socket of upstreamSockets?.values() ?? []) socket.terminate();
  await upstream?.close();
  for (const session of sessions) sessionStore.deleteSession(session.id);
  vi.restoreAllMocks();
});

async function actor(id = "viewer-1", instanceId = "test-instance", context = { guildId: "guild", channelId: "channel" }) {
  const created = await createAppSession({ env: app.envConfig, user: { id, username: id }, discordContext: { instanceId, ...context } });
  sessions.push(created.session);
  return { ...created, headers: { authorization: `Bearer ${created.appToken}` } };
}

async function launch(who?: Awaited<ReturnType<typeof actor>>) {
  const owner = who ?? await actor();
  const bound = await app.inject({ method: "POST", url: "/api/party", headers: owner.headers, payload: { connectionId: "connection" } });
  expect(bound.statusCode).toBe(200);
  const launched = await app.inject({ method: "POST", url: "/api/native/launch", headers: owner.headers, payload: { connectionId: "connection", deviceId: randomUUID() } });
  expect(launched.statusCode).toBe(200);
  const data = launched.json<{ baseUrl: string; accessToken: string; userId: string; serverId: string; deviceId: string; groupId: string; restoreRoute: string | null }>();
  return { owner, data, viewer: service.viewers.get(data.accessToken)! };
}

async function connect(data: Awaited<ReturnType<typeof launch>>["data"]) {
  const socket = new WebSocket(`${appAddress.replace("http:", "ws:")}${data.baseUrl}/socket?api_key=ignored-native-token`);
  await once(socket, "open");
  return socket;
}

async function disconnectRenderer(current: Awaited<ReturnType<typeof launch>>) {
  const socket = await connect(current.data);
  expect((await app.inject({ method: "POST", url: `${current.data.baseUrl}/SyncPlay/Join`, payload: { GroupId: GROUP } })).statusCode).toBe(204);
  await eventually(() => current.viewer.joined);
  expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: current.owner.headers,
    payload: { connectionId: "connection", route: `#/details?id=${ITEM}&serverId=server`, sequence: 1 } })).statusCode).toBe(200);
  socket.terminate();
  await eventually(() => current.viewer.lastSocketClose > 0);
  await current.viewer.socketCleanup;
}

describe("native Jellyfin gateway", () => {
  it("hands a disconnected solo native group to a newly verified instance without rebuilding its queue", async () => {
    const previous = await launch();
    await disconnectRenderer(previous);
    const replacement = await launch(await actor("viewer-1", "popped-out-instance"));
    expect(replacement.viewer.partyId).toBe(previous.viewer.partyId);
    expect(replacement.data.restoreRoute).toBe(`#/details?id=${ITEM}&serverId=server`);
    expect(service.get(replacement.owner.session)?.context.instanceId).toBe("popped-out-instance");
    expect(service.get(previous.owner.session)).toBeUndefined();
    expect(service.parties.get(replacement.viewer.partyId)?.queueItemIds).toEqual([ITEM]);
    expect(calls.filter(call => call.path === "/SyncPlay/New")).toHaveLength(1);
    expect(calls.filter(call => ["/SyncPlay/SetNewQueue", "/SyncPlay/Stop", "/SyncPlay/Unpause"].includes(call.path))).toHaveLength(0);
    expect((await app.inject({ url: `${previous.data.baseUrl}/Users/Me` })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: previous.owner.headers,
      payload: { connectionId: "connection", route: "#/home", sequence: 100 } })).statusCode).toBe(409);
    expect((await app.inject({ url: "/api/native/restore?connectionId=connection", headers: replacement.owner.headers })).json().route).toBe(replacement.data.restoreRoute);
  });

  it("waits briefly for the prior renderer's natural socket close when the replacement arrives first", async () => {
    const previous = await launch();
    const socket = await connect(previous.data);
    expect((await app.inject({ method: "POST", url: `${previous.data.baseUrl}/SyncPlay/Join`, payload: { GroupId: GROUP } })).statusCode).toBe(204);
    await eventually(() => previous.viewer.joined);
    const next = await actor("viewer-1", "popout-arrived-first");
    const binding = service.bind(next.session, "connection");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(previous.viewer.revoked).toBe(false);
    expect(previous.viewer.sockets).toBe(1);
    socket.terminate();
    expect((await binding).id).toBe(previous.viewer.partyId);
    expect(previous.viewer.revoked).toBe(true);
    expect(calls.filter(call => call.path === "/SyncPlay/New")).toHaveLength(1);
  });

  it("replaces a disconnected renderer within the same instance and ignores out-of-order route saves", async () => {
    const previous = await launch();
    await disconnectRenderer(previous);
    const replacement = await launch(await actor());
    expect(replacement.viewer.partyId).toBe(previous.viewer.partyId);
    expect(previous.viewer.revoked).toBe(true);
    expect(replacement.data.restoreRoute).toContain("#/details?");
    for (const [sequence, route] of [[2, "#/movies?collectionType=movies"], [1, "#/home"]] as const) {
      expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: replacement.owner.headers,
        payload: { connectionId: "connection", route, sequence } })).statusCode).toBe(200);
    }
    expect((await app.inject({ url: "/api/native/restore?connectionId=connection", headers: replacement.owner.headers })).json().route).toBe("#/movies?collectionType=movies");
    expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: previous.owner.headers,
      payload: { connectionId: "connection", route: "#/home", sequence: 500 } })).statusCode).toBe(409);
  });

  it.each(["another-user", "another-guild", "another-channel", "another-connection", "another-server", "expired", "opening", "active", "explicit-logout", "revoked-connection"])("does not transfer a previous group for %s", async reason => {
    const previous = await launch();
    await disconnectRenderer(previous);
    let socket: WebSocket | undefined;
    if (reason === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
    if (reason === "opening") previous.viewer.socketOpening = true;
    if (reason === "active") socket = await connect(previous.data);
    if (reason === "explicit-logout") {
      // Its membership may already have disappeared; signed logout still clears
      // the old renderer checkpoint without granting any replacement access.
      sessionStore.deleteSession(previous.owner.session.id);
      expect((await app.inject({ method: "POST", url: "/api/logout", headers: previous.owner.headers })).statusCode).toBe(200);
    }
    if (reason === "revoked-connection") await service.revokeConnection(previous.viewer.discordUserId, "connection");
    const current = await actor(reason === "another-user" ? "viewer-2" : "viewer-1", "replacement-instance", {
      guildId: reason === "another-guild" ? "other-guild" : "guild", channelId: reason === "another-channel" ? "other-channel" : "channel"
    });
    const connectionId = reason === "another-connection" ? "other-connection" : reason === "another-server" ? "other-server" : "connection";
    expect((await app.inject({ method: "POST", url: "/api/party", headers: current.headers, payload: { connectionId } })).statusCode).toBe(200);
    expect(service.get(current.session)?.id).not.toBe(previous.viewer.partyId);
    const response = await app.inject({ method: "POST", url: "/api/native/launch", headers: current.headers, payload: { connectionId, deviceId: randomUUID() } });
    expect(response.statusCode).toBe(200);
    expect(response.json().restoreRoute).toBeNull();
    socket?.terminate();
  });

  it("does not select between ambiguous disconnected groups", async () => {
    const first = await launch();
    const active = await connect(first.data);
    const second = await launch(await actor("viewer-1", "second-instance"));
    active.terminate();
    await eventually(() => first.viewer.lastSocketClose > 0);
    await disconnectRenderer(second);
    const third = await launch(await actor("viewer-1", "third-instance"));
    expect(third.viewer.partyId).not.toBe(first.viewer.partyId);
    expect(third.viewer.partyId).not.toBe(second.viewer.partyId);
    expect(calls.filter(call => call.path === "/SyncPlay/New")).toHaveLength(3);
  });

  it("allows only the newest renderer to save navigation while an older document still has an open socket", async () => {
    const previous = await launch();
    const socket = await connect(previous.data);
    const replacement = await launch(await actor());
    expect(previous.viewer.sockets).toBe(1);
    expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: replacement.owner.headers,
      payload: { connectionId: "connection", route: "#/movies", sequence: 1 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: previous.owner.headers,
      payload: { connectionId: "connection", route: "#/home", sequence: 200 } })).statusCode).toBe(409);
    expect((await app.inject({ url: "/api/native/restore?connectionId=connection", headers: replacement.owner.headers })).json().route).toBe("#/movies");
    socket.terminate();
  });

  it("does not let a predecessor socket close make the latest renderer's explicit Leave restorable", async () => {
    const previous = await launch();
    const oldSocket = await connect(previous.data);
    const replacement = await launch(await actor());
    const socket = await connect(replacement.data);
    oldSocket.terminate();
    await eventually(() => previous.viewer.lastSocketClose > 0);
    expect((await app.inject({ method: "POST", url: "/api/logout", headers: replacement.owner.headers })).statusCode).toBe(200);
    await eventually(() => replacement.viewer.revoked);
    socket.terminate();
    const third = await launch(await actor("viewer-1", "another-instance"));
    expect(third.viewer.partyId).not.toBe(previous.viewer.partyId);
    expect(third.data.restoreRoute).toBeNull();
  });

  it("revokes every old capability before asynchronous handoff cleanup can let another socket reopen", async () => {
    const first = await launch();
    const firstSocket = await connect(first.data);
    const second = await launch(await actor());
    firstSocket.terminate();
    await eventually(() => first.viewer.lastSocketClose > 0);
    await first.viewer.socketCleanup;
    await disconnectRenderer(second);
    const next = await actor("viewer-1", "popped-out-instance");
    const originalFetch = service.dependencies.fetch;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    service.dependencies.fetch = vi.fn(async (target, path, init) => {
      if (path === "/SyncPlay/Leave") await blocked;
      return originalFetch(target, path, init);
    });
    const handoff = service.bind(next.session, "connection");
    try {
      await eventually(() => first.viewer.revoked);
      expect(second.viewer.revoked).toBe(true);
      expect((await app.inject({ url: `${second.data.baseUrl}/Users/Me` })).statusCode).toBe(401);
    } finally { release(); }
    expect((await handoff).id).toBe(first.viewer.partyId);
  });

  it("requires current membership and a launched owned viewer before reading or writing a checkpoint", async () => {
    const previous = await launch();
    await disconnectRenderer(previous);
    const denied = await actor("viewer-1", "replacement-instance");
    service.dependencies.membership = vi.fn(async () => { throw new Error("not a participant"); });
    expect((await app.inject({ method: "POST", url: "/api/party", headers: denied.headers, payload: { connectionId: "connection" } })).statusCode).toBe(502);
    expect(service.get(previous.owner.session)?.id).toBe(previous.viewer.partyId);
    expect((await app.inject({ url: "/api/native/restore?connectionId=connection" })).statusCode).toBe(401);
    expect(calls.filter(call => call.path === "/SyncPlay/New")).toHaveLength(1);
  });

  it("rejects credential-bearing routes and unverified logout without clearing a valid checkpoint", async () => {
    const previous = await launch();
    await disconnectRenderer(previous);
    for (const route of ["https://evil.example", `#/jf/${previous.data.accessToken}`, "#/login", "#/video", "#/details?id=invalid", "#/home?api_key=secret", "#/home?serverId=other", "#/search?query=https%3A%2F%2Fevil.example", "#/home?tab=0&tab=1"]) {
      expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: previous.owner.headers,
        payload: { connectionId: "connection", route, sequence: 2 } })).statusCode).toBe(400);
    }
    const invalidToken = previous.owner.appToken.slice(0, -5) + "wrong";
    expect((await app.inject({ method: "POST", url: "/api/logout", headers: { authorization: `Bearer ${invalidToken}` } })).statusCode).toBe(200);
    const replacement = await launch(await actor("viewer-1", "replacement-instance"));
    expect(replacement.viewer.partyId).toBe(previous.viewer.partyId);
    expect(replacement.data.restoreRoute).toContain("#/details?");
    expect((await app.inject({ url: "/api/native/restore?connectionId=someone-elses", headers: replacement.owner.headers })).statusCode).toBe(409);
  });

  it("lets an expired correctly signed token revoke restoration while still denying every read", async () => {
    const previous = await launch();
    await disconnectRenderer(previous);
    const token = await new SignJWT({ sid: previous.owner.session.id }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(previous.owner.session.discordUserId).setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(new TextEncoder().encode(app.envConfig.APP_SESSION_SECRET));
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: "/api/native/restore?connectionId=connection", headers })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/logout", headers })).statusCode).toBe(200);
    expect(sessionStore.getSession(previous.owner.session.id)).toBeUndefined();
    const next = await launch(await actor("viewer-1", "replacement-instance"));
    expect(next.viewer.partyId).not.toBe(previous.viewer.partyId);
    expect(next.data.restoreRoute).toBeNull();
  });

  it("shares one party service across route scopes and returns only an opaque launch token", async () => {
    const { owner, data } = await launch();
    expect(JSON.stringify(data)).not.toContain(TOKEN);
    expect(data.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const read = await app.inject({ url: "/api/party", headers: owner.headers });
    expect(read.json().party.groupId).toBe(GROUP);
    const native = await app.inject({ url: `${data.baseUrl}/Users/Me?UserId=another&api_key=stolen` });
    expect(native.statusCode).toBe(200);
    expect(native.json().RequestedUser).toBe(USER);
    expect(native.json().AccessToken).toBeUndefined();
    expect(native.json().Policy.IsAdministrator).toBe(false);
    const call = calls.at(-1)!;
    expect(call.authorization).toContain(`DeviceId="${data.deviceId}"`);
    expect(call.authorization).toContain(`Token="${TOKEN}"`);
    expect(call.query).not.toHaveProperty("api_key");
  });

  it("creates independent native sessions for users sharing a Jellyfin account", async () => {
    const a = await launch();
    const b = await launch(await actor("viewer-3"));
    expect(a.data.userId).toBe(b.data.userId);
    expect(a.data.deviceId).not.toBe(b.data.deviceId);
    expect(a.data.groupId).toBe(b.data.groupId);
    expect(nativeSessionId({ deviceId: "fixture-device" } as NativeViewer)).toBe("acb2f86ad11cf671fc6bc0e5162dc386");
  });

  it("reports supported Home capabilities and preserves personalized resume, next-up and latest rows", async () => {
    const { data } = await launch();
    const user = (await app.inject({ url: `${data.baseUrl}/Users/Me` })).json();
    expect(user.Policy).toMatchObject({ EnableLiveTvAccess: false, EnableLiveTvManagement: false, EnableMediaPlayback: true });
    for (const path of [`/Users/${USER}/Items/Resume`, "/Shows/NextUp", `/Users/${USER}/Items/Latest`]) {
      const response = await app.inject({ url: `${data.baseUrl}${path}?UserId=another&Limit=12&Fields=PrimaryImageAspectRatio` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const items = Array.isArray(body) ? body : body.Items;
      expect(items).toEqual([{ Id: ITEM, Type: "Episode", UserData: { Played: false, PlaybackPositionTicks: 90_000_000 } }]);
      expect(calls.at(-1)?.query).toMatchObject({ UserId: USER, Limit: "12", Fields: "PrimaryImageAspectRatio" });
    }
    const before = calls.length;
    expect((await app.inject({ url: `${data.baseUrl}/LiveTv/Programs/Recommended` })).statusCode).toBe(403);
    expect((await app.inject({ url: `${data.baseUrl}/Users/another/Items/Resume` })).statusCode).toBe(403);
    expect(calls).toHaveLength(before);
  });

  it.each(["/System/Configuration", "/Users/Public", "/Users/another", "/Users/Me/Policy", "/Items/../System/Configuration", "/Items/%252e%252e/System", "/Items/%2fSystem", "/Packages", "/Sessions/other/Playing", "/Videos/ActiveEncodings/other"])("denies unscoped route %s", async (path) => {
    const { viewer } = await launch();
    expect(() => allowNativeRequest(viewer, "GET", path)).toThrow();
  });

  it("never exposes other groups or accepts a new native group", async () => {
    const { data } = await launch();
    expect((await app.inject({ url: `${data.baseUrl}/SyncPlay/List` })).json()).toEqual([expect.objectContaining({ GroupId: GROUP })]);
    expect((await app.inject({ url: `${data.baseUrl}/SyncPlay/${ITEM}` })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${data.baseUrl}/SyncPlay/New`, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${data.baseUrl}/SyncPlay/Join`, payload: { GroupId: ITEM } })).statusCode).toBe(409);
  });

  it("checks item visibility before anonymous-capable images and media", async () => {
    const { data } = await launch();
    const start = calls.length;
    for (const path of [`/Items/${DENIED}/Images/Primary`, `/Videos/${DENIED}/stream.mp4`, `/Items/${DENIED}/PlaybackInfo`]) {
      const response = await app.inject({ url: data.baseUrl + path });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(TOKEN);
    }
    expect(calls.slice(start).every((c) => c.path.includes(`/Users/${USER}/Items/`))).toBe(true);
    expect((await app.inject({ url: `${data.baseUrl}/Videos/${ITEM}/stream.mp4?MediaSourceId=${DENIED}` })).statusCode).toBe(403);
  });

  it("rewrites HLS and playback URLs without forwarding the Jellyfin token", async () => {
    const { data, viewer } = await launch();
    const info = await app.inject({ method: "POST", url: `${data.baseUrl}/Items/${ITEM}/PlaybackInfo`, payload: {} });
    expect(info.statusCode).toBe(200);
    const url = info.json().MediaSources[0].TranscodingUrl as string;
    expect(url).toBe(`Videos/${ITEM}/master.m3u8`);
    expect(info.body).not.toContain(TOKEN);
    expect(info.body).not.toContain("/private/");
    const playlist = await app.inject({ url: `${data.baseUrl}/${url}` });
    expect(playlist.statusCode).toBe(200);
    expect(playlist.body).toContain(`${data.baseUrl}/Videos/${ITEM}/hls1/main/0.ts`);
    expect(playlist.body).not.toContain(TOKEN);
    expect(playlist.body).not.toContain("api_key");
    expect(() => rewriteNativePlaylist(viewer, "#EXTM3U\nhttps://evil.example/steal", `${upstreamAddress}/Videos/${ITEM}/master.m3u8`)).toThrow();
    const media = await app.inject({ url: `${data.baseUrl}/Videos/${ITEM}/stream.mp4`, headers: { range: "bytes=0-3" } });
    expect(media.statusCode).toBe(206);
    expect(media.body).toBe("data");
    expect(media.headers["content-range"]).toBe("bytes 0-3/4");
    expect(media.headers["cache-control"]).toBe("no-store");
  });

  it("keeps native trickplay references in a master playlist reachable through the gateway", async () => {
    const { viewer } = await launch();
    const output = rewriteNativePlaylist(viewer, '#EXTM3U\n#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=100,URI="Trickplay/320/tiles.m3u8"\nmain.m3u8', `${upstreamAddress}/Videos/${ITEM}/master.m3u8`);
    expect(output).toContain(`/Videos/${ITEM}/Trickplay/320/tiles.m3u8`);
    expect(allowNativeRequest(viewer, "GET", `/Videos/${ITEM}/Trickplay/320/0.jpg`)).toContain("Trickplay");
    expect(() => allowNativeRequest(viewer, "GET", `/Videos/${ITEM}/Trickplay/../private`)).toThrow();
  });

  it("streams a feature-length native VOD playlist above the old 2MiB limit", async () => {
    const { data } = await launch();
    largePlaylist = true;
    const response = await app.inject({ url: `${data.baseUrl}/Videos/${ITEM}/main.m3u8` });
    expect(response.statusCode).toBe(200);
    expect(response.body.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(response.body).toContain(`${data.baseUrl}/Videos/${ITEM}/hls1/main/2199.ts`);
    expect(response.body).not.toContain(TOKEN);
  });

  it("scopes playback reports and filters session enumeration", async () => {
    const { data, viewer } = await launch();
    const result = await app.inject({ method: "POST", url: `${data.baseUrl}/Sessions/Playing`, payload: { UserId: "other", DeviceId: "other", SessionId: "other", PlaySessionId: "native-play-session", ItemId: ITEM } });
    expect(result.statusCode).toBe(204);
    expect(calls.at(-1)?.body).toEqual({ UserId: USER, DeviceId: data.deviceId, SessionId: nativeSessionId(viewer), PlaySessionId: "native-play-session", ItemId: ITEM });
    const list = await app.inject({ url: `${data.baseUrl}/Sessions` });
    expect(list.json()).toHaveLength(1);
    expect(list.body).not.toContain("other-session");
  });

  it("authenticates before upgrading, joins after upstream readiness, and leaves on abrupt disconnect", async () => {
    const { data, viewer } = await launch();
    const deniedStatus = await new Promise<number>((resolve, reject) => {
      const denied = new WebSocket(`${appAddress.replace("http:", "ws:")}/jf/invalid/socket`);
      denied.on("unexpected-response", (_request, response) => { resolve(response.statusCode!); response.resume(); denied.terminate(); });
      denied.on("open", () => reject(new Error("unauthorized upgrade")));
      denied.on("error", () => undefined);
    });
    expect(deniedStatus).toBe(401);
    const socket = await connect(data);
    expect(upstreamSockets.has(data.deviceId)).toBe(true);
    const joined = await app.inject({ method: "POST", url: `${data.baseUrl}/SyncPlay/Join`, payload: { GroupId: "wrong" } });
    expect(joined.statusCode).toBe(204);
    expect(calls.find((c) => c.path === "/SyncPlay/Join")?.body).toEqual({ GroupId: GROUP });
    await eventually(() => service.parties.get(viewer.partyId)?.currentPlaylistItemId === PLAYLIST_ITEM);
    await service.command(viewer, "next");
    expect(calls.at(-1)?.body).toEqual({ PlaylistItemId: PLAYLIST_ITEM });
    expect(await service.command(viewer, "now")).toMatchObject({ title: "Test movie", positionSeconds: 5, isPaused: false });
    await app.inject({ method: "POST", url: `${data.baseUrl}/SyncPlay/Join`, payload: { GroupId: GROUP } });
    expect(calls.filter((c) => c.path === "/SyncPlay/Join")).toHaveLength(1);
    socket.terminate();
    await eventually(() => calls.some((c) => c.path === "/SyncPlay/Leave" && device(c.authorization) === data.deviceId));
    expect(viewer.joined).toBe(false);
    const reconnected = await connect(data);
    expect((await app.inject({ method: "POST", url: `${data.baseUrl}/SyncPlay/Join`, payload: { GroupId: GROUP } })).statusCode).toBe(204);
    reconnected.terminate();
  });

  it("revokes HTTP, live socket, and active media immediately on logout", async () => {
    const { data, owner } = await launch();
    const socket = await connect(data);
    const transfer = await fetch(`${appAddress}${data.baseUrl}/Videos/${ITEM}/stream.mp4?slow=true`);
    const reader = transfer.body!.getReader();
    await reader.read();
    const closed = once(socket, "close");
    sessionStore.deleteSession(owner.session.id);
    await closed;
    await eventually(() => slowTransferClosed);
    await reader.cancel().catch(() => undefined);
    expect((await app.inject({ url: `${data.baseUrl}/Users/Me` })).statusCode).toBe(401);
  });

  it("expires capabilities and invalidates every viewer when the party server changes", async () => {
    const { data, owner, viewer } = await launch();
    const another = await launch(await actor("viewer-3"));
    viewer.expiresAt = Date.now() - 1;
    expect((await app.inject({ url: `${data.baseUrl}/Users/Me` })).statusCode).toBe(401);
    const change = await app.inject({ method: "POST", url: "/api/party", headers: owner.headers, payload: { connectionId: "other-server" } });
    expect(change.statusCode).toBe(200);
    expect((await app.inject({ url: `${another.data.baseUrl}/Users/Me` })).statusCode).toBe(401);
  });

  it("denies a queue mutation if any party member lacks item access", async () => {
    const { data } = await launch();
    const second = await launch(await actor("viewer-2"));
    deniedForUser.add(second.data.userId);
    const result = await app.inject({ method: "POST", url: `${data.baseUrl}/SyncPlay/SetNewQueue`, payload: { PlayingQueue: [ITEM], PlayingItemPosition: 0 } });
    expect(result.statusCode).toBe(403);
    expect(calls.some((c) => c.path === "/SyncPlay/SetNewQueue")).toBe(false);
  });

  it("distinguishes invalid, empty and oversized native queues without forwarding any mutation", async () => {
    const { data } = await launch();
    for (const [payload, code] of [
      [{ PlayingQueue: "private-body-value" }, "native_invalid_queue"],
      [{ PlayingQueue: [null] }, "native_invalid_queue"],
      [{ PlayingQueue: [] }, "native_queue_empty"],
      [{ PlayingQueue: Array(501).fill(ITEM) }, "native_queue_too_large"]
    ] as const) {
      const result = await app.inject({ method: "POST", url: `${data.baseUrl}/SyncPlay/SetNewQueue`, payload });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toMatchObject({ error: { code } });
      expect(result.headers["x-application-error-code"]).toBe(code);
      expect(result.body).not.toContain("private-body-value");
      expect(result.body).not.toContain(ITEM);
    }
    expect(calls.some((c) => c.path === "/SyncPlay/SetNewQueue")).toBe(false);
  });

  it("forwards the native JSON queue format used by desktop and mobile clients", async () => {
    const { data } = await launch();
    const payload = { PlayingQueue: Array(37).fill(ITEM), PlayingItemPosition: 0, StartPositionTicks: 0 };
    const result = await app.inject({ method: "POST", url: `${data.baseUrl}/SyncPlay/SetNewQueue`,
      headers: { "content-type": "application/json; charset=UTF-8" }, payload: JSON.stringify(payload) });
    expect(result.statusCode).toBe(204);
    expect(calls.find((c) => c.path === "/SyncPlay/SetNewQueue")?.body).toEqual(payload);
  });

  it("fails closed when Discord membership renewal fails", async () => {
    const { data } = await launch();
    service.dependencies.membership = vi.fn(async () => { throw new Error("not a participant"); });
    expect((await app.inject({ url: `${data.baseUrl}/Users/Me` })).statusCode).toBe(401);
    expect(service.viewers.has(data.accessToken)).toBe(false);
  });

  it("revokes a disconnected capability after its grace period instead of retaining a zombie", async () => {
    const { data, viewer } = await launch();
    const socket = await connect(data);
    await app.inject({ method: "POST", url: `${data.baseUrl}/SyncPlay/Join`, payload: { GroupId: GROUP } });
    socket.terminate();
    await eventually(() => viewer.lastSocketClose > 0);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    await service.sweep();
    expect(service.viewers.has(data.accessToken)).toBe(true);
    expect(service.parties.size).toBe(1);
    expect((await app.inject({ url: `${data.baseUrl}/Users/Me` })).statusCode).toBe(200);
    clock.mockReturnValue(now + 121_000);
    await service.sweep();
    expect(service.viewers.has(data.accessToken)).toBe(false);
    clock.mockReturnValue(now + 242_000);
    await service.sweep();
    expect(service.parties.size).toBe(0);
    expect(calls.filter((c) => c.path === "/SyncPlay/Leave").length).toBeGreaterThanOrEqual(2);
  });

  it("expires unused launch capabilities even while the cleanup timer verifies membership", async () => {
    const { data } = await launch();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    await service.sweep();
    clock.mockReturnValue(now + 121_000);
    await service.sweep();
    expect(service.viewers.has(data.accessToken)).toBe(false);
  });

  it("disconnecting the stored connection revokes capabilities and closes its native group", async () => {
    const { viewer, data } = await launch();
    await service.revokeConnection(viewer.discordUserId, viewer.connection.id);
    expect(service.parties.size).toBe(0);
    expect((await app.inject({ url: `${data.baseUrl}/Users/Me` })).statusCode).toBe(401);
  });

  it.each(["image/svg+xml", "application/xhtml+xml", "text/html", "application/javascript"])("rejects executable upstream content type %s", async (contentType) => {
    const { data } = await launch();
    imageContentType = contentType;
    const response = await app.inject({ url: `${data.baseUrl}/Items/${ITEM}/Images/Primary` });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("<script>");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects reports that try to modify playback history for inaccessible items", async () => {
    const { data } = await launch();
    const response = await app.inject({ method: "POST", url: `${data.baseUrl}/Sessions/Playing/Stopped`, payload: { itemId: DENIED, PositionTicks: 5000 } });
    expect(response.statusCode).toBe(403);
    expect(calls.some((call) => call.path === "/Sessions/Playing/Stopped")).toBe(false);
  });

  it("cannot use another Activity's connection capability to select its native group", async () => {
    const a = await launch();
    const b = await launch(await actor("viewer-4", "other-instance"));
    expect(a.viewer.partyId).not.toBe(b.viewer.partyId);
    expect(service.get(a.owner.session)?.id).toBe(a.viewer.partyId);
    expect(service.get(b.owner.session)?.id).toBe(b.viewer.partyId);
    await service.destroyParty(service.parties.get(a.viewer.partyId)!);
    expect((await app.inject({ url: `${a.data.baseUrl}/Users/Me` })).statusCode).toBe(401);
    expect((await app.inject({ url: `${b.data.baseUrl}/Users/Me` })).statusCode).toBe(200);
  });

  it("cleans up a group if its connection is revoked while group creation is in flight", async () => {
    const owner = await actor();
    let current = true;
    service.dependencies.current = vi.fn(() => { if (!current) throw new Error("connection changed"); });
    const send = service.dependencies.fetch;
    service.dependencies.fetch = async (target, path, init) => {
      const response = await send(target, path, init);
      if (String(path) === "/SyncPlay/New") current = false;
      return response;
    };
    const response = await app.inject({ method: "POST", url: "/api/party", headers: owner.headers, payload: { connectionId: "connection" } });
    expect(response.statusCode).toBe(502);
    expect(service.parties.size).toBe(0);
    expect(service.viewers.size).toBe(0);
    expect(calls.some((call) => call.path === "/SyncPlay/Leave")).toBe(true);
  });

  it("cannot publish a replacement capability from a connection revoked during old-viewer cleanup", async () => {
    const { owner, viewer } = await launch();
    let current = true;
    service.dependencies.current = vi.fn(() => { if (!current) throw new Error("connection changed"); });
    const send = service.dependencies.fetch;
    service.dependencies.fetch = async (target, path, init) => {
      const response = await send(target, path, init);
      if (String(path) === "/SyncPlay/Leave") current = false;
      return response;
    };
    await expect(service.launch(owner.session, "connection", viewer.clientDeviceId)).rejects.toThrow("connection changed");
    expect(service.viewers.size).toBe(0);
  });

  it("denies a late join before native group mutation if its account cannot read the current queue", async () => {
    const first = await launch();
    service.parties.get(first.viewer.partyId)!.queueItemIds = [ITEM];
    const second = await launch(await actor("viewer-2"));
    deniedForUser.add(second.data.userId);
    const socket = await connect(second.data);
    const response = await app.inject({ method: "POST", url: `${second.data.baseUrl}/SyncPlay/Join`, payload: { GroupId: GROUP } });
    expect(response.statusCode).toBe(403);
    expect(calls.some((call) => call.path === "/SyncPlay/Join")).toBe(false);
    socket.terminate();
  });

  it("replaces an existing viewer at capacity but rejects a net additional viewer", async () => {
    const { owner, viewer } = await launch();
    app.envConfig.ROOM_MAX_PARTICIPANTS = 1;
    const replacement = await service.launch(owner.session, "connection", viewer.clientDeviceId);
    expect(replacement.accessToken).not.toBe(viewer.capability);
    expect(service.viewers.size).toBe(1);
    expect(viewer.revoked).toBe(true);
    const second = await actor("viewer-3");
    await expect(service.launch(second.session, "connection", "second-device")).rejects.toMatchObject({ code: "party_full" });
  });

  it("serializes simultaneous different-device launches against the party capacity", async () => {
    const owner = await actor();
    await service.bind(owner.session, "connection");
    app.envConfig.ROOM_MAX_PARTICIPANTS = 1;
    const results = await Promise.allSettled([service.launch(owner.session, "connection", "one"), service.launch(owner.session, "connection", "two")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(service.viewers.size).toBe(1);
  });

  it("allows only one concurrent upstream socket for a native device", async () => {
    const { data, viewer } = await launch();
    socketAcceptDelay = 50;
    const connectOne = () => new Promise<{ status: number; socket: WebSocket }>((resolve) => {
      const socket = new WebSocket(`${appAddress.replace("http:", "ws:")}${data.baseUrl}/socket`);
      socket.on("open", () => resolve({ status: 101, socket }));
      socket.on("unexpected-response", (_request, response) => { response.resume(); resolve({ status: response.statusCode!, socket }); socket.terminate(); });
      socket.on("error", () => undefined);
    });
    const results = await Promise.all([connectOne(), connectOne(), connectOne()]);
    expect(results.map((result) => result.status).sort()).toEqual([101, 409, 409]);
    expect(viewer.sockets).toBe(1);
    for (const { socket } of results) socket.terminate();
  });

  it("sanitizes credentials recursively rather than depending on a particular DTO", async () => {
    const { viewer } = await launch();
    const result = sanitizeNativeJson(viewer, { User: { Token: TOKEN }, CustomCss: "@import url(https://external.invalid/style.css)", Note: `literal ${TOKEN}`, LocalAddress: upstreamAddress, Path: "/secret/file" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("external.invalid");
    expect(JSON.stringify(result)).not.toContain("/secret/");
  });
});


describe("native command episode queues and account permissions", () => {
  it("expands a Discord episode selection using Jellyfin's ordered episode list", async () => {
    const { data, viewer } = await launch();
    const socket = await connect(data);
    await app.inject({ method: "POST", url: `${data.baseUrl}/SyncPlay/Join`, payload: { GroupId: GROUP } });
    episodeMode = true;
    await service.command(viewer, "select", { itemIds: [ITEM] });
    expect([...calls].reverse().find((call) => call.path === "/SyncPlay/SetNewQueue")?.body).toEqual({
      PlayingQueue: [ITEM, PLAYLIST_ITEM], PlayingItemPosition: 0, StartPositionTicks: 0
    });
    expect(calls.find((call) => call.path === `/Shows/${GROUP}/Episodes`)?.query.StartItemId).toBe(ITEM);
    socket.close();
  });

  it("explains a missing native group permission without disclosing upstream data", async () => {
    const who = await actor();
    denyGroupCreation = true;
    const result = await app.inject({ method: "POST", url: "/api/party", headers: who.headers, payload: { connectionId: "connection" } });
    expect(result.statusCode).toBe(403);
    expect(result.json().error.code).toBe("syncplay_create_not_allowed");
    expect(result.json().error.message).toContain("administrator");
    expect(result.body).not.toContain(TOKEN);
  });
});
