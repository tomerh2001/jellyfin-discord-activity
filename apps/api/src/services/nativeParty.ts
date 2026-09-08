import { createHash, randomBytes } from "node:crypto";
import type { DiscordContext } from "@app/shared";
import type { FastifyInstance } from "fastify";
import type { AppEnv } from "../env.js";
import { renewActivityMembership } from "./appSession.js";
import { sessionStore, type AppSession } from "./sessionStore.js";
import { assertConnectionCurrent, onConnectionsRevoked, resolveConnection } from "./jellyfinConnections.js";
import { readUpstreamJson, upstreamFetch } from "./upstreamPolicy.js";

export type NativeConnection = Awaited<ReturnType<typeof resolveConnection>>;
export type NativeParty = {
  id: string;
  context: DiscordContext;
  instanceId: string;
  guildId?: string;
  channelId?: string;
  serverId: string;
  serverUrl: string;
  groupId: string;
  control: NativeIdentity;
  viewers: Set<string>;
  currentPlaylistItemId?: string;
  queueItemIds: string[];
  emptySince: number;
};
export type NativeIdentity = { connection: NativeConnection; deviceId: string };
export type NativeViewer = NativeIdentity & {
  capability: string;
  partyId: string;
  appSessionId: string;
  discordUserId: string;
  clientDeviceId: string;
  expiresAt: number;
  lastSeen: number;
  sockets: number;
  joined: boolean;
  revoked: boolean;
  aborters: Set<() => void>;
  lastSocketClose: number;
  itemAccess: Map<string, { until: number; sources: Set<string> }>;
  socketOpening: boolean;
  socketCleanup?: Promise<void>;
};
export type NativePartyDependencies = {
  resolve: typeof resolveConnection;
  fetch: typeof upstreamFetch;
  membership: typeof renewActivityMembership;
  current: typeof assertConnectionCurrent;
};
const CLIENT = "Jellyfin Discord Activity";
const EMPTY_GRACE_MS = 30_000;
const LAUNCH_GRACE_MS = 120_000;
const services = new WeakMap<object, NativePartyService>();

export class NativeError extends Error {
  constructor(readonly code: string, readonly statusCode = 403) { super(code); }
}

/** The only Jellyfin credential header emitted by this application. */
export function nativeAuthorization(identity: NativeIdentity): string {
  const quote = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `MediaBrowser Client="${CLIENT}", Device="Discord Activity", DeviceId="${quote(identity.deviceId)}", Version="1.0.0", Token="${quote(identity.connection.accessToken)}"`;
}

export function nativeSessionId(identity: NativeIdentity): string {
  // Jellyfin BaseExtensions.GetMD5: UTF-16LE -> MD5 -> new Guid(bytes).ToString("N").
  const bytes = createHash("md5").update(CLIENT + identity.deviceId, "utf16le").digest();
  return Buffer.concat([bytes.subarray(0, 4).reverse(), bytes.subarray(4, 6).reverse(), bytes.subarray(6, 8).reverse(), bytes.subarray(8)]).toString("hex");
}

export function publicNativeParty(party: NativeParty | undefined) {
  if (!party) return null;
  return {
    id: party.id, instanceId: party.instanceId,
    ...(party.guildId ? { guildId: party.guildId } : {}),
    ...(party.channelId ? { channelId: party.channelId } : {}),
    serverId: party.serverId, serverUrl: party.serverUrl, groupId: party.groupId
  };
}

export function getNativePartyService(app: FastifyInstance): NativePartyService {
  let service = services.get(app.server);
  if (!service) {
    service = new NativePartyService(app.envConfig);
    services.set(app.server, service);
    const created = service;
    app.addHook("onClose", async () => { await created.close(); services.delete(app.server); });
  }
  return service;
}

/** Native SyncPlay owns all playback state. These maps only bind authorization and lifecycle. */
export class NativePartyService {
  readonly parties = new Map<string, NativeParty>();
  readonly viewers = new Map<string, NativeViewer>();
  private readonly bindings = new Map<string, string>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeConnections: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private sweeping = false;
  private closed = false;
  readonly dependencies: NativePartyDependencies;

