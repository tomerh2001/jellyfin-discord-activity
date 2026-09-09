import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActivityDiscordContext } from "./sdk.js";
import { createWatchPresence, formatWatchActivity, type WatchSnapshot } from "./richPresence.js";

const epoch = 1_800_000_000_000;
const episode: WatchSnapshot = {
  kind: "episode", title: "Overcast", seriesName: "Death Note", seasonNumber: 1,
  episodeNumber: 7, positionMs: 473_000, durationMs: 1_380_000,
  paused: false, buffering: false, playbackRate: 1
};
function fixture(scopes = ["identify", "rpc.activities.write"]) {
  const setActivity = vi.fn().mockResolvedValue({});
  const context = { instanceId: "instance", isMock: false, grantedScopes: scopes,
    application: { id: "1234567890", icon: "a".repeat(32) },
    sdk: { commands: { setActivity } }
  } as unknown as ActivityDiscordContext;
  return { setActivity, context, publisher: createWatchPresence(context) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch); });
afterEach(() => { vi.useRealTimers(); });
async function tick(ms = 0) { await vi.advanceTimersByTimeAsync(ms); }

it("describes the actual episode and supplies a progress interval in RPC seconds", () => {
  const activity = formatWatchActivity(episode, epoch);
  expect(activity).toMatchObject({ type: 3, details: "Death Note · Season 1 · Episode 7", state: "Overcast · Playing",
    timestamps: { start: 1_799_999_527, end: 1_800_000_907 } });
  expect(formatWatchActivity({ ...episode, paused: true }, epoch)).toMatchObject({
    state: "Overcast · Paused · 7:53 / 23:00", timestamps: null
  });
  expect(formatWatchActivity({ ...episode, buffering: true }, epoch)).toMatchObject({
    state: "Overcast · Buffering · 7:53 / 23:00", timestamps: null
  });
});

it("handles movies, episode ranges, specials, absent numbering and playback speed", () => {
  expect(formatWatchActivity({ ...episode, kind: "movie", title: "Arrival", year: 2016 }, epoch).details).toBe("Arrival (2016)");
  expect(formatWatchActivity({ ...episode, seasonNumber: 0, episodeEndNumber: 8 }, epoch).details).toBe("Death Note · Season 0 · Episode 7–8");
  const unnumbered = { ...episode }; delete unnumbered.seasonNumber; delete unnumbered.episodeNumber;
  expect(formatWatchActivity(unnumbered, epoch).details).toBe("Death Note");
  expect(formatWatchActivity({ ...episode, playbackRate: 2 }, epoch).timestamps).toEqual({ start: 1_799_999_763, end: 1_800_000_453 });
  expect(formatWatchActivity({ ...episode, kind: "audio" }, epoch).type).toBe(2);
});

it("fits long Unicode text without losing episode numbers or status and sanitizes invalid times", () => {
  const result = formatWatchActivity({ ...episode, title: "🎬".repeat(150), seriesName: "🔥".repeat(150), paused: true,
    durationMs: NaN, positionMs: -100, playbackRate: NaN }, epoch);
  expect(result.details!.length).toBeLessThanOrEqual(128);
  expect(result.details).toMatch(/ · Season 1 · Episode 7$/);
  expect(result.state!.length).toBeLessThanOrEqual(128);
  expect(result.state).toMatch(/ · Paused · 0:00$/);
  expect(result.details).not.toMatch(/[\ud800-\udbff]…/u);
  expect(formatWatchActivity({ ...episode, durationMs: 0, positionMs: Infinity }, epoch).timestamps).toEqual({ start: 1_800_000_000 });
  const short = formatWatchActivity({ ...episode, kind: "movie", title: "A" }, epoch, "https://cdn.discordapp.com/public.png");
  expect(short.details).toBe("A · Video"); expect(short.assets?.large_text).toBe(short.details);
  expect(formatWatchActivity({ ...episode, kind: "video", title: " \n " }, epoch).details).toBe("Video");
});

it("publishes public app artwork with no capability URLs or Jellyfin account identifiers", async () => {
  const { publisher, setActivity } = fixture();
  publisher.update({ ...episode, baseUrl: "https://secret.test/jf/token", accessToken: "secret", itemId: "private-id" } as WatchSnapshot);
  await tick();
  const payload = setActivity.mock.calls[0]![0];
  expect(payload.activity.assets).toEqual({ large_image: `https://cdn.discordapp.com/app-icons/1234567890/${"a".repeat(32)}.png`, large_text: "Death Note · Season 1 · Episode 7" });
  expect(JSON.stringify(payload)).not.toMatch(/secret|private-id|\/jf\/|join|buttons/);
});

