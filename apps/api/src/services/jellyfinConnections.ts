import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AppEnv } from "../env.js";
import { decryptString, encryptString, generateId } from "./crypto.js";
import { sessionStore, type AppSession } from "./sessionStore.js";
import { normalizeUpstreamUrl, readUpstreamJson, upstreamFetch, validateUpstream, type ValidatedUpstream } from "./upstreamPolicy.js";

export type ConnectionDto = Readonly<{
  id: string;
  serverUrl: string;
  serverId: string;
  serverName: string;
  jellyfinUserId: string;
  jellyfinUsername: string;
  kind: "personal" | "community";
  createdAt: string;
  updatedAt: string;
}>;
type ConnectionRecord = ConnectionDto & { discordUserId: string; encryptedAccessToken: string; loginDeviceId: string; communityGuildId: string };
export type ResolvedConnection = ConnectionDto & { accessToken: string; target: ValidatedUpstream };
export type ConnectionRevocation = { connectionId: string; discordUserId: string };
const revocationListeners = new Set<(event: ConnectionRevocation) => void>();

export function onConnectionsRevoked(listener: (event: ConnectionRevocation) => void): () => void {
  revocationListeners.add(listener);
  return () => { revocationListeners.delete(listener); };
}

function revoked(record: ConnectionRecord): void {
  for (const listener of revocationListeners) listener({ connectionId: record.id, discordUserId: record.discordUserId });
}

export class ConnectionError extends Error {
  constructor(readonly code: string, readonly publicMessage: string, readonly statusCode = 400) { super(code); }
}

/** Each short transaction uses its own connection. No asynchronous read/modify/write race. */
export class JellyfinConnectionStore {
  constructor(private readonly env: AppEnv) {}

  list(discordUserId: string, guildId?: string): ConnectionDto[] {
    return this.withDb((db) => db.prepare("SELECT * FROM connections WHERE discord_user_id = ? ORDER BY created_at, id")
      .all(discordUserId).map(fromRow).filter((record) => record.kind === "personal" || record.communityGuildId === guildId)
      .map(publicConnection));
  }

  get(discordUserId: string, connectionId: string): ConnectionRecord | undefined {
    return this.withDb((db) => {
      const row = db.prepare("SELECT * FROM connections WHERE discord_user_id = ? AND id = ?").get(discordUserId, connectionId);
      return row ? fromRow(row) : undefined;
    });
  }

  save(input: Omit<ConnectionRecord, "id" | "createdAt" | "updatedAt" | "communityGuildId">, guildId?: string): ConnectionDto {
    let previous: ConnectionRecord | undefined;
    const result = this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const scope = input.kind === "community" ? guildId ?? "" : "";
        const row = db.prepare("SELECT * FROM connections WHERE discord_user_id = ? AND server_url = ? AND kind = ? AND community_guild_id = ?")
          .get(input.discordUserId, input.serverUrl, input.kind, scope);
        previous = row ? fromRow(row) : undefined;
        const count = db.prepare("SELECT COUNT(*) AS count FROM connections WHERE discord_user_id = ?").get(input.discordUserId);
        if (!previous && Number(count?.count) >= 20) throw new ConnectionError("connection_limit", "Disconnect an unused server before adding another.", 409);
        const now = new Date().toISOString();
        const record: ConnectionRecord = { ...input, id: previous?.id ?? generateId(), createdAt: previous?.createdAt ?? now,
          updatedAt: now, communityGuildId: scope };
        db.prepare(`INSERT INTO connections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(discord_user_id, server_url, kind, community_guild_id) DO UPDATE SET
            server_id=excluded.server_id, server_name=excluded.server_name, jellyfin_user_id=excluded.jellyfin_user_id,
            jellyfin_username=excluded.jellyfin_username, encrypted_access_token=excluded.encrypted_access_token,
            login_device_id=excluded.login_device_id, updated_at=excluded.updated_at, community_guild_id=excluded.community_guild_id`)
          .run(record.id, record.discordUserId, record.serverUrl, record.serverId, record.serverName,
            record.jellyfinUserId, record.jellyfinUsername, record.encryptedAccessToken, record.loginDeviceId,
            record.kind, record.createdAt, record.updatedAt, record.communityGuildId);
        putPreference(db, input.discordUserId, guildId ?? "", record.id);
        db.exec("COMMIT");
        return publicConnection(record);
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    if (previous) revoked(previous);
    return result;
  }

