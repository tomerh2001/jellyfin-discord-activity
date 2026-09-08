import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv, type AppEnv } from "../env.js";
import { connectionRoutes } from "../routes/connections.js";
import { createAppSession } from "../services/appSession.js";
import { assertConnectionCurrent, connectCommunity, connectWithPassword, disconnectConnection, JellyfinConnectionStore,
  onConnectionsRevoked, QuickConnectManager, resolveConnection, type ConnectionDto } from "../services/jellyfinConnections.js";
import { sessionStore } from "../services/sessionStore.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("saved Jellyfin connections", () => {
  it("requires a live app session before any connection operation", async () => {
    const f = await fixture();
    for (const [method, url] of [["GET", "/api/connections"], ["POST", "/api/connections"],
      ["POST", "/api/connections/community"], ["PUT", "/api/connections/preference"],
      ["DELETE", "/api/connections/unknown"], ["POST", "/api/connections/quick-connect"],
      ["POST", "/api/connections/quick-connect/unknown/poll"]] as const) {
      expect((await f.app.inject({ method, url })).statusCode).toBe(401);
    }
    expect(f.requests).toHaveLength(0);
  });

  it("validates public server identity before sending a password and sanitizes upstream errors", async () => {
    const f = await fixture();
    const user = await actor(f.env);
    f.state.publicInfo = { unexpected: "not Jellyfin" };
    const invalid = await f.app.inject({ method: "POST", url: "/api/connections", headers: user.headers,
      payload: { serverUrl: f.url, username: "demo", password: "private-password" } });
    expect(invalid.statusCode).toBe(502);
    expect(f.requests.map((request) => request.path)).toEqual(["/System/Info/Public"]);
    expect(f.requests[0]?.headers.authorization).toBeUndefined();
    expect(invalid.body).not.toContain("private-password");
    f.state.publicInfo = { Id: "server-one", ServerName: "Fixture Library", Version: "10.11.0" };
    f.state.authStatus = 401;
    const rejected = await f.app.inject({ method: "POST", url: "/api/connections", headers: user.headers,
      payload: { serverUrl: f.url, username: "demo", password: "private-password" } });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body).not.toContain("upstream-debug-private-password");
    expect(new JellyfinConnectionStore(f.env).list(user.session.discordUserId)).toEqual([]);
  });

  it("preserves password whitespace, encrypts only the token, and restores it for the same Discord account", async () => {
    const f = await fixture();
    const user = await actor(f.env, "alice", "guild-one");
    const result = await f.app.inject({ method: "POST", url: "/api/connections", headers: user.headers,
      payload: { serverUrl: `${f.url}/`, username: " demo ", password: "  fixture password  " } });
    expect(result.statusCode).toBe(201);
    const connection = result.json<{ connection: ConnectionDto }>().connection;
    expect(connection).toMatchObject({ serverUrl: f.url, serverId: "server-one", jellyfinUsername: "demo", kind: "personal" });
    const login = f.requests.find((request) => request.path === "/Users/AuthenticateByName")!;
    expect(login.body).toEqual({ Username: "demo", Pw: "  fixture password  " });
    expect(result.body).not.toMatch(/fixture-access-token|encryptedAccessToken|loginDeviceId|fixture password/);
    const filename = path.join(f.dataDir, "jellyfin-connections.sqlite");
    const stored = await readFile(filename);
    expect(stored.includes(Buffer.from("fixture-access-token"))).toBe(false);
    expect(stored.includes(Buffer.from("fixture password"))).toBe(false);
    expect(stored.includes(Buffer.from("v1."))).toBe(true);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    sessionStore.deleteSession(user.session.id);
    const reopened = await actor(f.env, "alice", "guild-one");
    const list = await f.app.inject({ method: "GET", url: "/api/connections", headers: reopened.headers });
    expect(list.json()).toMatchObject({ connections: [connection], preferredConnectionId: connection.id, defaultServerUrl: f.url });
    expect((await resolveConnection(f.env, "alice", connection.id)).accessToken).toBe("fixture-access-token-1");
    expect(f.state.authCount).toBe(1);
  });

  it("isolates ownership and guild preferences, and clears preferences and capabilities on disconnect", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice", "guild-one");
    const bob = await actor(f.env, "bob", "guild-one");
    const connection = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "alice", password: "fixture" });
    const store = new JellyfinConnectionStore(f.env);
    expect(store.list("bob")).toEqual([]);
    expect(store.preferred("alice", "guild-two")).toBeNull();
    await expect(resolveConnection(f.env, "bob", connection.id)).rejects.toMatchObject({ statusCode: 404 });
    const forbiddenPreference = await f.app.inject({ method: "PUT", url: "/api/connections/preference", headers: bob.headers,
      payload: { connectionId: connection.id } });
    expect(forbiddenPreference.statusCode).toBe(404);
    const forbiddenDelete = await f.app.inject({ method: "DELETE", url: `/api/connections/${connection.id}`, headers: bob.headers });
    expect(forbiddenDelete.statusCode).toBe(404);
    expect(f.state.logoutCount).toBe(0);
    const secondGuild = await actor(f.env, "alice", "guild-two");
    const preferred = await f.app.inject({ method: "PUT", url: "/api/connections/preference", headers: secondGuild.headers,
      payload: { connectionId: connection.id } });
    expect(preferred.statusCode).toBe(200);
    expect(store.preferred("alice", "guild-two")).toBe(connection.id);
    const revoked = vi.fn(); cleanups.push(onConnectionsRevoked(revoked));
    const removed = await f.app.inject({ method: "DELETE", url: `/api/connections/${connection.id}`, headers: alice.headers });
    expect(removed.json()).toEqual({ ok: true, upstreamRevoked: true });
    expect(revoked).toHaveBeenCalledExactlyOnceWith({ connectionId: connection.id, discordUserId: "alice" });
    expect(f.requests.find((request) => request.path === "/Sessions/Logout")?.headers.authorization).toContain('Token="fixture-access-token-1"');
    expect(store.preferred("alice", "guild-one")).toBeNull();
    expect(store.preferred("alice", "guild-two")).toBeNull();
    await expect(resolveConnection(f.env, "alice", connection.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("relinking replaces the token atomically and revokes existing native capabilities", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice", "guild-one");
    const first = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "old-user", password: "fixture" });
    const oldCredential = await resolveConnection(f.env, "alice", first.id);
    expect(() => assertConnectionCurrent(f.env, "alice", oldCredential)).not.toThrow();
    const revoked = vi.fn(); cleanups.push(onConnectionsRevoked(revoked));
    const second = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "new-user", password: "fixture" });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.jellyfinUsername).toBe("new-user");
    expect(new JellyfinConnectionStore(f.env).list("alice")).toHaveLength(1);
    expect(revoked).toHaveBeenCalledExactlyOnceWith({ connectionId: first.id, discordUserId: "alice" });
    expect(() => assertConnectionCurrent(f.env, "alice", oldCredential)).toThrow();
    expect((await resolveConnection(f.env, "alice", second.id)).accessToken).toBe("fixture-access-token-2");
    expect(f.state.logoutCount).toBe(1);
    expect(f.requests.find((request) => request.path === "/Sessions/Logout")?.headers.authorization).toContain('Token="fixture-access-token-1"');
  });

  it("refuses saved-token use after a server ID change while still allowing local disconnection", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice");
    const connection = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "alice", password: "fixture" });
    f.state.publicInfo = { Id: "different-server", ServerName: "Replaced server", Version: "10.11.0" };
    const before = f.requests.length;
    await expect(resolveConnection(f.env, "alice", connection.id)).rejects.toMatchObject({ code: "jellyfin_identity_changed" });
    expect(await disconnectConnection(f.env, "alice", connection.id)).toEqual({ ok: true, upstreamRevoked: false });
    expect(f.requests.slice(before).every((request) => !request.headers.authorization && !request.headers["x-emby-authorization"])).toBe(true);
    expect(f.state.logoutCount).toBe(0);
    expect(new JellyfinConnectionStore(f.env).list("alice")).toEqual([]);
  });

  it("requires explicit community opt-in and binds community tokens to the approved guild", async () => {
    const f = await fixture({ JELLYFIN_AUTH_MODE: "shared", JELLYFIN_SHARED_USERNAME: "community",
      JELLYFIN_SHARED_PASSWORD: "community-fixture", DISCORD_ALLOWED_GUILD_IDS: "guild-one,guild-two" });
    const alice = await actor(f.env, "alice", "guild-one");
    const initial = await f.app.inject({ method: "GET", url: "/api/connections", headers: alice.headers });
    expect(initial.json()).toMatchObject({ connections: [], communityAvailable: true });
    expect(f.state.authCount).toBe(0);
    const chosen = await f.app.inject({ method: "POST", url: "/api/connections/community", headers: alice.headers });
    expect(chosen.statusCode).toBe(201);
    const community = chosen.json<{ connection: ConnectionDto }>().connection;
    expect(community.kind).toBe("community");
    await expect(resolveConnection(f.env, "alice", community.id, "guild-one")).resolves.toMatchObject({ kind: "community" });
    await expect(resolveConnection(f.env, "alice", community.id, "guild-two")).rejects.toMatchObject({ statusCode: 404 });
    const store = new JellyfinConnectionStore(f.env);
    expect(store.list("alice", "guild-two")).toEqual([]);
    expect(() => store.setPreferred("alice", "guild-two", community.id)).toThrow();
    const secondGuild = await actor(f.env, "alice", "guild-two");
    const second = await connectCommunity(f.env, secondGuild.session);
    expect(second.id).not.toBe(community.id);
    expect(store.list("alice", "guild-one").map((connection) => connection.id)).toEqual([community.id]);
    const otherGuild = await actor(f.env, "alice", "guild-outside");
    await expect(connectCommunity(f.env, otherGuild.session)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.requests.filter((request) => request.path === "/Users/AuthenticateByName").every((request) =>
      (request.body as { Username: string }).Username === "community")).toBe(true);
  });

  it("does not save a new token if the app session is revoked during authentication", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice");
    f.state.beforeAuthResponse = () => sessionStore.deleteSession(alice.session.id);
    await expect(connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "alice", password: "fixture" }))
      .rejects.toMatchObject({ code: "invalid_app_session" });
    expect(new JellyfinConnectionStore(f.env).list("alice")).toEqual([]);
    expect(f.state.logoutCount).toBe(1);
  });
});