it("deduplicates steady progress and coalesces rapid pause and seek updates", async () => {
  const { publisher, setActivity } = fixture();
  publisher.update(episode); await tick();
  await tick(15_000); publisher.update({ ...episode, positionMs: 488_000 }); await tick();
  expect(setActivity).toHaveBeenCalledTimes(1);
  publisher.update({ ...episode, positionMs: 600_000, paused: true }); await tick();
  expect(setActivity).toHaveBeenCalledTimes(2);
  publisher.update({ ...episode, positionMs: 700_000 });
  publisher.update({ ...episode, positionMs: 900_000, paused: true });
  await tick(4_999); expect(setActivity).toHaveBeenCalledTimes(2);
  await tick(1); expect(setActivity).toHaveBeenCalledTimes(3);
  expect(setActivity.mock.calls[2]![0].activity.state).toBe("Overcast · Paused · 15:00 / 23:00");
});

it("updates a new episode and clears stopped playback, including an in-flight request at disposal", async () => {
  const { publisher, setActivity } = fixture();
  let finish!: () => void;
  setActivity.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  publisher.update(episode); await tick();
  publisher.update({ ...episode, episodeNumber: 8, title: "Glare" });
  publisher.dispose();
  publisher.update(episode);
  await tick(5_000); expect(setActivity).toHaveBeenCalledTimes(1);
  finish(); await tick();
  expect(setActivity).toHaveBeenCalledTimes(2);
  expect(setActivity.mock.calls[1]![0]).toEqual({ activity: null });
  await tick(60_000); expect(setActivity).toHaveBeenCalledTimes(2);
});

it("clears idle metadata and rebuilds the timeline on episode or rate changes", async () => {
  const { publisher, setActivity } = fixture();
  publisher.update(episode); await tick(5_000);
  publisher.update({ ...episode, title: "Glare", episodeNumber: 8, positionMs: 0 }); await tick();
  expect(setActivity.mock.calls[1]![0].activity).toMatchObject({ details: "Death Note · Season 1 · Episode 8", state: "Glare · Playing", timestamps: { start: 1_800_000_005 } });
  await tick(5_000); publisher.clear(); await tick();
  expect(setActivity.mock.calls[2]![0]).toEqual({ activity: null });
});

it("clears a superseded title after a rejected or unresponsive in-flight command without reviving it", async () => {
  for (const hangs of [false, true]) {
    const { publisher, setActivity } = fixture();
    let reject!: (error: Error) => void;
    setActivity.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    publisher.update(episode); await tick();
    publisher.dispose();
    if (!hangs) reject(new Error("Lost response"));
    await tick(40_000);
    expect(setActivity).toHaveBeenCalledTimes(2);
    expect(setActivity.mock.calls[1]![0]).toEqual({ activity: null });
    await tick(60_000); expect(setActivity).toHaveBeenCalledTimes(2);
  }
});

it("never sends presence or retries authorization without the authenticated scope", async () => {
  const { publisher, setActivity } = fixture(["identify"]);
  publisher.update(episode); publisher.clear(); publisher.dispose(); await tick(60_000);
  expect(setActivity).not.toHaveBeenCalled();
  const { context, setActivity: standaloneSet } = fixture();
  context.isStandalone = true;
  createWatchPresence(context).update(episode); await tick();
  expect(standaloneSet).not.toHaveBeenCalled();
});

it("shares the RPC cadence across account replacements and invalidates old cleanup and queued titles", async () => {
  const { publisher: old, context, setActivity } = fixture();
  old.update(episode); await tick();
  old.dispose();
  const next = createWatchPresence(context);
  next.update({ ...episode, kind: "movie", title: "Arrival", year: 2016 });
  old.clear(); old.update(episode); old.dispose();
  await tick(5_000);
  expect(setActivity).toHaveBeenCalledTimes(2);
  expect(setActivity.mock.calls[1]![0].activity.details).toBe("Arrival (2016)");
  await tick(60_000); expect(setActivity).toHaveBeenCalledTimes(2);
});

it("contains RPC failure, backs off until a fresh update and stops on a denied permission", async () => {
  const { publisher, setActivity } = fixture();
  setActivity.mockRejectedValueOnce(new Error("temporary failure"));
  publisher.update(episode); await tick(60_000);
  expect(setActivity).toHaveBeenCalledTimes(1);
  publisher.update(episode); await tick(); expect(setActivity).toHaveBeenCalledTimes(2);
  await tick(5_000); setActivity.mockRejectedValueOnce({ code: 4006 });
  publisher.update({ ...episode, paused: true }); await tick();
  publisher.update(episode); await tick(60_000);
  expect(setActivity).toHaveBeenCalledTimes(3);
});