  constructor(readonly env: AppEnv, dependencies?: Partial<NativePartyDependencies>) {
    this.dependencies = { resolve: resolveConnection, fetch: upstreamFetch, membership: renewActivityMembership, current: assertConnectionCurrent, ...dependencies };
    this.unsubscribe = sessionStore.onRevoke((id) => { void this.revokeSession(id); });
    this.unsubscribeConnections = onConnectionsRevoked(({ discordUserId, connectionId }) => { void this.revokeConnection(discordUserId, connectionId); });
    this.timer = setInterval(() => { void this.sweep(); }, 5_000);
    this.timer.unref();
  }

  private key(session: AppSession): string {
    const c = session.discordContext;
    if (!c) throw new NativeError("activity_context_required");
    return JSON.stringify([c.guildId ?? "", c.channelId ?? "", c.instanceId]);
  }

  get(session: AppSession): NativeParty | undefined {
    const id = this.bindings.get(this.key(session));
    return id ? this.parties.get(id) : undefined;
  }

  getPartyForChannel(guildId: string, channelId: string): NativeParty | undefined {
    return [...this.parties.values()].find((party) => party.guildId === guildId && party.channelId === channelId);
  }

  getViewerForDiscordUser(partyId: string, userId: string): NativeViewer | undefined {
    return [...this.viewers.values()].find((viewer) => viewer.partyId === partyId && viewer.discordUserId === userId
      && viewer.sockets > 0 && viewer.joined && this.active(viewer));
  }

  async bind(session: AppSession, connectionId: string): Promise<NativeParty> {
    const key = this.key(session);
    return this.serial(key, async () => {
      await this.verifySession(session);
      const connection = await this.dependencies.resolve(this.env, session.discordUserId, connectionId, session.discordContext?.guildId);
      this.dependencies.current(this.env, session.discordUserId, connection, session.discordContext?.guildId);
      const existing = this.get(session);
      if (existing && existing.serverUrl === connection.serverUrl && existing.serverId === connection.serverId) return existing;
      // Resolve and authenticate the replacement before disturbing the current party.
      const identity = { connection, deviceId: `activity-control-${randomBytes(16).toString("hex")}` };
      const created = await this.json(identity, "POST", "/SyncPlay/New", { GroupName: "Discord watch party" }) as { GroupId?: string };
      if (!created?.GroupId || !/^[a-f0-9-]{32,36}$/i.test(created.GroupId)) throw new NativeError("invalid_syncplay_group", 502);
      try { await this.json(identity, "POST", "/SyncPlay/SetIgnoreWait", { IgnoreWait: true }); }
      catch (error) { await this.leaveIdentity(identity); throw error; }
      if (!sessionStore.getSession(session.id) || this.closed) {
        await this.leaveIdentity(identity);
        throw new NativeError("native_session_expired", 401);
      }
      try {
        if (existing) await this.destroyParty(existing);
        this.dependencies.current(this.env, session.discordUserId, connection, session.discordContext?.guildId);
        if (!sessionStore.getSession(session.id) || this.closed) throw new NativeError("native_session_expired", 401);
      } catch (error) { await this.leaveIdentity(identity); throw error; }
      const context = session.discordContext!;
      const party: NativeParty = {
        id: randomBytes(16).toString("hex"), context, instanceId: context.instanceId,
        ...(context.guildId ? { guildId: context.guildId } : {}),
        ...(context.channelId ? { channelId: context.channelId } : {}),
        serverId: connection.serverId, serverUrl: connection.serverUrl, groupId: created.GroupId,
        control: identity, viewers: new Set(), emptySince: Date.now() + LAUNCH_GRACE_MS, queueItemIds: []
      };
      this.parties.set(party.id, party);
      this.bindings.set(key, party.id);
      return party;
    });
  }

