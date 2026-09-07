import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env.js";
import { encryptString } from "../services/crypto.js";
import type { JellyfinAccount } from "../services/jellyfin.js";
import { getPlaybackInfo } from "../services/jellyfinPlayback.js";

const env = loadEnv({
  NODE_ENV: "test", DEV_AUTH_MOCK: "true",
  APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
});
const account: JellyfinAccount = {
  id: "account", discordUserId: "watcher", serverUrl: "https://jellyfin.example.com",
  jellyfinUserId: "jf-user", jellyfinUsername: "watcher", encryptedAccessToken: encryptString(env, "test-token"),
  tokenCreatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
};
const source = {
  Id: "source", Container: "mp4", SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: true,
  TranscodingUrl: "/Videos/episode-1/master.m3u8?MediaSourceId=source&AudioStreamIndex=1&SubtitleStreamIndex=4&SubtitleMethod=External&API_KEY=secret-key",
  TranscodingSubProtocol: "hls", TranscodingContainer: "ts",
  MediaStreams: [
    { Type: "Video", Codec: "h264", Index: 0 },
    { Type: "Audio", Codec: "aac", Index: 1, IsDefault: true },
    { Type: "Audio", Codec: "aac", Index: 2 },
    { Type: "Subtitle", Codec: "ass", Index: 3 },
    { Type: "Subtitle", Codec: "srt", Index: 4 }
  ]
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mockPlayback(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(JSON.stringify({ MediaSources: [{ ...source, ...overrides }] }), { headers: { "content-type": "application/json" } });
  }));
}

describe("selected tracks and playback compatibility", () => {
  it("burns selected subtitles instead of returning a static file that ignores them", async () => {
    mockPlayback();
    const result = await getPlaybackInfo(env, account, { itemId: "episode-1", subtitleStreamIndex: 3 });
    expect(result.playMethod).toBe("hls");
    expect(result.selectedSubtitleStreamIndex).toBe(3);
    const url = new URL(result.upstreamPath, account.serverUrl);
    expect(url.searchParams.get("SubtitleStreamIndex")).toBe("3");
    expect(url.searchParams.get("SubtitleMethod")).toBe("Encode");
    expect(url.searchParams.has("Static")).toBe(false);
    expect(result.upstreamPath).not.toContain("secret-key");
  });

  it("applies an alternate audio track and turns off stale subtitles in Jellyfin's returned HLS URL", async () => {
    mockPlayback();
    const result = await getPlaybackInfo(env, account, { itemId: "episode-1", audioStreamIndex: 2, subtitleStreamIndex: -1 });
    expect(result.playMethod).toBe("hls");
    const url = new URL(result.upstreamPath, account.serverUrl);
    expect(url.searchParams.get("AudioStreamIndex")).toBe("2");
    expect(url.searchParams.has("SubtitleStreamIndex")).toBe(false);
    expect(url.searchParams.has("SubtitleMethod")).toBe(false);
  });

  it("rejects unavailable track indexes instead of silently selecting a different track", async () => {
    mockPlayback();
    for (const selection of [{ audioStreamIndex: 99 }, { subtitleStreamIndex: 99 }]) {
      await expect(getPlaybackInfo(env, account, { itemId: "episode-1", ...selection })).rejects.toMatchObject({ code: "jellyfin_track_missing" });
    }
  });

  it("rejects subtitle selection when the account is not permitted to transcode", async () => {
    mockPlayback({ SupportsTranscoding: false, TranscodingUrl: null });
    await expect(getPlaybackInfo(env, account, { itemId: "episode-1", subtitleStreamIndex: 3 })).rejects.toMatchObject({ code: "jellyfin_direct_play_unavailable" });
  });

  it("preserves subtitle and audio selection in the Linux VP8/Opus WebM fallback", async () => {
    mockPlayback();
    const result = await getPlaybackInfo(env, account, { itemId: "episode-1", preferredPlayMethod: "webm", subtitleStreamIndex: 3, audioStreamIndex: 2 });
    expect(result).toMatchObject({ playMethod: "direct", container: "webm", videoCodec: "vp8", audioCodec: "opus" });
    const url = new URL(result.upstreamPath, account.serverUrl);
    expect(url.searchParams.get("SubtitleStreamIndex")).toBe("3");
    expect(url.searchParams.get("SubtitleMethod")).toBe("Encode");
    expect(url.searchParams.get("AudioStreamIndex")).toBe("2");
    expect(url.searchParams.get("VideoCodec")).toBe("vp8");
    expect(url.searchParams.get("MaxHeight")).toBe("480");
  });

  it("rejects an external HLS playback target instead of rebasing it to Jellyfin", async () => {
    mockPlayback({ TranscodingUrl: "https://attacker.example/master.m3u8?ApiKey=secret" });
    await expect(getPlaybackInfo(env, account, { itemId: "episode-1", preferredPlayMethod: "hls" })).rejects.toMatchObject({ code: "jellyfin_media_target_invalid" });
  });
});
