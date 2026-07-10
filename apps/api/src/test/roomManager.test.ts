import { describe, expect, it } from "vitest";
import { RoomManager } from "../services/roomManager.js";

describe("RoomManager", () => {
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
