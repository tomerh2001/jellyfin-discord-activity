import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityPlaybackIntent, ActivityPlaybackState } from "@app/shared";
import { NativePartyService, type NativeConnection, type NativeViewer } from "../services/nativeParty.js";
import { ActivityPlaybackCoordinator } from "../services/activityPlayback.js";
import { createAppSession } from "../services/appSession.js";
import { sessionStore, type AppSession } from "../services/sessionStore.js";
import { loadEnv } from "../env.js";

const ITEM = "11111111111111111111111111111111";
const OTHER = "22222222222222222222222222222222";
let service: NativePartyService;
let coordinator: ActivityPlaybackCoordinator;
let sessions: AppSession[];
let now: number;
let denied: Set<string>;
let playbackDenied: Set<string>;
let upstreamPaths: string[];

beforeEach(() => {
  sessions = []; now = Date.now(); denied = new Set(); playbackDenied = new Set(); upstreamPaths = [];
  const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", DATABASE_URL: "file:/tmp/unused-playback.db" });
  service = new NativePartyService(env, {
    resolve: vi.fn(async (_env, userId, connectionId) => ({ id: connectionId, serverId: "server", serverUrl: "https://fixture.invalid",
      serverName: "Fixture", jellyfinUserId: userId, jellyfinUsername: userId, kind: "personal", createdAt: "", updatedAt: "",
      accessToken: "fixture-token", target: {} } as NativeConnection)),
    current: vi.fn(), membership: vi.fn(async () => undefined),
    fetch: vi.fn(async (_target, path, options) => {
      upstreamPaths.push(path);
      const device = /DeviceId="([^"]+)"/.exec(String((options?.headers as Record<string, string>).Authorization))?.[1] ?? "";
      const owner = [...service.viewers.values()].find((viewer) => viewer.deviceId === device);
      if (path === "/Users/Me") return Response.json({ Policy: { EnableMediaPlayback: !playbackDenied.has(owner?.discordUserId ?? "") } });
      const item = /^\/Users\/([^/]+)\/Items\/([^?]+)/.exec(path);
      if (!item) throw new Error("Unexpected upstream request");
      if (denied.has(`${item[1]}:${item[2]}`)) return Response.json({}, { status: 403 });
      return Response.json({ Id: item[2], Name: "Fixture movie" });
    })
  });
  coordinator = new ActivityPlaybackCoordinator(service, () => now);
  Object.defineProperty(service, "playback", { value: coordinator });
});

afterEach(async () => {
  await service.close();
  for (const session of sessions) sessionStore.deleteSession(session.id);
});

async function viewer(id = "first", instanceId = "party") {
  const { session } = await createAppSession({ env: service.env, user: { id, username: id }, discordContext: { instanceId, guildId: "guild", channelId: "channel" } });
  sessions.push(session);
  await service.bind(session, `connection-${id}`);
  const launch = await service.launch(session, `connection-${id}`, randomUUID());
  const actor = service.viewers.get(launch.accessToken)!;
  return { actor, session, launch };
}

async function connect(actor: NativeViewer) {
  actor.sockets = 1;
  const states: ActivityPlaybackState[] = [];
  const unsubscribe = await coordinator.connect(actor, (state) => states.push(state));
  return { states, unsubscribe };
}

async function command(actor: NativeViewer, sequence: number, intent: ActivityPlaybackIntent, options: Record<string, unknown> = {}) {
  const { snapshot } = await coordinator.get(actor);
  return { ...intent, epoch: snapshot.epoch, id: `command-${sequence}`, sequence, expectedQueueRevision: snapshot.queueRevision, issuedAt: now, ...options };
}

const queue = (paused = false): ActivityPlaybackIntent => ({ type: "setQueue", queue: [{ id: "first-entry", itemId: ITEM }, { id: "second-entry", itemId: OTHER }], index: 0, positionTicks: 0, paused });