  remove(discordUserId: string, connectionId: string): ConnectionRecord | undefined {
    const result = this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT * FROM connections WHERE discord_user_id = ? AND id = ?").get(discordUserId, connectionId);
        db.prepare("DELETE FROM connections WHERE discord_user_id = ? AND id = ?").run(discordUserId, connectionId);
        db.exec("COMMIT");
        return row ? fromRow(row) : undefined;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    if (result) revoked(result);
    return result;
  }

  preferred(discordUserId: string, guildId?: string): string | null {
    return this.withDb((db) => {
      const row = db.prepare("SELECT connection_id FROM preferences WHERE discord_user_id = ? AND guild_id = ?")
        .get(discordUserId, guildId ?? "");
      return typeof row?.connection_id === "string" ? row.connection_id : null;
    });
  }

  setPreferred(discordUserId: string, guildId: string | undefined, connectionId: string): void {
    this.withDb((db) => {
      const owned = db.prepare("SELECT id, kind, community_guild_id FROM connections WHERE discord_user_id = ? AND id = ?").get(discordUserId, connectionId);
      if (!owned) throw notFound();
      if (owned.kind === "community" && owned.community_guild_id !== guildId) throw notFound();
      putPreference(db, discordUserId, guildId ?? "", connectionId);
    });
  }

  private withDb<T>(operation: (db: DatabaseSync) => T): T {
    const databasePath = this.env.DATABASE_URL.startsWith("file:") ? this.env.DATABASE_URL.slice(5) : this.env.DATABASE_URL;
    const filename = path.join(path.dirname(databasePath), "jellyfin-connections.sqlite");
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(filename, { timeout: 5000 });
    try {
      chmodSync(filename, 0o600);
      db.exec(`PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS connections (
          id TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL, server_url TEXT NOT NULL,
          server_id TEXT NOT NULL, server_name TEXT NOT NULL, jellyfin_user_id TEXT NOT NULL,
          jellyfin_username TEXT NOT NULL, encrypted_access_token TEXT NOT NULL, login_device_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('personal','community')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          community_guild_id TEXT NOT NULL,
          UNIQUE(discord_user_id, server_url, kind, community_guild_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS preferences (
          discord_user_id TEXT NOT NULL, guild_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
          PRIMARY KEY(discord_user_id, guild_id)
        ) STRICT;`);
      return operation(db);
    } finally { db.close(); }
  }
}

function putPreference(db: DatabaseSync, userId: string, guildId: string, connectionId: string): void {
  db.prepare(`INSERT INTO preferences VALUES (?, ?, ?) ON CONFLICT(discord_user_id, guild_id)
    DO UPDATE SET connection_id=excluded.connection_id`).run(userId, guildId, connectionId);
}

function fromRow(row: Record<string, unknown>): ConnectionRecord {
  return { id: String(row.id), discordUserId: String(row.discord_user_id), serverUrl: String(row.server_url),
    serverId: String(row.server_id), serverName: String(row.server_name), jellyfinUserId: String(row.jellyfin_user_id),
    jellyfinUsername: String(row.jellyfin_username), encryptedAccessToken: String(row.encrypted_access_token),
    loginDeviceId: String(row.login_device_id), kind: row.kind as "personal" | "community",
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    communityGuildId: String(row.community_guild_id) };
}

function publicConnection(record: ConnectionRecord): ConnectionDto {
  const { discordUserId: _owner, encryptedAccessToken: _token, loginDeviceId: _device, communityGuildId: _guild, ...dto } = record;
  return dto;
}

export function setPreferredConnection(env: AppEnv, userId: string, guildId: string | undefined, connectionId: string): void {
  new JellyfinConnectionStore(env).setPreferred(userId, guildId, connectionId);
}

const serverInfoSchema = z.object({ Id: z.string().min(1).max(128), ServerName: z.string().min(1).max(200), Version: z.string().min(1).max(100) });
type ServerIdentity = z.infer<typeof serverInfoSchema>;
const authSchema = z.object({ User: z.object({ Id: z.string().min(1).max(128), Name: z.string().min(1).max(200) }),
  AccessToken: z.string().min(1).max(4096), ServerId: z.string().min(1).max(128) });

