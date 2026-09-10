import { afterEach, expect, it, vi } from "vitest";
import type { ActivityDiscordContext } from "./sdk.js";
import { mapActivityParticipants, observeActivityParticipants } from "./participants.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const host = { id: "1234567890", username: "host", global_name: "Display host", avatar: "a".repeat(32) };
const guest = { id: "9876543210", username: "guest", nickname: "Guest nickname", global_name: "Guest global", avatar: null };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function context() {
  const listeners = new Set<(value: { participants: (typeof host | typeof guest)[] }) => void>();
  const sdk = {
    subscribe: vi.fn(async (event, listener) => { expect(event).toBe("ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE"); listeners.add(listener); }),
    unsubscribe: vi.fn(async (event, listener) => { expect(event).toBe("ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE"); listeners.delete(listener); }),
    commands: { getActivityInstanceConnectedParticipants: vi.fn(async () => ({ participants: [host] })) }
  };
  return {
    discord: { instanceId: "instance", isMock: false, user: { id: host.id, username: host.username }, sdk } as unknown as ActivityDiscordContext,
    sdk, listeners,
    emit(participants: (typeof host | typeof guest)[]) { for (const listener of listeners) listener({ participants }); }
  };
}

it("maps only display fields, prefers Discord nicknames and validates avatar URLs", () => {
  const state = context();
  expect(mapActivityParticipants(state.discord, [guest, host, host])).toEqual([
    { id: host.id, displayName: "Display host", avatarUrl: `https://cdn.discordapp.com/avatars/${host.id}/${host.avatar}.png?size=64`, isSelf: true },
    { id: guest.id, displayName: "Guest nickname", isSelf: false }
  ]);
  expect(mapActivityParticipants(state.discord, [{ ...guest, avatar: "../../secret", nickname: "   " }])).toEqual([
    { id: guest.id, displayName: "Guest global", isSelf: false }
  ]);
  expect(mapActivityParticipants(state.discord, [{ ...host, id: "https://other.example/", avatar: host.avatar }])[0]?.avatarUrl).toBeUndefined();
});

it("loads the roster once and updates joins and departures immediately without polling", async () => {
  const state = context(); const changed = vi.fn();
  const observer = observeActivityParticipants(state.discord, changed);
  expect(changed).toHaveBeenCalledWith({ participants: [{ id: host.id, displayName: host.username, isSelf: true }], loading: true });
  await flush();
  expect(changed.mock.lastCall?.[0].loading).toBe(false);
  state.emit([host, guest]);
  expect(changed.mock.lastCall?.[0].participants).toHaveLength(2);
  state.emit([guest]);
  expect(changed.mock.lastCall?.[0].participants).toEqual([{ id: guest.id, displayName: "Guest nickname", isSelf: false }]);
  expect(state.sdk.commands.getActivityInstanceConnectedParticipants).toHaveBeenCalledTimes(1);
  observer.dispose(); observer.dispose(); await flush();
  expect(state.sdk.unsubscribe).toHaveBeenCalledTimes(1);
  expect(state.listeners.size).toBe(0);
  changed.mockClear(); state.emit([host, guest]); await observer.refresh(); expect(changed).not.toHaveBeenCalled();
});

it("ignores a stale initial snapshot after a newer join or leave event", async () => {
  const state = context(); const changed = vi.fn();
  let resolve!: (value: { participants: typeof host[] }) => void;
  state.sdk.commands.getActivityInstanceConnectedParticipants.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const observer = observeActivityParticipants(state.discord, changed);
  state.emit([guest]); resolve({ participants: [host] }); await observer.refresh();
  expect(changed.mock.lastCall?.[0].participants).toEqual([{ id: guest.id, displayName: "Guest nickname", isSelf: false }]);
  observer.dispose(); await flush();
});

it("coalesces refreshes, reports safe errors and recovers on the next panel open", async () => {
  const state = context(); const changed = vi.fn();
  state.sdk.commands.getActivityInstanceConnectedParticipants.mockRejectedValueOnce(new Error("secret raw RPC error"));
  const observer = observeActivityParticipants(state.discord, changed);
  const pending = observer.refresh(); expect(observer.refresh()).toBe(pending); await pending;
  expect(changed.mock.lastCall?.[0].error).toBe("Could not load everyone in this Activity. Open this list again to retry.");
  expect(JSON.stringify(changed.mock.calls)).not.toContain("secret raw RPC error");
  await observer.refresh();
  expect(changed.mock.lastCall?.[0]).toMatchObject({ loading: false, participants: [{ id: host.id }] });
  expect(changed.mock.lastCall?.[0].error).toBeUndefined();
  observer.dispose(); await flush();
});

it("retains useful snapshot data if live updates are unavailable", async () => {
  const state = context(); const changed = vi.fn();
  state.sdk.subscribe.mockRejectedValueOnce(new Error("unsupported"));
  const observer = observeActivityParticipants(state.discord, changed); await observer.refresh();
  expect(changed.mock.lastCall?.[0]).toMatchObject({ participants: [{ id: host.id }], loading: false,
    error: "Live participant updates are unavailable. Open this list again to refresh." });
  observer.dispose(); await flush();
});

it("times out a stalled roster request and suppresses late results after disposal", async () => {
  vi.useFakeTimers();
  const state = context(); const changed = vi.fn();
  let resolve!: (value: { participants: typeof host[] }) => void;
  state.sdk.commands.getActivityInstanceConnectedParticipants.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const observer = observeActivityParticipants(state.discord, changed);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(changed.mock.lastCall?.[0]).toMatchObject({ loading: false, error: expect.stringContaining("Could not load") });
  observer.dispose(); changed.mockClear(); resolve({ participants: [host] }); await flush();
  expect(changed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("supports local development without SDK calls and does not invent other participants", async () => {
  const state = context(); const changed = vi.fn();
  const { sdk: _sdk, ...mock } = state.discord;
  const observer = observeActivityParticipants({ ...mock, isMock: true }, changed);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ participants: [{ id: host.id, displayName: "host", isSelf: true }], loading: false });
  await observer.refresh(); observer.dispose(); expect(state.sdk.subscribe).not.toHaveBeenCalled();
});