describe("Jellyfin Quick Connect", () => {
  it("returns only the code, binds polling to the exact app session, and exchanges the secret once", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice", "guild-one");
    const otherSession = await actor(f.env, "alice", "guild-one");
    const start = await f.app.inject({ method: "POST", url: "/api/connections/quick-connect", headers: alice.headers,
      payload: { serverUrl: f.url } });
    expect(start.statusCode).toBe(201);
    expect(start.body).not.toContain("fixture-quick-connect-secret");
    const pending = start.json<{ id: string; code: string; expiresAt: string }>();
    expect(pending.code).toBe("123456");
    const pollUrl = `/api/connections/quick-connect/${pending.id}/poll`;
    const denied = await f.app.inject({ method: "POST", url: pollUrl, headers: otherSession.headers });
    expect(denied.statusCode).toBe(404);
    expect(f.state.pollCount).toBe(0);
    const waiting = await f.app.inject({ method: "POST", url: pollUrl, headers: alice.headers });
    expect(waiting.json()).toEqual({ status: "pending" });
    f.state.quickAuthorized = true;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2100);
    const results = await Promise.all([1, 2].map(() => f.app.inject({ method: "POST", url: pollUrl, headers: alice.headers })));
    expect(results.every((result) => result.statusCode === 200)).toBe(true);
    const completed = results[0]!.json<{ status: string; connection: ConnectionDto }>();
    expect(completed.status).toBe("connected");
    expect(results[1]!.json()).toEqual(completed);
    expect(f.state.quickAuthCount).toBe(1);
    expect(results[0]!.body).not.toMatch(/fixture-quick-connect-secret|fixture-access-token/);
    expect(new JellyfinConnectionStore(f.env).preferred("alice", "guild-one")).toBe(completed.connection.id);
    expect(f.requests.find((request) => request.path === "/Users/AuthenticateWithQuickConnect")?.body)
      .toEqual({ Secret: "fixture-quick-connect-secret" });
  });

  it("invalidates superseded and revoked requests without disclosing their state", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice");
    const manager = new QuickConnectManager(f.env); cleanups.push(() => manager.dispose());
    const old = await manager.start(alice.session, f.url);
    const current = await manager.start(alice.session, f.url);
    await expect(manager.poll(alice.session, old.id)).rejects.toMatchObject({ statusCode: 404 });
    sessionStore.deleteSession(alice.session.id);
    await expect(manager.poll(alice.session, current.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(f.state.pollCount).toBe(0);
  });

  it("does not save an in-flight Quick Connect result after session revocation", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice");
    const manager = new QuickConnectManager(f.env); cleanups.push(() => manager.dispose());
    const pending = await manager.start(alice.session, f.url);
    f.state.quickAuthorized = true;
    f.state.beforeAuthResponse = () => sessionStore.deleteSession(alice.session.id);
    await expect(manager.poll(alice.session, pending.id)).rejects.toMatchObject({ code: "invalid_app_session" });
    expect(new JellyfinConnectionStore(f.env).list("alice")).toEqual([]);
    expect(f.state.logoutCount).toBe(1);
  });
});

