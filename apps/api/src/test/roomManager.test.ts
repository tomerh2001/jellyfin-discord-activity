import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RoomManager } from "../services/roomManager.js";

describe("RoomManager", () => {
  it("restores media paused and releases stale host ownership on restart", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "watch-party-rooms-"));
    try {
      const databaseUrl = `file:${directory}/app.db`;
      const first = new RoomManager();
      first.configurePersistence(databaseUrl);
      first.claimHost({ instanceId: "persistent-room", guildId: "guild", channelId: "channel" }, "host");
      first.selectMedia({ instanceId: "persistent-room", itemId: "movie", title: "Movie" }, "host");
      first.updatePlaybackState({ instanceId: "persistent-room", discordUserId: "host", playState: "playing", positionSeconds: 123 });
      first.flushPersistence();
      const restored = new RoomManager();
      restored.configurePersistence(databaseUrl);
      expect(restored.findByChannel("guild", "channel")).toMatchObject({ itemId: "movie", positionSeconds: 123, playState: "paused" });
      expect(restored.get("persistent-room")?.hostDiscordUserId).toBeUndefined();
      expect(restored.findByChannel("other-guild", "channel")).toBeUndefined();
      expect(restored.size).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("hands off to a remaining host connection or the next participant, then clears an empty room", () => {
    const manager = new RoomManager();
    manager.claimHost({ instanceId: "handoff" }, "host");
    expect(manager.reconcileHost("handoff", ["guest", "host"])?.hostDiscordUserId).toBe("host");
    expect(manager.reconcileHost("handoff", ["guest"])?.hostDiscordUserId).toBe("guest");
    expect(manager.reconcileHost("handoff", [])?.hostDiscordUserId).toBeUndefined();
    expect(manager.claimHost({ instanceId: "handoff" }, "new-host").hostDiscordUserId).toBe("new-host");
  });

  it("starts empty", () => {
    expect(new RoomManager().size).toBe(0);
  });

  it("removes idle rooms but keeps active rooms", () => {
    const manager = new RoomManager();
    manager.getOrCreate("idle-room");
    manager.getOrCreate("active-room");

    const removed = manager.cleanupIdle({
      idleTtlSeconds: 60,
      activeInstanceIds: ["active-room"],
      now: new Date(Date.now() + 61_000)
    });

    expect(removed).toEqual(["idle-room"]);
    expect(manager.has("idle-room")).toBe(false);
    expect(manager.has("active-room")).toBe(true);
  });
});
