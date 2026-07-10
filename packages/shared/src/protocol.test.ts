import { describe, expect, it } from "vitest";
import {
  clientMessageSchema,
  discordExchangeRequestSchema,
  healthSchema,
  jellyfinItemsQuerySchema,
  jellyfinLinkRequestSchema,
  playbackPrepareRequestSchema,
  playbackPrepareResponseSchema,
  roomResponseSchema
} from "./index.js";

describe("shared schemas", () => {
  it("validates the health response", () => {
    expect(healthSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it("validates a websocket hello message", () => {
    const parsed = clientMessageSchema.parse({
      type: "hello",
      instanceId: "instance-1",
      guildId: "guild-1",
      channelId: "channel-1",
      ts: 1
    });

    expect(parsed).toMatchObject({
      type: "hello",
      instanceId: "instance-1"
    });
  });

  it("validates selected playback tracks in room sync messages", () => {
    const parsed = clientMessageSchema.parse({
      type: "select_media",
      itemId: "movie-1",
      mediaSourceId: "media-1",
      title: "Example Movie",
      audioStreamIndex: 2,
      subtitleStreamIndex: 4,
      ts: 1
    });

    expect(parsed).toMatchObject({
      type: "select_media",
      audioStreamIndex: 2,
      subtitleStreamIndex: 4
    });
  });

  it("validates a Discord exchange request", () => {
    const parsed = discordExchangeRequestSchema.parse({
      code: "oauth-code",
      instanceId: "instance-1",
      guildId: "guild-1",
      channelId: "channel-1"
    });

    expect(parsed.code).toBe("oauth-code");
  });

  it("validates a Jellyfin link request", () => {
    const parsed = jellyfinLinkRequestSchema.parse({
      serverUrl: "https://jellyfin.example.com",
      username: "demo",
      password: "password"
    });

    expect(parsed.username).toBe("demo");
  });

  it("validates item search query defaults", () => {
    const parsed = jellyfinItemsQuerySchema.parse({
      parentId: "library-1"
    });

    expect(parsed.limit).toBe(50);
    expect(parsed.recursive).toBe(true);
    expect(parsed.startIndex).toBe(0);
  });

  it("validates non-recursive item browsing queries", () => {
    const parsed = jellyfinItemsQuerySchema.parse({
      parentId: "library-1",
      type: "Series",
      recursive: "false",
      parentIndexNumber: "1",
      startIndex: "100"
    });

    expect(parsed.recursive).toBe(false);
    expect(parsed.parentIndexNumber).toBe(1);
    expect(parsed.startIndex).toBe(100);
    expect(parsed.type).toBe("Series");
  });

  it("validates a room response", () => {
    const parsed = roomResponseSchema.parse({
      room: {
        instanceId: "instance-1",
        itemId: "movie-1",
        mediaSourceId: "media-1",
        audioStreamIndex: 2,
        subtitleStreamIndex: 4,
        playState: "idle",
        positionSeconds: 0,
        updatedAt: "2026-07-09T12:00:00.000Z"
      }
    });

    expect(parsed.room.instanceId).toBe("instance-1");
  });

  it("validates playback prepare contracts", () => {
    const request = playbackPrepareRequestSchema.parse({
      itemId: "movie-1",
      maxStreamingBitrate: 20_000_000,
      preferredPlayMethod: "direct"
    });

    expect(request.itemId).toBe("movie-1");
    expect(request.preferredPlayMethod).toBe("direct");
    expect(playbackPrepareRequestSchema.parse({
      itemId: "movie-1",
      preferredPlayMethod: "webm"
    }).preferredPlayMethod).toBe("webm");

    const response = playbackPrepareResponseSchema.parse({
      playback: {
        itemId: "movie-1",
        mediaSourceId: "media-1",
        playMethod: "hls",
        streamUrl: "/media/hls/ticket/master.m3u8",
        expiresAt: "2026-07-09T12:00:00.000Z",
        selectedAudioStreamIndex: 1,
        selectedSubtitleStreamIndex: -1,
        audioTracks: [{
          index: 1,
          type: "Audio",
          label: "English AAC",
          codec: "aac",
          language: "eng"
        }],
        subtitleTracks: [{
          index: 2,
          type: "Subtitle",
          label: "English SDH",
          codec: "srt",
          language: "eng"
        }]
      }
    });

    expect(response.playback.playMethod).toBe("hls");
  });
});
