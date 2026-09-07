import { act, cleanup, renderHook } from "@testing-library/react";
import type { RoomState, ServerMessage } from "@app/shared/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roomWebSocketUrl, useRoomSync } from "./RoomProvider.js";

describe("roomWebSocketUrl", () => {
  it("uses a same-origin relative WebSocket URL when the configured host matches the page", () => {
    expect(roomWebSocketUrl({
      publicWsUrl: "wss://watch.example.com/ws",
      token: "app-token",
      instanceId: "room-1",
      pageHref: "https://watch.example.com/activity"
    })).toBe("wss://watch.example.com/ws?token=app-token&instanceId=room-1");
  });

  it("uses the current page host instead of a stale configured host", () => {
    expect(roomWebSocketUrl({
      publicWsUrl: "wss://watch.example.com/ws",
      token: "app-token",
      instanceId: "room-1",
      pageHref: "https://discord-proxy.example.test/activity"
    })).toBe("wss://discord-proxy.example.test/ws?token=app-token&instanceId=room-1");
  });
});

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static sockets: MockWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  constructor(readonly url: string) { super(); MockWebSocket.sockets.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
  message(payload: ServerMessage) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

const input = { appToken: "app-token" as string | undefined, instanceId: "room-1", guildId: "guild-1", channelId: "voice-1", publicWsUrl: "wss://watch.example.test/ws" };
const snapshot = (overrides: Partial<RoomState> = {}): ServerMessage => ({ type: "room_state", serverTs: Date.now(), room: {
  instanceId: "room-1", guildId: "guild-1", channelId: "voice-1", hostDiscordUserId: "host-1", itemId: "movie-1",
  title: "Movie", playState: "paused", positionSeconds: 234, updatedAt: new Date(Date.now() - 5000).toISOString(), ...overrides
} });

function startHook() {
  const hook = renderHook((props: typeof input) => useRoomSync(props), { initialProps: input });
  const socket = MockWebSocket.sockets.at(-1)!;
  act(() => { socket.open(); });
  return { ...hook, socket };
}

describe("useRoomSync recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
    MockWebSocket.sockets = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each(["host-1", "guest-1"])("restores a paused position from the first snapshot with host %s", (hostDiscordUserId) => {
    const { result, socket } = startHook();
    act(() => { socket.message(snapshot({ hostDiscordUserId })); });
    expect(result.current.room?.hostDiscordUserId).toBe(hostDiscordUserId);
    expect(result.current.remotePlayerEvent).toMatchObject({ action: "seek", positionSeconds: 234, targetServerTs: Date.now() });
    expect(result.current.remoteStateUpdate).toBeUndefined();
    expect(socket.sent).toContainEqual({ type: "hello", instanceId: "room-1", guildId: "guild-1", channelId: "voice-1", ts: Date.now() });
  });

  it("advances a playing snapshot to its server timestamp", () => {
    const { result, socket } = startHook();
    act(() => { socket.message(snapshot({ playState: "playing", positionSeconds: 100 })); });
    expect(result.current.remotePlayerEvent).toMatchObject({ action: "play", positionSeconds: 105 });
  });

  it("keeps a pending server command when subsequent room snapshots arrive", () => {
    const { result, socket } = startHook();
    act(() => {
      socket.message(snapshot());
      socket.message({ type: "player_event", action: "seek", positionSeconds: 500, targetServerTs: Date.now() + 300, serverTs: Date.now() });
      socket.message(snapshot({ positionSeconds: 500 }));
    });
    expect(result.current.remotePlayerEvent).toMatchObject({ action: "seek", positionSeconds: 500, targetServerTs: Date.now() + 300 });
  });

  it("clears the previous video's commands, drift updates and track selection when new media is selected", () => {
    const { result, socket } = startHook();
    act(() => {
      socket.message(snapshot({ mediaSourceId: "old-source", audioStreamIndex: 2, subtitleStreamIndex: 3 }));
      socket.message({ type: "state_update", playState: "playing", positionSeconds: 999, serverTs: Date.now() });
    });
    expect(result.current.remoteStateUpdate).toBeDefined();
    act(() => { socket.message({ type: "media_selected", itemId: "movie-2", title: "New Movie", serverTs: Date.now() }); });
    expect(result.current.room).toMatchObject({ itemId: "movie-2", playState: "loading", positionSeconds: 0 });
    expect(result.current.room?.mediaSourceId).toBeUndefined();
    expect(result.current.room?.audioStreamIndex).toBeUndefined();
    expect(result.current.room?.subtitleStreamIndex).toBeUndefined();
    expect(result.current.remotePlayerEvent).toBeUndefined();
    expect(result.current.remoteStateUpdate).toBeUndefined();
  });

  it("clears room and playback state on logout and ignores late frames from the closed socket", () => {
    const { result, socket, rerender } = startHook();
    act(() => {
      socket.message(snapshot());
      socket.message({ type: "state_update", playState: "playing", positionSeconds: 234, serverTs: Date.now() });
    });
    rerender({ ...input, appToken: undefined });
    expect(result.current.status).toBe("disabled");
    expect(result.current.room).toBeUndefined();
    expect(result.current.remotePlayerEvent).toBeUndefined();
    expect(result.current.remoteStateUpdate).toBeUndefined();
    act(() => { socket.message(snapshot()); });
    expect(result.current.room).toBeUndefined();
    expect(result.current.remotePlayerEvent).toBeUndefined();
  });

  it("restores from the new connection's first snapshot and ignores an old socket's late frames", () => {
    const { result, socket } = startHook();
    act(() => { socket.message(snapshot()); socket.close(); });
    act(() => { vi.advanceTimersByTime(1000); });
    const replacement = MockWebSocket.sockets.at(-1)!;
    expect(replacement).not.toBe(socket);
    act(() => {
      replacement.open();
      socket.message(snapshot({ itemId: "stale-movie", positionSeconds: 900 }));
      replacement.message(snapshot({ itemId: "current-movie", positionSeconds: 321 }));
    });
    expect(result.current.room?.itemId).toBe("current-movie");
    expect(result.current.remotePlayerEvent).toMatchObject({ action: "seek", positionSeconds: 321 });
  });
});