async function identifyServer(target: ValidatedUpstream): Promise<ServerIdentity> {
  const response = await upstreamFetch(target, "/System/Info/Public", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) { await response.body?.cancel(); throw new ConnectionError("not_jellyfin_server", "This address did not return Jellyfin server information.", 502); }
  const parsed = serverInfoSchema.safeParse(await readUpstreamJson(response));
  if (!parsed.success) throw new ConnectionError("not_jellyfin_server", "This address did not return Jellyfin server information.", 502);
  return parsed.data;
}

export function jellyfinClientHeader(deviceId: string, accessToken?: string): string {
  const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const fields = { Client: "Jellyfin Watch", Device: "Discord Activity", DeviceId: deviceId, Version: "0.2.0",
    ...(accessToken ? { Token: accessToken } : {}) };
  return `MediaBrowser ${Object.entries(fields).map(([key, value]) => `${key}="${escape(value)}"`).join(", ")}`;
}

export async function connectWithPassword(env: AppEnv, session: AppSession,
  input: { serverUrl: string; username: string; password: string }, kind: "personal" | "community" = "personal"): Promise<ConnectionDto> {
  const target = await validateUpstream(env, input.serverUrl);
  const server = await identifyServer(target); // Never send a password before validating destination and identity.
  const deviceId = `jellyfin-watch-login-${generateId()}`;
  const response = await upstreamFetch(target, "/Users/AuthenticateByName", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Emby-Authorization": jellyfinClientHeader(deviceId) },
    body: JSON.stringify({ Username: input.username, Pw: input.password }), signal: AbortSignal.timeout(15_000)
  });
  return saveAuthentication(env, session, target, server, deviceId, response, kind);
}

async function saveAuthentication(env: AppEnv, session: AppSession, target: ValidatedUpstream, server: ServerIdentity,
  deviceId: string, response: Response, kind: "personal" | "community", beforeSave?: () => void): Promise<ConnectionDto> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConnectionError("jellyfin_login_failed", response.status === 401 ? "Jellyfin rejected those credentials." : "Could not sign in to Jellyfin.", response.status === 401 ? 401 : 502);
  }
  const parsed = authSchema.safeParse(await readUpstreamJson(response));
  if (!parsed.success || parsed.data.ServerId !== server.Id) {
    throw new ConnectionError("jellyfin_identity_changed", "The Jellyfin server identity changed. Check its URL and try again.", 409);
  }
  let connection: ConnectionDto;
  let previous: ConnectionRecord | undefined;
  try {
    if (!sessionStore.getSession(session.id)) throw new ConnectionError("invalid_app_session", "Open the Activity again before connecting.", 401);
    beforeSave?.();
    const store = new JellyfinConnectionStore(env);
    const existing = store.list(session.discordUserId, session.discordContext?.guildId)
      .find((candidate) => candidate.serverUrl === target.serverUrl && candidate.kind === kind);
    previous = existing ? store.get(session.discordUserId, existing.id) : undefined;
    connection = store.save({ discordUserId: session.discordUserId,
      serverUrl: target.serverUrl, serverId: server.Id, serverName: server.ServerName,
      jellyfinUserId: parsed.data.User.Id, jellyfinUsername: parsed.data.User.Name,
      encryptedAccessToken: encryptString(env, parsed.data.AccessToken), loginDeviceId: deviceId, kind }, session.discordContext?.guildId);
  } catch (error) {
    await logoutToken(target, deviceId, parsed.data.AccessToken);
    throw error;
  }
  if (previous?.serverId === server.Id) {
    const oldToken = decryptString(env, previous.encryptedAccessToken);
    if (oldToken !== parsed.data.AccessToken) await logoutToken(target, previous.loginDeviceId, oldToken);
  }
  return connection;
}

async function logoutToken(target: ValidatedUpstream, deviceId: string, accessToken: string): Promise<boolean> {
  try {
    const response = await upstreamFetch(target, "/Sessions/Logout", { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { Authorization: jellyfinClientHeader(deviceId, accessToken) } });
    await response.body?.cancel();
    return response.ok || response.status === 401;
  } catch { return false; }
}

export function communityAvailable(env: AppEnv, session: AppSession): boolean {
  return env.JELLYFIN_AUTH_MODE === "shared" && Boolean(env.JELLYFIN_SHARED_USERNAME && env.JELLYFIN_SHARED_PASSWORD
    && session.discordContext?.guildId && env.DISCORD_ALLOWED_GUILD_IDS.split(",").map((id) => id.trim()).includes(session.discordContext.guildId));
}

