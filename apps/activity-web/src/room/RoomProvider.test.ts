import { describe, expect, it } from "vitest";
import { roomWebSocketUrl } from "./RoomProvider.js";

describe("roomWebSocketUrl", () => {
  it("uses a same-origin relative WebSocket URL when the configured host matches the page", () => {
    expect(roomWebSocketUrl({
      publicWsUrl: "wss://djf.techdaddydigital.com/ws",
      token: "app-token",
      instanceId: "room-1",
      pageHref: "https://djf.techdaddydigital.com/activity"
    })).toBe("wss://djf.techdaddydigital.com/ws?token=app-token&instanceId=room-1");
  });

  it("uses the current page host instead of a stale configured host", () => {
    expect(roomWebSocketUrl({
      publicWsUrl: "wss://djf.techdaddydigital.com/ws",
      token: "app-token",
      instanceId: "room-1",
      pageHref: "https://discord-proxy.example.test/activity"
    })).toBe("wss://discord-proxy.example.test/ws?token=app-token&instanceId=room-1");
  });
});
