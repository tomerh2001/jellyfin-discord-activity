import { describe, expect, it } from "vitest";
import {
  calculateDriftSeconds,
  playStateForAction,
  targetServerTimestamp
} from "../services/syncEngine.js";

describe("calculateDriftSeconds", () => {
  it("returns remote minus local", () => {
    expect(calculateDriftSeconds(10, 12.5)).toBe(2.5);
  });

  it("maps player actions to room state", () => {
    expect(playStateForAction("play")).toBe("playing");
    expect(playStateForAction("pause")).toBe("paused");
    expect(playStateForAction("buffering")).toBe("buffering");
    expect(playStateForAction("ended")).toBe("ended");
  });

  it("schedules play farther out than pause", () => {
    expect(targetServerTimestamp("play", 1000)).toBe(2000);
    expect(targetServerTimestamp("pause", 1000)).toBe(1300);
  });
});