export async function connectCommunity(env: AppEnv, session: AppSession): Promise<ConnectionDto> {
  if (!communityAvailable(env, session)) throw new ConnectionError("community_account_unavailable", "This community has no shared Jellyfin account.", 403);
  return connectWithPassword(env, session, { serverUrl: env.JELLYFIN_DEFAULT_SERVER_URL,
    username: env.JELLYFIN_SHARED_USERNAME, password: env.JELLYFIN_SHARED_PASSWORD }, "community");
}

function ownedConnection(env: AppEnv, discordUserId: string, connectionId: string, guildId?: string): ConnectionRecord {
  const record = new JellyfinConnectionStore(env).get(discordUserId, connectionId);
  if (!record) throw notFound();
  if (record.kind === "community" && (record.communityGuildId !== guildId
    || env.JELLYFIN_AUTH_MODE !== "shared"
    || !env.DISCORD_ALLOWED_GUILD_IDS.split(",").map((id) => id.trim()).includes(guildId ?? ""))) throw notFound();
  return record;
}

/** Call immediately before publishing a native capability after asynchronous work.
 * A disconnect or relink must not resurrect an already-resolved old credential.
 */
export function assertConnectionCurrent(env: AppEnv, discordUserId: string, connection: ResolvedConnection, guildId?: string): void {
  const record = ownedConnection(env, discordUserId, connection.id, guildId);
  if (record.serverUrl !== connection.serverUrl || record.serverId !== connection.serverId
    || record.jellyfinUserId !== connection.jellyfinUserId || record.updatedAt !== connection.updatedAt
    || decryptString(env, record.encryptedAccessToken) !== connection.accessToken) throw notFound();
}

export async function resolveConnection(env: AppEnv, discordUserId: string, connectionId: string, guildId?: string): Promise<ResolvedConnection> {
  const record = ownedConnection(env, discordUserId, connectionId, guildId);
  const target = await validateUpstream(env, record.serverUrl);
  const identity = await identifyServer(target);
  if (identity.Id !== record.serverId) {
    revoked(record);
    throw new ConnectionError("jellyfin_identity_changed", "The saved server identity changed. Disconnect it and check its URL.", 409);
  }
  const resolved = { ...publicConnection(record), accessToken: decryptString(env, record.encryptedAccessToken), target };
  assertConnectionCurrent(env, discordUserId, resolved, guildId);
  return resolved;
}

export async function disconnectConnection(env: AppEnv, discordUserId: string, connectionId: string): Promise<{ ok: true; upstreamRevoked: boolean }> {
  const record = new JellyfinConnectionStore(env).remove(discordUserId, connectionId);
  if (!record) throw notFound();
  let upstreamRevoked = false;
  try {
    const target = await validateUpstream(env, record.serverUrl);
    const identity = await identifyServer(target);
    if (identity.Id !== record.serverId) return { ok: true, upstreamRevoked: false };
    upstreamRevoked = await logoutToken(target, record.loginDeviceId, decryptString(env, record.encryptedAccessToken));
  } catch { /* Local capabilities are already revoked, even if the server is unavailable. */ }
  return { ok: true, upstreamRevoked };
}

type QuickConnectResult = { status: "pending" } | { status: "connected"; connection: ConnectionDto };
type PendingQuickConnect = { appSessionId: string; discordUserId: string; serverUrl: string; server: ServerIdentity;
  deviceId: string; secret: string; code: string; expiresAt: number; lastPoll: number;
  pending?: Promise<QuickConnectResult>; result?: QuickConnectResult };

export class QuickConnectManager {
  private readonly requests = new Map<string, PendingQuickConnect>();
  private readonly unsubscribe: () => void;
  constructor(private readonly env: AppEnv) {
    this.unsubscribe = sessionStore.onRevoke((id) => {
      for (const [key, request] of this.requests) if (request.appSessionId === id) this.requests.delete(key);
    });
  }
  dispose(): void { this.unsubscribe(); this.requests.clear(); }

