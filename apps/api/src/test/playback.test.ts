import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv, type AppEnv } from "../env.js";
import { streamTicketStore } from "../services/tickets.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

describe("playback routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    streamTicketStore.clear();
  });

  it("prepares explicit H.264/AAC HLS playback and rewrites playlist URLs through the media proxy", async () => {
    const app = await buildPlaybackApp();

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        return authResponse();
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/PlaybackInfo")) {
        const parsed = new URL(url);
        const headers = new Headers(init?.headers);
        const body = JSON.parse(init?.body?.toString() ?? "{}");

        expect(headers.get("authorization")).toContain("Token=\"secret-jellyfin-token\"");
        expect(parsed.searchParams.get("MaxWidth")).toBe("1920");
        expect(parsed.searchParams.get("MaxHeight")).toBe("1080");
        expect(body.DeviceProfile.TranscodingProfiles[0]).toMatchObject({
          Protocol: "hls",
          MaxWidth: "1920",
          MaxHeight: "1080"
        });
        expect(parsed.searchParams.has("SubtitleStreamIndex")).toBe(false);
        expect(parsed.searchParams.has("SubtitleMethod")).toBe(false);

        return jsonResponse({
          MediaSources: [{
            Id: "media-1",
            Container: "mp4",
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            SupportsTranscoding: true,
            TranscodingUrl: "/Videos/movie-1/stream.mp4?MediaSourceId=media-1&VideoBitrate=7616000&ApiKey=secret-api-key",
            TranscodingSubProtocol: "http",
            TranscodingContainer: "mp4",
            MediaStreams: [
              { Type: "Video", Codec: "h264", Index: 0 },
              { Type: "Audio", Codec: "aac", Index: 1 }
            ]
          }]
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Videos/movie-1/master.m3u8")) {
        const parsed = new URL(url);
        const headers = new Headers(init?.headers);

        expect(parsed.searchParams.get("MediaSourceId")).toBe("media-1");
        expect(parsed.searchParams.get("VideoCodec")).toBe("h264");
        expect(parsed.searchParams.get("AudioCodec")).toBe("aac");
        expect(parsed.searchParams.get("MaxStreamingBitrate")).toBe("20000000");
        expect(parsed.searchParams.get("VideoBitrate")).toBe("19616000");
        expect(parsed.searchParams.get("AudioBitrate")).toBe("384000");
        expect(parsed.searchParams.get("MaxWidth")).toBe("1920");
        expect(parsed.searchParams.get("MaxHeight")).toBe("1080");
        expect(parsed.searchParams.get("SegmentContainer")).toBe("ts");
        expect(parsed.searchParams.has("SubtitleStreamIndex")).toBe(false);
        expect(parsed.searchParams.has("SubtitleMethod")).toBe(false);
        expect(parsed.searchParams.has("ApiKey")).toBe(false);
        expect(headers.get("authorization")).toContain("Token=\"secret-jellyfin-token\"");

        return textResponse([
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:10",
          "#EXTINF:10,",
          "hls/main/0.ts?ApiKey=secret-api-key"
        ].join("\n"), 200, "application/vnd.apple.mpegurl");
      }

      if (url.startsWith("https://jellyfin.example.com/Videos/movie-1/hls/main/0.ts")) {
        const parsed = new URL(url);

        expect(parsed.searchParams.has("ApiKey")).toBe(false);

        return textResponse("segment", 200, "video/mp2t");
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await linkAccount(app);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/playback/prepare",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        itemId: "movie-1"
      }
    });

    expect(prepared.statusCode).toBe(200);
    const preparedBody = prepared.json();
    expect(preparedBody.playback).toMatchObject({
      itemId: "movie-1",
      mediaSourceId: "media-1",
      playMethod: "hls"
    });
    expect(preparedBody.playback.streamUrl).toMatch(/^\/media\/hls\/.+\/master\.m3u8$/);
    expect(JSON.stringify(preparedBody)).not.toContain("secret-jellyfin-token");

    const playlist = await app.inject({
      method: "GET",
      url: preparedBody.playback.streamUrl as string
    });

    expect(playlist.statusCode).toBe(200);
    expect(playlist.body).toContain("/media/hls/");
    expect(playlist.body).not.toContain("jellyfin.example.com");
    expect(playlist.body).not.toContain("secret-jellyfin-token");
    expect(playlist.body).not.toContain("secret-api-key");

    const segmentUrl = playlist.body.split("\n").find((line) => line.startsWith("/media/hls/"));
    expect(segmentUrl).toBeTruthy();

    const segment = await app.inject({
      method: "GET",
      url: segmentUrl ?? ""
    });

    expect(segment.statusCode).toBe(200);
    expect(segment.body).toBe("segment");

    await app.close();
  });

  it("uses Jellyfin TranscodingUrl for HLS when direct remux is unavailable", async () => {
    const app = await buildPlaybackApp();

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        return authResponse();
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/PlaybackInfo")) {
        return jsonResponse({
          PlaySessionId: "play-session-1",
          MediaSources: [{
            Id: "media-1",
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            SupportsTranscoding: true,
            TranscodingUrl: "/Videos/movie-1/master.m3u8?MediaSourceId=media-1&PlaySessionId=play-session-1&ApiKey=secret-api-key",
            TranscodingSubProtocol: "hls",
            TranscodingContainer: "ts",
            MediaStreams: [
              { Type: "Video", Codec: "hevc", Index: 0 },
              { Type: "Audio", Codec: "truehd", Index: 1 }
            ]
          }]
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Videos/movie-1/master.m3u8")) {
        const parsed = new URL(url);
        const headers = new Headers(init?.headers);

        expect(parsed.searchParams.get("MediaSourceId")).toBe("media-1");
        expect(parsed.searchParams.get("PlaySessionId")).toBe("play-session-1");
        expect(parsed.searchParams.has("ApiKey")).toBe(false);
        expect(headers.get("authorization")).toContain("Token=\"secret-jellyfin-token\"");

        return textResponse([
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:10",
          "#EXTINF:10,",
          "hls/main/0.ts?ApiKey=secret-api-key"
        ].join("\n"), 200, "application/vnd.apple.mpegurl");
      }

      if (url.startsWith("https://jellyfin.example.com/Videos/movie-1/hls/main/0.ts")) {
        const parsed = new URL(url);

        expect(parsed.searchParams.has("ApiKey")).toBe(false);

        return textResponse("segment", 200, "video/mp2t");
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await linkAccount(app);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/playback/prepare",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        itemId: "movie-1"
      }
    });

    expect(prepared.statusCode).toBe(200);
    const preparedBody = prepared.json();
    expect(preparedBody.playback).toMatchObject({
      itemId: "movie-1",
      mediaSourceId: "media-1",
      playMethod: "hls"
    });
    expect(preparedBody.playback.streamUrl).toMatch(/^\/media\/hls\/.+\/master\.m3u8$/);

    const playlist = await app.inject({
      method: "GET",
      url: preparedBody.playback.streamUrl as string
    });

    expect(playlist.statusCode).toBe(200);
    expect(playlist.body).toContain("/media/hls/");
    expect(playlist.body).not.toContain("jellyfin.example.com");
    expect(playlist.body).not.toContain("secret-jellyfin-token");
    expect(playlist.body).not.toContain("secret-api-key");

    const segmentUrl = playlist.body.split("\n").find((line) => line.startsWith("/media/hls/"));
    expect(segmentUrl).toBeTruthy();

    const segment = await app.inject({
      method: "GET",
      url: segmentUrl ?? ""
    });

    expect(segment.statusCode).toBe(200);
    expect(segment.body).toBe("segment");

    await app.close();
  });

  it("prefers static remux for browser-safe DirectPlay sources under hls-first mode", async () => {
    const app = await buildPlaybackApp();

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        return authResponse();
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/PlaybackInfo")) {
        return jsonResponse({
          MediaSources: [{
            Id: "media-1",
            Container: "mp4",
            SupportsDirectPlay: true,
            SupportsDirectStream: true,
            SupportsTranscoding: true,
            MediaStreams: [
              { Type: "Video", Codec: "h264", Index: 0 },
              { Type: "Audio", Codec: "aac", Index: 1 }
            ]
          }]
        });
      }

      if (url === "https://jellyfin.example.com/Videos/movie-1/stream.mp4?Static=true&MediaSourceId=media-1") {
        return textResponse("mp4-bytes", 200, "video/mp4");
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await linkAccount(app);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/playback/prepare",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        itemId: "movie-1"
      }
    });

    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().playback).toMatchObject({
      itemId: "movie-1",
      mediaSourceId: "media-1",
      playMethod: "direct",
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac"
    });
    expect(prepared.json().playback.streamUrl).toMatch(/^\/media\/direct\/.+\/stream\.mp4$/);

    const stream = await app.inject({
      method: "GET",
      url: prepared.json().playback.streamUrl as string
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.body).toBe("mp4-bytes");

    await app.close();
  });

  it("slides stream ticket expiry while the media proxy is actively used", async () => {
    const app = await buildPlaybackApp({
      STREAM_TICKET_TTL_SECONDS: "2"
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        return authResponse();
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/PlaybackInfo")) {
        return jsonResponse({
          MediaSources: [{
            Id: "media-1",
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            SupportsTranscoding: true,
            TranscodingUrl: "/Videos/movie-1/master.m3u8?MediaSourceId=media-1",
            TranscodingSubProtocol: "hls"
          }]
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Videos/movie-1/master.m3u8")) {
        return textResponse("#EXTM3U\n#EXTINF:10,\nhls/main/0.ts\n", 200, "application/vnd.apple.mpegurl");
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await linkAccount(app);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/playback/prepare",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        itemId: "movie-1"
      }
    });

    expect(prepared.statusCode).toBe(200);
    const streamUrl = prepared.json().playback.streamUrl as string;

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const first = await app.inject({ method: "GET", url: streamUrl });
    expect(first.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const second = await app.inject({ method: "GET", url: streamUrl });
    expect(second.statusCode).toBe(200);

    await app.close();
  });

  it("returns selectable audio and subtitle tracks and forwards selected indexes", async () => {
    const app = await buildPlaybackApp();

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        return authResponse();
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/PlaybackInfo")) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("AudioStreamIndex")).toBe("2");
        expect(parsed.searchParams.get("SubtitleStreamIndex")).toBe("4");
        expect(parsed.searchParams.get("SubtitleMethod")).toBe("Encode");

        return jsonResponse({
          MediaSources: [{
            Id: "media-1",
            SupportsTranscoding: true,
            TranscodingUrl: "/Videos/movie-1/stream.mp4?MediaSourceId=media-1",
            TranscodingSubProtocol: "http",
            TranscodingContainer: "mp4",
            MediaStreams: [
              { Type: "Video", Codec: "h264", Index: 0 },
              { Type: "Audio", Codec: "aac", Index: 1, DisplayTitle: "English - AAC - Stereo", Language: "eng", IsDefault: true },
              { Type: "Audio", Codec: "aac", Index: 2, DisplayTitle: "Japanese - AAC - Stereo", Language: "jpn" },
              { Type: "Subtitle", Codec: "srt", Index: 3, DisplayTitle: "English", Language: "eng", IsExternal: true },
              { Type: "Subtitle", Codec: "ass", Index: 4, DisplayTitle: "Signs and Songs", Language: "eng", IsForced: true, IsExternal: true }
            ]
          }]
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Videos/movie-1/master.m3u8")) {
        const parsed = new URL(url);

        expect(parsed.searchParams.get("AudioStreamIndex")).toBe("2");
        expect(parsed.searchParams.get("SubtitleStreamIndex")).toBe("4");
        expect(parsed.searchParams.get("SubtitleMethod")).toBe("Encode");

        return textResponse("#EXTM3U", 200, "application/vnd.apple.mpegurl");
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await linkAccount(app);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/playback/prepare",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        itemId: "movie-1",
        audioStreamIndex: 2,
        subtitleStreamIndex: 4
      }
    });

    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().playback).toMatchObject({
      selectedAudioStreamIndex: 2,
      selectedSubtitleStreamIndex: 4,
      audioTracks: [{
        index: 1,
        type: "Audio",
        label: "English - AAC - Stereo",
        codec: "aac",
        language: "eng",
        isDefault: true
      }, {
        index: 2,
        type: "Audio",
        label: "Japanese - AAC - Stereo",
        codec: "aac",
        language: "jpn"
      }],
      subtitleTracks: [{
        index: 3,
        type: "Subtitle",
        label: "English",
        codec: "srt",
        language: "eng",
        isExternal: true
      }, {
        index: 4,
        type: "Subtitle",
        label: "Signs and Songs",
        codec: "ass",
        language: "eng",
        isForced: true,
        isExternal: true
      }]
    });
    expect(prepared.json().playback.streamUrl).toMatch(/^\/media\/hls\/.+\/master\.m3u8$/);

    const playlist = await app.inject({
      method: "GET",
      url: prepared.json().playback.streamUrl as string
    });

    expect(playlist.statusCode).toBe(200);

    await app.close();
  });

  it("prepares a forced H.264/AAC MP4 fallback stream when requested by the client", async () => {
    const app = await buildPlaybackApp();

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        return authResponse();
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/PlaybackInfo")) {
        const parsed = new URL(url);

        expect(parsed.searchParams.get("AudioStreamIndex")).toBe("2");
        expect(parsed.searchParams.get("SubtitleStreamIndex")).toBe("4");
        expect(parsed.searchParams.get("SubtitleMethod")).toBe("Encode");

        return jsonResponse({
          MediaSources: [{
            Id: "media-1",
            Container: "mkv",
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            SupportsTranscoding: true,
            MediaStreams: [
              { Type: "Video", Codec: "hevc", Index: 0 },
              { Type: "Audio", Codec: "flac", Index: 2 },
              { Type: "Subtitle", Codec: "ass", Index: 4 }
            ]
          }]
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Videos/movie-1/stream.mp4")) {
        const parsed = new URL(url);
        const headers = new Headers(init?.headers);

        expect(parsed.searchParams.get("MediaSourceId")).toBe("media-1");
        expect(parsed.searchParams.get("VideoCodec")).toBe("h264");
        expect(parsed.searchParams.get("AudioCodec")).toBe("aac");
        expect(parsed.searchParams.get("MaxStreamingBitrate")).toBe("20000000");
        expect(parsed.searchParams.get("MaxWidth")).toBe("1920");
        expect(parsed.searchParams.get("MaxHeight")).toBe("1080");
        expect(parsed.searchParams.get("VideoBitrate")).toBe("19616000");
        expect(parsed.searchParams.get("AudioBitrate")).toBe("384000");
        expect(parsed.searchParams.get("TranscodingMaxAudioChannels")).toBe("2");
        expect(parsed.searchParams.get("RequireAvc")).toBe("false");
        expect(parsed.searchParams.get("AudioStreamIndex")).toBe("2");
        expect(parsed.searchParams.get("SubtitleStreamIndex")).toBe("4");
        expect(parsed.searchParams.get("SubtitleMethod")).toBe("Encode");
        expect(headers.get("authorization")).toContain("Token=\"secret-jellyfin-token\"");

        return textResponse("mp4", 200, "video/mp4");
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await linkAccount(app);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/playback/prepare",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        itemId: "movie-1",
        audioStreamIndex: 2,
        subtitleStreamIndex: 4,
        preferredPlayMethod: "direct"
      }
    });

    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().playback).toMatchObject({
      itemId: "movie-1",
      mediaSourceId: "media-1",
      playMethod: "direct",
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac"
    });
    expect(prepared.json().playback.streamUrl).toMatch(/^\/media\/direct\/.+\/stream\.mp4$/);

    const stream = await app.inject({
      method: "GET",
      url: prepared.json().playback.streamUrl as string
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("video/mp4");
    expect(stream.body).toBe("mp4");

    await app.close();
  });

  it("rejects expired HLS stream tickets", async () => {
    const app = await buildPlaybackApp({
      STREAM_TICKET_TTL_SECONDS: "1"
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        return authResponse();
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/PlaybackInfo")) {
        return jsonResponse({
          MediaSources: [{
            Id: "media-1",
            SupportsTranscoding: true,
            TranscodingUrl: "/Videos/movie-1/master.m3u8?MediaSourceId=media-1"
          }]
        });
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await linkAccount(app);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/playback/prepare",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        itemId: "movie-1"
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const playlist = await app.inject({
      method: "GET",
      url: prepared.json().playback.streamUrl as string
    });

    expect(playlist.statusCode).toBe(403);
    expect(playlist.json()).toMatchObject({
      error: {
        code: "stream_ticket_invalid"
      }
    });

    await app.close();
  });

  it("rejects media tickets after the originating app session expires", async () => {
    const app = await buildPlaybackApp({
      APP_SESSION_TTL_SECONDS: "1",
      STREAM_TICKET_TTL_SECONDS: "300"
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        return authResponse();
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/PlaybackInfo")) {
        return jsonResponse({
          MediaSources: [{
            Id: "media-1",
            SupportsTranscoding: true,
            TranscodingUrl: "/Videos/movie-1/master.m3u8?MediaSourceId=media-1"
          }]
        });
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await linkAccount(app);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/playback/prepare",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        itemId: "movie-1"
      }
    });

    expect(prepared.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const playlist = await app.inject({
      method: "GET",
      url: prepared.json().playback.streamUrl as string
    });

    expect(playlist.statusCode).toBe(403);
    expect(playlist.json()).toMatchObject({
      error: {
        code: "stream_ticket_invalid"
      }
    });

    await app.close();
  });

  it("forwards Range headers for direct playback proxying", async () => {
    const app = await buildPlaybackApp({
      STREAM_PROXY_MODE: "direct"
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        return authResponse();
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/PlaybackInfo")) {
        return jsonResponse({
          MediaSources: [{
            Id: "media-1",
            Container: "mp4",
            SupportsDirectPlay: true,
            SupportsDirectStream: true,
            SupportsTranscoding: true
          }]
        });
      }

      if (url === "https://jellyfin.example.com/Videos/movie-1/stream.mp4?Static=true&MediaSourceId=media-1") {
        const headers = new Headers(init?.headers);
        expect(headers.get("range")).toBe("bytes=0-3");

        return textResponse("abcd", 206, "video/mp4", {
          "Accept-Ranges": "bytes",
          "Content-Range": "bytes 0-3/8"
        });
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await linkAccount(app);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/playback/prepare",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        itemId: "movie-1"
      }
    });

    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().playback.playMethod).toBe("direct");

    const stream = await app.inject({
      method: "GET",
      url: prepared.json().playback.streamUrl as string,
      headers: {
        range: "bytes=0-3"
      }
    });

    expect(stream.statusCode).toBe(206);
    expect(stream.headers["content-range"]).toBe("bytes 0-3/8");
    expect(stream.body).toBe("abcd");

    await app.close();
  });

  it("prepares playback through the shared Jellyfin account without per-user linking", async () => {
    const app = await buildPlaybackApp({
      JELLYFIN_AUTH_MODE: "shared",
      JELLYFIN_SHARED_USERNAME: "discord-watch",
      JELLYFIN_SHARED_PASSWORD: "shared-password"
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        expect(JSON.parse(init?.body?.toString() ?? "{}")).toMatchObject({
          Username: "discord-watch",
          Pw: "shared-password"
        });

        return jsonResponse({
          User: {
            Id: "shared-jellyfin-user",
            Name: "discord-watch"
          },
          AccessToken: "shared-secret-token"
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/PlaybackInfo")) {
        const parsed = new URL(url);
        const headers = new Headers(init?.headers);

        expect(parsed.searchParams.get("UserId")).toBe("shared-jellyfin-user");
        expect(headers.get("authorization")).toContain("Token=\"shared-secret-token\"");

        return jsonResponse({
          MediaSources: [{
            Id: "media-1",
            SupportsTranscoding: true,
            TranscodingUrl: "/Videos/movie-1/master.m3u8?MediaSourceId=media-1"
          }]
        });
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await createAppToken(app);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/playback/prepare",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        itemId: "movie-1"
      }
    });

    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().playback).toMatchObject({
      itemId: "movie-1",
      mediaSourceId: "media-1",
      playMethod: "hls"
    });
    expect(JSON.stringify(prepared.json())).not.toContain("shared-secret-token");

    await app.close();
  });
});