describe("Activity playback authority", () => {
  it("binds without creating upstream SyncPlay and immediately broadcasts a projected timeline", async () => {
    const first = (await viewer()).actor; const second = (await viewer("second")).actor;
    const a = await connect(first); const b = await connect(second);
    const result = await coordinator.submit(first, await command(first, 1, queue(), { issuedAt: now - 800 }));
    expect(result.snapshot).toMatchObject({ revision: 1, queueRevision: 1, positionTicks: 8_000_000, paused: false, serverTimeMs: now });
    expect(a.states.at(-1)?.ack?.id).toBe("command-1");
    expect(b.states.at(-1)?.ack).toBeUndefined();
    now += 400;
    expect((await coordinator.get(second)).snapshot.positionTicks).toBe(12_000_000);
    expect(upstreamPaths.some((path) => path.startsWith("/SyncPlay"))).toBe(false);
  });

  it("deduplicates retry acknowledgements and rejects conflicting IDs and reordered older intent", async () => {
    const actor = (await viewer()).actor; const events = await connect(actor);
    const start = await command(actor, 1, queue());
    await coordinator.submit(actor, start);
    const pause = await command(actor, 3, { type: "setPlayback", paused: true, positionTicks: 50 });
    await coordinator.submit(actor, pause);
    const count = events.states.length;
    const retry = await coordinator.submit(actor, pause);
    expect(retry.ack).toMatchObject({ duplicate: true, revision: 2 });
    expect(events.states).toHaveLength(count);
    await expect(coordinator.submit(actor, { ...pause, paused: false })).rejects.toMatchObject({ code: "activity_command_conflict" });
    await expect(coordinator.submit(actor, { ...pause, id: "older", sequence: 2, paused: false })).rejects.toMatchObject({ code: "activity_stale_sequence" });
    expect((await coordinator.get(actor)).snapshot).toMatchObject({ revision: 2, paused: true, positionTicks: 50 });
  });

  it("orders concurrent controls and preserves paused seeks without a buffering authority", async () => {
    const actor = (await viewer()).actor; await connect(actor);
    await coordinator.submit(actor, await command(actor, 1, queue()));
    const play = await command(actor, 2, { type: "setPlayback", paused: false, positionTicks: 100 });
    const pause = { ...play, id: "pause", sequence: 3, paused: true, positionTicks: 200 };
    const seek = { ...pause, id: "seek", sequence: 4, type: "seek", positionTicks: 900 };
    await Promise.all([coordinator.submit(actor, play), coordinator.submit(actor, pause), coordinator.submit(actor, seek)]);
    now += 5000;
    expect((await coordinator.get(actor)).snapshot).toMatchObject({ revision: 4, paused: true, positionTicks: 900 });
    await expect(coordinator.submit(actor, { ...seek, type: "buffering", id: "buffer", sequence: 5 })).rejects.toMatchObject({ code: "activity_invalid_command" });
  });

  it("rejects simultaneous next/repeat end events against their selection generation", async () => {
    const first = (await viewer()).actor; const second = (await viewer("second")).actor;
    await connect(first); await connect(second);
    await coordinator.submit(first, await command(first, 1, queue()));
    const a = await command(first, 2, { type: "select", queueItemId: "second-entry", positionTicks: 0, paused: false });
    const b = await command(second, 1, { type: "select", queueItemId: "second-entry", positionTicks: 0, paused: false });
    await coordinator.submit(first, a);
    await expect(coordinator.submit(second, b)).rejects.toMatchObject({ code: "activity_queue_changed" });
    const repeatA = await command(first, 3, { type: "select", queueItemId: "second-entry", positionTicks: 0, paused: false });
    const repeatB = await command(second, 2, { type: "select", queueItemId: "second-entry", positionTicks: 0, paused: false });
    await coordinator.submit(first, repeatA);
    await expect(coordinator.submit(second, repeatB)).rejects.toMatchObject({ code: "activity_queue_changed" });
    expect((await coordinator.get(first)).snapshot).toMatchObject({ index: 1, queueRevision: 3, revision: 3 });
  });

  it("preserves duplicate media as unique queue entries and validates queue bounds", async () => {
    const actor = (await viewer()).actor; await connect(actor);
    await coordinator.submit(actor, await command(actor, 1, { type: "setQueue", queue: [{ id: "one", itemId: ITEM }, { id: "two", itemId: ITEM }], index: 1, positionTicks: 0, paused: true }));
    expect((await coordinator.get(actor)).snapshot.queue).toHaveLength(2);
    const invalid = await command(actor, 2, { type: "enqueue", queue: [{ id: "one", itemId: OTHER }] });
    await expect(coordinator.submit(actor, invalid)).rejects.toMatchObject({ code: "activity_invalid_queue" });
    await expect(coordinator.submit(actor, await command(actor, 3, { type: "setQueue", queue: [], index: 0, positionTicks: 0, paused: true }))).rejects.toMatchObject({ code: "activity_invalid_queue" });
    await coordinator.submit(actor, await command(actor, 4, { type: "stop" }));
    expect((await coordinator.get(actor)).snapshot).toMatchObject({ queue: [], index: -1, paused: true, queueRevision: 2 });
  });

  it("shares repeat mode and invalidates old end events without resetting the preference on stop", async () => {
    const first = (await viewer()).actor; const second = (await viewer("second")).actor;
    await connect(first); const remote = await connect(second);
    expect((await coordinator.get(first)).snapshot.repeatMode).toBe("RepeatNone");
    await coordinator.submit(first, await command(first, 1, queue()));
    const ended = await command(second, 1, { type: "select", queueItemId: "second-entry", positionTicks: 0, paused: false });
    await coordinator.submit(first, await command(first, 2, { type: "setRepeatMode", repeatMode: "RepeatOne" }));
    expect(remote.states.at(-1)?.snapshot).toMatchObject({ repeatMode: "RepeatOne", queueRevision: 2 });
    await expect(coordinator.submit(second, ended)).rejects.toMatchObject({ code: "activity_queue_changed" });
    await coordinator.submit(first, await command(first, 3, { type: "setRepeatMode", repeatMode: "RepeatOne" }));
    expect((await coordinator.get(first)).snapshot.queueRevision).toBe(2);
    await coordinator.submit(first, await command(first, 4, { type: "stop" }));
    expect((await coordinator.get(first)).snapshot).toMatchObject({ queue: [], repeatMode: "RepeatOne" });
    await coordinator.submit(first, await command(first, 5, queue()));
    expect((await coordinator.get(first)).snapshot.repeatMode).toBe("RepeatOne");
    const invalid = await command(first, 6, { type: "setRepeatMode", repeatMode: "RepeatAll" });
    await expect(coordinator.submit(first, { ...invalid, repeatMode: "invalid" })).rejects.toMatchObject({ code: "activity_invalid_command" });
  });

  it("checks every participant before replacing the queue and keeps rejected command IDs rejected", async () => {
    const actor = (await viewer()).actor; const other = (await viewer("second")).actor;
    await connect(actor); await connect(other);
    await coordinator.submit(actor, await command(actor, 1, { type: "setQueue", queue: [{ id: "one", itemId: ITEM }], index: 0, positionTicks: 0, paused: true }));
    denied.add(`second:${OTHER}`);
    const rejected = await command(actor, 2, queue());
    await expect(coordinator.submit(actor, rejected)).rejects.toMatchObject({ code: "native_item_denied" });
    expect((await coordinator.get(actor)).snapshot).toMatchObject({ revision: 1, queue: [{ id: "one", itemId: ITEM }] });
    denied.clear();
    await expect(coordinator.submit(actor, rejected)).rejects.toMatchObject({ code: "native_item_denied" });
    await coordinator.submit(actor, { ...rejected, id: "retry-new-intent", sequence: 3 });
    expect((await coordinator.get(actor)).snapshot.queue).toHaveLength(2);
  });

  it("validates late joins and denies disabled playback accounts", async () => {
    const actor = (await viewer()).actor; await connect(actor);
    await coordinator.submit(actor, await command(actor, 1, queue()));
    const late = (await viewer("late")).actor; denied.add(`late:${ITEM}`);
    await expect(connect(late)).rejects.toMatchObject({ code: "native_item_denied" });
    expect(late.joined).toBe(false);
    const disabled = (await viewer("disabled")).actor; playbackDenied.add("disabled");
    await expect(connect(disabled)).rejects.toMatchObject({ code: "native_playback_denied" });
  });

  it("reconnects to the moving current snapshot without replaying old commands", async () => {
    const actor = (await viewer()).actor; const first = await connect(actor);
    await coordinator.submit(actor, await command(actor, 1, queue()));
    first.unsubscribe(); await service.socketDisconnected(actor);
    now += 5000;
    const replacement = await connect(actor);
    expect(replacement.states).toHaveLength(1);
    expect(replacement.states[0]?.snapshot).toMatchObject({ revision: 1, positionTicks: 50_000_000, paused: false });
    expect(replacement.states[0]?.sequence).toBe(1);
    expect((await coordinator.get(actor)).sequence).toBe(1);
    await coordinator.submit(actor, await command(actor, 2, { type: "setPlayback", paused: true, positionTicks: 50_000_000 }));
  });

  it("rejects expired epochs and stale intent, and bounds forged timestamps", async () => {
    const actor = (await viewer()).actor; await connect(actor);
    await expect(coordinator.submit(actor, await command(actor, 1, queue(), { epoch: "old-party" }))).rejects.toMatchObject({ code: "activity_epoch_changed" });
    await expect(coordinator.submit(actor, await command(actor, 1, queue(), { issuedAt: now - 10_001 }))).rejects.toMatchObject({ code: "activity_stale_command" });
    await coordinator.submit(actor, await command(actor, 2, queue(), { issuedAt: now - 9000 }));
    expect((await coordinator.get(actor)).snapshot.positionTicks).toBe(50_000_000);
    await coordinator.submit(actor, await command(actor, 3, { type: "seek", positionTicks: 0, paused: false }, { issuedAt: now + 999_999 }));
    expect((await coordinator.get(actor)).snapshot.positionTicks).toBe(0);
  });

  it("revokes a signed-out account without destroying other participants or disclosing snapshots", async () => {
    const first = (await viewer()).actor; const second = (await viewer("second")).actor;
    await connect(first); await connect(second);
    await coordinator.submit(first, await command(first, 1, queue()));
    const pending = await command(first, 2, { type: "stop" });
    await service.revokeConnection("first", "connection-first");
    await expect(coordinator.submit(first, pending)).rejects.toMatchObject({ code: "native_session_expired" });
    await expect(coordinator.get(first)).rejects.toMatchObject({ code: "native_session_expired" });
    expect((await coordinator.get(second)).snapshot).toMatchObject({ revision: 1, index: 0, paused: false });
  });

  it("does not commit a pending queue change after its sender loses authorization", async () => {
    const actor = (await viewer()).actor; const other = (await viewer("second")).actor;
    await connect(actor); await connect(other);
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(service, "requirePartyItems").mockImplementationOnce(async () => { started(); await gate; });
    const result = coordinator.submit(actor, await command(actor, 1, queue()));
    const rejection = expect(result).rejects.toMatchObject({ code: "native_session_expired" });
    await entered; await service.revoke(actor); release();
    await rejection;
    expect((await coordinator.get(other)).snapshot).toMatchObject({ revision: 0, queue: [] });
  });

  it("routes explicit Discord controls through the same coordinator without consuming native sequence", async () => {
    const actor = (await viewer()).actor; await connect(actor);
    await service.command(actor, "select", { itemIds: [ITEM, OTHER] });
    expect((await coordinator.get(actor)).snapshot).toMatchObject({ revision: 1, index: 0, paused: false });
    await service.command(actor, "pause");
    await service.command(actor, "next");
    expect((await coordinator.get(actor)).snapshot).toMatchObject({ revision: 3, index: 1, paused: false });
    expect((await coordinator.get(actor)).sequence).toBe(0);
    await coordinator.submit(actor, await command(actor, 1, { type: "setPlayback", paused: true, positionTicks: 0 }));
    expect((await coordinator.get(actor)).sequence).toBe(1);
    expect(upstreamPaths.some((path) => path.startsWith("/SyncPlay"))).toBe(false);
  });
});