async function actor(env: AppEnv, userId = "alice", guildId?: string) {
  const result = await createAppSession({ env, user: { id: userId, username: userId, avatar: null },
    discordContext: { instanceId: `instance-${guildId ?? "private"}`, ...(guildId ? { guildId } : {}) } });
  cleanups.push(() => sessionStore.deleteSession(result.session.id));
  return { ...result, headers: { authorization: `Bearer ${result.appToken}` } };
}

async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const requests: { path: string; headers: IncomingHttpHeaders; body: unknown }[] = [];
  const state = { publicInfo: { Id: "server-one", ServerName: "Fixture Library", Version: "10.11.0" } as unknown,
    authStatus: 200, authCount: 0, logoutCount: 0, pollCount: 0, quickAuthorized: false, quickAuthCount: 0,
    beforeAuthResponse: undefined as (() => void) | undefined };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const text = Buffer.concat(chunks).toString();
    const body: unknown = text ? JSON.parse(text) : null;
    const url = new URL(request.url!, "http://fixture");
    requests.push({ path: url.pathname, headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    const send = (value: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    if (url.pathname === "/System/Info/Public") return send(state.publicInfo);
    if (url.pathname === "/Users/AuthenticateByName" || url.pathname === "/Users/AuthenticateWithQuickConnect") {
      state.authCount++;
      if (url.pathname.endsWith("AuthenticateWithQuickConnect")) state.quickAuthCount++;
      state.beforeAuthResponse?.();
      if (state.authStatus !== 200) return send({ debug: "upstream-debug-private-password" }, state.authStatus);
      const name = (body as { Username?: string }).Username ?? "quick-user";
      return send({ User: { Id: `user-${name}`, Name: name }, AccessToken: `fixture-access-token-${state.authCount}`, ServerId: "server-one" });
    }
    if (url.pathname === "/Sessions/Logout") { state.logoutCount++; response.writeHead(204); return response.end(); }
    if (url.pathname === "/QuickConnect/Initiate") return send({ Secret: "fixture-quick-connect-secret", Code: "123456" });
    if (url.pathname === "/QuickConnect/Connect") {
      state.pollCount++;
      if (url.searchParams.get("Secret") !== "fixture-quick-connect-secret") return send({}, 404);
      return send({ Authenticated: state.quickAuthorized });
    }
    send({}, 404);
  });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(path.join(tmpdir(), "jellyfin-connections-test-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
    DATABASE_URL: `file:${path.join(dataDir, "app.db")}`, JELLYFIN_DEFAULT_SERVER_URL: url, ...overrides });
  const app: FastifyInstance = Fastify({ logger: false });
  app.decorate("envConfig", env);
  app.decorateRequest("appSession");
  await app.register(connectionRoutes);
  await app.ready();
  cleanups.push(() => app.close());
  return { app, env, dataDir, url, requests, state };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_listener_failed");
  return address.port;
}