  async start(session: AppSession, serverUrl: string): Promise<{ id: string; code: string; expiresAt: string }> {
    this.prune();
    if (this.requests.size >= 1000) throw new ConnectionError("quick_connect_busy", "Try Quick Connect again shortly.", 429);
    for (const [id, request] of this.requests) if (request.appSessionId === session.id) this.requests.delete(id);
    const target = await validateUpstream(this.env, serverUrl);
    const server = await identifyServer(target);
    const deviceId = `jellyfin-watch-login-${generateId()}`;
    const response = await upstreamFetch(target, "/QuickConnect/Initiate", { method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { "X-Emby-Authorization": jellyfinClientHeader(deviceId) } });
    if (!response.ok) { await response.body?.cancel(); throw new ConnectionError("quick_connect_unavailable", "Quick Connect is not available on this server.", 409); }
    const parsed = z.object({ Secret: z.string().min(1).max(4096), Code: z.string().regex(/^\d{4,10}$/) }).safeParse(await readUpstreamJson(response));
    if (!parsed.success) throw new ConnectionError("quick_connect_unavailable", "The server returned invalid Quick Connect data.", 502);
    if (!sessionStore.getSession(session.id)) throw new ConnectionError("invalid_app_session", "Open the Activity again before connecting.", 401);
    const id = generateId();
    const expiresAt = Math.min(Date.now() + 5 * 60_000, session.expiresAt.getTime());
    this.requests.set(id, { appSessionId: session.id, discordUserId: session.discordUserId, serverUrl: target.serverUrl,
      server, deviceId, secret: parsed.data.Secret, code: parsed.data.Code, expiresAt, lastPoll: 0 });
    return { id, code: parsed.data.Code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async poll(session: AppSession, id: string): Promise<QuickConnectResult> {
    this.prune();
    const request = this.requests.get(id);
    if (!request || request.appSessionId !== session.id || request.discordUserId !== session.discordUserId) throw notFound();
    if (request.result) return request.result;
    if (request.pending) return request.pending;
    if (Date.now() - request.lastPoll < 2000) return { status: "pending" };
    request.lastPoll = Date.now();
    const operation = this.complete(session, id, request).then((result) => {
      if (result.status === "connected") { request.result = result; request.secret = ""; }
      return result;
    }).finally(() => { delete request.pending; });
    request.pending = operation;
    return operation;
  }

  private async complete(session: AppSession, id: string, request: PendingQuickConnect): Promise<QuickConnectResult> {
    const requireCurrent = () => {
      if (this.requests.get(id) !== request || request.expiresAt <= Date.now() || !sessionStore.getSession(session.id)) {
        throw new ConnectionError("quick_connect_expired", "Quick Connect expired. Start again.", 410);
      }
    };
    const target = await validateUpstream(this.env, request.serverUrl);
    const identity = await identifyServer(target);
    if (identity.Id !== request.server.Id) throw new ConnectionError("jellyfin_identity_changed", "The Jellyfin server identity changed.", 409);
    requireCurrent();
    const response = await upstreamFetch(target, `/QuickConnect/Connect?Secret=${encodeURIComponent(request.secret)}`, {
      headers: { "X-Emby-Authorization": jellyfinClientHeader(request.deviceId) }, signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) { await response.body?.cancel(); throw new ConnectionError("quick_connect_expired", "Quick Connect expired. Start again.", 410); }
    const state = z.object({ Authenticated: z.boolean() }).safeParse(await readUpstreamJson(response));
    if (!state.success) throw new ConnectionError("quick_connect_unavailable", "The server returned invalid Quick Connect data.", 502);
    if (!state.data.Authenticated) return { status: "pending" };
    requireCurrent();
    const authenticated = await upstreamFetch(target, "/Users/AuthenticateWithQuickConnect", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Emby-Authorization": jellyfinClientHeader(request.deviceId) },
      body: JSON.stringify({ Secret: request.secret }), signal: AbortSignal.timeout(15_000)
    });
    const connection = await saveAuthentication(this.env, session, target, request.server, request.deviceId, authenticated, "personal", requireCurrent);
    return { status: "connected", connection };
  }

  private prune(): void {
    for (const [id, request] of this.requests) {
      if (request.expiresAt <= Date.now() || !sessionStore.getSession(request.appSessionId)) this.requests.delete(id);
    }
  }
}

export function suggestedServerUrl(env: AppEnv): string { return normalizeUpstreamUrl(env.JELLYFIN_DEFAULT_SERVER_URL); }
function notFound(): ConnectionError { return new ConnectionError("connection_not_found", "This saved connection was not found.", 404); }