  async launch(session: AppSession, connectionId: string, clientDeviceId: string) {
    // Binding changes and launches for every viewer share the same party lock.
    return this.serial(this.key(session), async () => {
      await this.verifySession(session);
      const party = this.get(session);
      if (!party) throw new NativeError("party_not_bound", 409);
      const connection = await this.dependencies.resolve(this.env, session.discordUserId, connectionId, session.discordContext?.guildId);
      this.dependencies.current(this.env, session.discordUserId, connection, session.discordContext?.guildId);
      if (party.serverId !== connection.serverId || party.serverUrl !== connection.serverUrl) throw new NativeError("party_server_mismatch", 409);
      const replaced = [...this.viewers.values()].filter((viewer) => viewer.partyId === party.id
        && viewer.appSessionId === session.id && viewer.clientDeviceId === clientDeviceId);
      if (party.viewers.size - replaced.length >= this.env.ROOM_MAX_PARTICIPANTS) throw new NativeError("party_full", 409);
      for (const viewer of this.viewers.values()) {
        if (viewer.appSessionId === session.id && viewer.clientDeviceId === clientDeviceId) await this.revoke(viewer);
      }
      if (this.get(session)?.id !== party.id || !sessionStore.getSession(session.id)) throw new NativeError("party_binding_changed", 409);
      this.dependencies.current(this.env, session.discordUserId, connection, session.discordContext?.guildId);
      const capability = randomBytes(32).toString("base64url");
      const deviceId = `activity-viewer-${randomBytes(16).toString("hex")}`;
      const viewer: NativeViewer = {
        connection, deviceId, capability, partyId: party.id, appSessionId: session.id,
        discordUserId: session.discordUserId, clientDeviceId, expiresAt: session.expiresAt.getTime(),
        lastSeen: Date.now(), sockets: 0, joined: false, revoked: false, aborters: new Set(), lastSocketClose: 0, itemAccess: new Map(), socketOpening: false
      };
      this.viewers.set(capability, viewer);
      party.viewers.add(capability);
      party.emptySince = 0;
      return { baseUrl: `/jf/${capability}`, accessToken: capability, userId: connection.jellyfinUserId,
        serverId: connection.serverId, deviceId, groupId: party.groupId };
    });
  }

  async authorize(capability: string, touch = true): Promise<NativeViewer> {
    const viewer = this.viewers.get(capability);
    if (!viewer || !this.active(viewer)) throw new NativeError("native_session_expired", 401);
    const session = sessionStore.getSession(viewer.appSessionId)!;
    try { await this.dependencies.membership(this.env, session); }
    catch { await this.revoke(viewer); throw new NativeError("native_session_expired", 401); }
    if (!this.active(viewer)) throw new NativeError("native_session_expired", 401);
    if (touch) viewer.lastSeen = Date.now();
    return viewer;
  }

  active(viewer: NativeViewer): boolean {
    return !viewer.revoked && viewer.expiresAt > Date.now() && !!sessionStore.getSession(viewer.appSessionId)
      && this.parties.get(viewer.partyId)?.viewers.has(viewer.capability) === true;
  }

  async verifySession(session: AppSession): Promise<void> {
    if (!sessionStore.getSession(session.id)) throw new NativeError("native_session_expired", 401);
    await this.dependencies.membership(this.env, session);
    if (!sessionStore.getSession(session.id)) throw new NativeError("native_session_expired", 401);
  }

  /** Abort sockets and transfers synchronously, then explicitly leave the native group. */
  async revoke(viewer: NativeViewer): Promise<void> {
    if (viewer.revoked) return;
    viewer.revoked = true;
    this.viewers.delete(viewer.capability);
    const party = this.parties.get(viewer.partyId);
    party?.viewers.delete(viewer.capability);
    if (party && !party.viewers.size) party.emptySince = Date.now();
    for (const abort of [...viewer.aborters]) abort();
    viewer.aborters.clear();
    const cleanup = this.leaveIdentity(viewer);
    viewer.socketCleanup = cleanup;
    await cleanup;
    viewer.joined = false;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await Promise.all([...this.viewers.values()].filter((v) => v.appSessionId === sessionId).map((v) => this.revoke(v)));
  }