async function buildPlaybackApp(overrides: NodeJS.ProcessEnv = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "djf-playback-"));
  const env = loadEnv({
    NODE_ENV: "test",
    DEV_AUTH_MOCK: "true",
    APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    DATABASE_URL: `file:${path.join(dataDir, "app.db")}`,
    JELLYFIN_DEFAULT_SERVER_URL: "https://jellyfin.example.com",
    ...overrides
  } satisfies NodeJS.ProcessEnv);

  return buildApp(env as AppEnv);
}

async function linkAccount(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const token = await createAppToken(app);
  const link = await app.inject({
    method: "POST",
    url: "/api/jellyfin/link",
    headers: {
      authorization: `Bearer ${token}`
    },
    payload: {
      username: "demo",
      password: "password"
    }
  });

  expect(link.statusCode).toBe(200);
  return token;
}

async function createAppToken(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/discord/exchange",
    payload: {
      code: "dev-mock:dev-user-host",
      instanceId: "instance-1",
      mockUser: {
        id: "dev-user-host",
        username: "DevHost",
        avatar: null
      }
    }
  });

  return response.json().appToken as string;
}

function authResponse(): Response {
  return jsonResponse({
    User: {
      Id: "jellyfin-user-1",
      Name: "demo"
    },
    AccessToken: "secret-jellyfin-token",
    ServerId: "server-1"
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function textResponse(body: string, status = 200, contentType = "text/plain", headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      ...headers
    }
  });
}