  async revokeConnection(discordUserId: string, connectionId: string): Promise<void> {
    const parties = [...this.parties.values()].filter((party) => party.control.connection.id === connectionId);
    const cleanup = parties.map((party) => this.destroyParty(party));
    const viewers = [...this.viewers.values()].filter((v) => v.discordUserId === discordUserId && v.connection.id === connectionId);
    await Promise.all([...cleanup, ...viewers.map((v) => this.revoke(v))]);
  }

  async socketDisconnected(viewer: NativeViewer): Promise<void> {
    viewer.sockets = Math.max(0, viewer.sockets - 1);
    if (viewer.sockets || viewer.revoked) return;
    // Do not wait for Jellyfin 10.11's lost-WebSocket session timeout. The native
    // group must stop waiting for this participant even after a mobile network drop.
    viewer.lastSeen = Date.now();
    viewer.lastSocketClose = Date.now();
    viewer.joined = false;
    const cleanup = this.leaveIdentity(viewer);
    viewer.socketCleanup = cleanup;
    await cleanup;
  }

  private async leaveIdentity(identity: NativeIdentity): Promise<void> {
    try { await this.json(identity, "POST", "/SyncPlay/Leave"); }
    catch { /* Token revocation or an already-ended upstream session needs no retry. */ }
  }

  async json(identity: NativeIdentity, method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.dependencies.fetch(identity.connection.target, path, {
        method, headers: { Authorization: nativeAuthorization(identity), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000)
      });
    } catch { throw new NativeError("jellyfin_unavailable", 502); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 && path === "/SyncPlay/New") throw new NativeError("syncplay_create_not_allowed", 403);
      throw new NativeError("jellyfin_request_failed", response.status === 401 ? 401 : 502);
    }
    if (response.status === 204 || response.headers.get("content-length") === "0") return null;
    try { return await readUpstreamJson(response, 16 * 1024 * 1024); }
    catch { throw new NativeError("jellyfin_invalid_response", 502); }
  }

  async execute(viewer: NativeViewer, method: string, path: string, body?: unknown): Promise<unknown> {
    await this.authorize(viewer.capability);
    return this.json(viewer, method, path, body);
  }

  async requireItem(viewer: NativeViewer, itemId: string, mediaSourceId?: string): Promise<void> {
    if (!/^[a-f0-9-]{32,36}$/i.test(itemId)) throw new NativeError("native_item_denied");
    let access = viewer.itemAccess.get(itemId);
    if (!access || access.until < Date.now()) {
      let item: { Id?: string; MediaSources?: Array<{ Id?: string }> };
      try {
        item = await this.json(viewer, "GET", `/Users/${viewer.connection.jellyfinUserId}/Items/${itemId}?Fields=MediaSources`) as typeof item;
      } catch { throw new NativeError("native_item_denied"); }
      if (!item?.Id || item.Id.replaceAll("-", "").toLowerCase() !== itemId.replaceAll("-", "").toLowerCase()) throw new NativeError("native_item_denied");
      access = { until: Date.now() + 30_000, sources: new Set([item.Id, ...(item.MediaSources ?? []).flatMap((source) => source.Id ? [source.Id] : [])]) };
      if (viewer.itemAccess.size >= 500) viewer.itemAccess.clear();
      viewer.itemAccess.set(itemId, access);
    }
    if (mediaSourceId && !access.sources.has(mediaSourceId)) throw new NativeError("native_media_source_denied");
  }

  async requirePartyItems(viewer: NativeViewer, itemIds: string[]): Promise<void> {
    if (!itemIds.length || itemIds.length > 500) throw new NativeError("native_invalid_queue", 400);
    const party = this.parties.get(viewer.partyId);
    if (!party) throw new NativeError("native_session_expired", 401);
    const members = [...party.viewers].map((cap) => this.viewers.get(cap)).filter((v): v is NativeViewer => !!v && this.active(v));
    // Validate before invoking the one native mutation, so a denied member cannot
    // be silently dropped from a party when another participant selects media.
    for (const id of new Set(itemIds)) await Promise.all(members.map((member) => this.requireItem(member, id)));
  }

  async command(viewer: NativeViewer, action: "pause" | "play" | "seek" | "next" | "previous" | "stop" | "queue" | "select" | "search" | "now", payload?: { query?: string; seconds?: number; itemIds?: string[] }): Promise<unknown> {
    await this.authorize(viewer.capability);
    const party = this.parties.get(viewer.partyId)!;
    if (!viewer.joined || !viewer.sockets) throw new NativeError("native_player_not_connected", 409);
    if (action === "search") {
      const query = new URLSearchParams({ UserId: viewer.connection.jellyfinUserId, SearchTerm: payload?.query ?? "", Recursive: "true", IncludeItemTypes: "Movie,Episode,Audio,Video", Limit: "20" });
      return this.json(viewer, "GET", `/Items?${query}`);
    }
    if (action === "now") {
      const sessions = await this.json(viewer, "GET", `/Sessions?DeviceId=${encodeURIComponent(viewer.deviceId)}`) as Array<{ Id?: string; NowPlayingItem?: { Id?: string; Name?: string }; PlayState?: { PositionTicks?: number; IsPaused?: boolean } }>;
      const own = sessions.find((s) => s.Id === nativeSessionId(viewer));
      return { itemId: own?.NowPlayingItem?.Id, title: own?.NowPlayingItem?.Name, positionSeconds: (own?.PlayState?.PositionTicks ?? 0) / 10_000_000, isPaused: own?.PlayState?.IsPaused ?? true, groupId: party.groupId };
    }
    if (action === "seek") {
      if (!Number.isFinite(payload?.seconds) || payload!.seconds! < 0) throw new NativeError("invalid_position", 400);
      return this.json(viewer, "POST", "/SyncPlay/Seek", { PositionTicks: Math.round(payload!.seconds! * 10_000_000) });
    }
    if (action === "queue" || action === "select") {
      let ids = payload?.itemIds ?? [];
      if (action === "select" && ids.length === 1) {
        await this.requireItem(viewer, ids[0]!);
        const item = await this.json(viewer, "GET", `/Users/${viewer.connection.jellyfinUserId}/Items/${ids[0]}`) as { Type?: string; SeriesId?: string };
        // Match native Web's episode playback expansion so Discord-started episodes
        // retain the same Next/Previous queue controls as a library selection.
        if (item.Type === "Episode" && /^[a-f0-9-]{32,36}$/i.test(item.SeriesId ?? "")) {
          const query = new URLSearchParams({ UserId: viewer.connection.jellyfinUserId, IsVirtualUnaired: "false",
            IsMissing: "false", Limit: "100", StartItemId: ids[0]! });
          const result = await this.json(viewer, "GET", `/Shows/${item.SeriesId}/Episodes?${query}`) as { Items?: Array<{ Id?: string }> };
          const episodes = (result.Items ?? []).flatMap((entry) => entry.Id && /^[a-f0-9-]{32,36}$/i.test(entry.Id) ? [entry.Id] : []);
          const start = episodes.indexOf(ids[0]!);
          if (start >= 0) ids = episodes.slice(start);
        }
      }
      await this.requirePartyItems(viewer, ids);
      await this.authorize(viewer.capability);
      return action === "queue" ? this.json(viewer, "POST", "/SyncPlay/Queue", { ItemIds: ids, Mode: "Queue" })
        : this.json(viewer, "POST", "/SyncPlay/SetNewQueue", { PlayingQueue: ids, PlayingItemPosition: 0, StartPositionTicks: 0 });
    }
    if (action === "next" || action === "previous") {
      if (!party.currentPlaylistItemId) throw new NativeError("no_playing_item", 409);
      return this.json(viewer, "POST", `/SyncPlay/${action === "next" ? "NextItem" : "PreviousItem"}`, { PlaylistItemId: party.currentPlaylistItemId });
    }
    return this.json(viewer, "POST", `/SyncPlay/${{ pause: "Pause", play: "Unpause", stop: "Stop" }[action]}`);
  }

  observeMessage(viewer: NativeViewer, message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const event = message as { MessageType?: string; Data?: { GroupId?: string; Type?: string; Data?: { PlayingItemIndex?: number; Playlist?: Array<{ PlaylistItemId?: string; ItemId?: string }> } } };
    const party = this.parties.get(viewer.partyId);
    if (!party) return false;
    if (event.MessageType === "SyncPlayGroupUpdate" || event.MessageType === "SyncPlayCommand") {
      if (event.Data?.Type && ["LibraryAccessDenied", "NotInGroup", "GroupDoesNotExist"].includes(event.Data.Type)) {
        if (!event.Data.GroupId || event.Data.GroupId === party.groupId || /^0{32}$|^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(event.Data.GroupId)) {
          viewer.joined = false;
          return true;
        }
      }
      if (event.Data?.GroupId !== party.groupId) return false;
      if (event.Data?.Type === "GroupJoined") viewer.joined = true;
      if (event.Data?.Type === "PlayQueue") {
        const queue = event.Data.Data;
        party.queueItemIds = (queue?.Playlist ?? []).flatMap((item) => item.ItemId ? [item.ItemId] : []);
        const id = queue?.Playlist?.[queue?.PlayingItemIndex ?? -1]?.PlaylistItemId;
        if (id) party.currentPlaylistItemId = id;
        else delete party.currentPlaylistItemId;
      }
      return true;
    }
    return ["ForceKeepAlive", "KeepAlive", "UserDataChanged", "LibraryChanged", "ServerRestarting", "ServerShuttingDown"].includes(event.MessageType ?? "");
  }

  async sweep(): Promise<void> {
    if (this.sweeping || this.closed) return;
    this.sweeping = true;
    try {
      await Promise.all([...this.viewers.values()].map(async (viewer) => {
        if (!this.active(viewer) || (!viewer.sockets && ((viewer.lastSocketClose && Date.now() - viewer.lastSocketClose > EMPTY_GRACE_MS)
          || Date.now() - viewer.lastSeen > LAUNCH_GRACE_MS))) await this.revoke(viewer);
        else { try { await this.authorize(viewer.capability, false); } catch { await this.revoke(viewer); } }
      }));
      for (const party of [...this.parties.values()]) {
        if (!party.viewers.size && party.emptySince && Date.now() - party.emptySince > EMPTY_GRACE_MS) await this.destroyParty(party);
        else if (party.viewers.size) {
          // Keep the IgnoreWait control identity alive while viewers are connected.
          // A failed control ping means the group cannot be assumed usable anymore.
          try { await this.json(party.control, "POST", "/SyncPlay/Ping", { Ping: 0 }); }
          catch { await this.destroyParty(party); }
        }
      }
    } finally { this.sweeping = false; }
  }

  async destroyParty(party: NativeParty): Promise<void> {
    this.parties.delete(party.id);
    for (const [key, id] of this.bindings) if (id === party.id) this.bindings.delete(key);
    await Promise.all([...party.viewers].map((cap) => this.viewers.get(cap)).filter((v): v is NativeViewer => !!v).map((v) => this.revoke(v)));
    await this.leaveIdentity(party.control);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    this.unsubscribeConnections();
    await Promise.all([...this.parties.values()].map((party) => this.destroyParty(party)));
  }

  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key);
    const next = (previous?.catch(() => undefined) ?? Promise.resolve()).then(work);
    this.pending.set(key, next);
    try { return await next; }
    finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }
}
