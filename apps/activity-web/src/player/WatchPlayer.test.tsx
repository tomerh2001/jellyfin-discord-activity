import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePlayback } from "../api/client.js";
import type { PlaybackPrepareResponse } from "../api/types.js";
import { attachVideoSource } from "./hls.js";
import { WatchPlayer, type WatchPlayerPropsForTest } from "./WatchPlayer.js";

vi.mock("../api/client.js", () => ({
  preparePlayback: vi.fn()
}));

vi.mock("./hls.js", () => ({
  attachVideoSource: vi.fn(() => vi.fn()),
  prefersForcedWebm: vi.fn(() => false),
  prefersForcedHls: vi.fn(() => false),
  prefersDirectPlayMethod: vi.fn(() => false),
  clientPlaybackLadder: vi.fn(() => ["hls", "direct", "webm"]),
  probeClientMediaCapabilities: vi.fn(() => ({
    hlsJsSupported: true,
    mediaSourceSupported: true,
    canPlayMp4: "maybe",
    canPlayH264: "maybe",
    canPlayAac: "maybe",
    canPlayWebm: "maybe",
    canPlayVp9: "maybe",
    canPlayOpus: "maybe",
    isLinuxDiscord: false
  })),
  probeStreamUrl: vi.fn(async () => ({
    ok: true,
    status: 206,
    contentType: "application/vnd.apple.mpegurl"
  })),
  waitForProgressiveBuffer: vi.fn(async () => ({ ready: true, bufferedSeconds: 8 })),
  progressiveMinBufferSeconds: 6
}));

describe("WatchPlayer", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("auto-prepares published room media with the room-selected tracks", async () => {
    const preparePlaybackMock = vi.mocked(preparePlayback);
    preparePlaybackMock.mockResolvedValue(playbackResponse());

    renderWatchPlayer({
      itemId: "movie-1",
      mediaSourceId: "media-1",
      audioStreamIndex: 2,
      subtitleStreamIndex: 3,
      title: "Example Movie"
    });

    await waitFor(() => {
      expect(preparePlaybackMock).toHaveBeenCalledWith("app-token", {
        itemId: "movie-1",
        mediaSourceId: "media-1",
        audioStreamIndex: 2,
        subtitleStreamIndex: 3
      });
    });
    expect(vi.mocked(attachVideoSource)).toHaveBeenCalledWith(expect.any(HTMLVideoElement), {
      playMethod: "hls",
      streamUrl: "/media/hls/ticket/master.m3u8"
    }, expect.objectContaining({
      enableWorker: false,
      onError: expect.any(Function)
    }));
  });

  it("falls back to a direct MP4 prepare when HLS fails in the client", async () => {
    const preparePlaybackMock = vi.mocked(preparePlayback);
    const attachVideoSourceMock = vi.mocked(attachVideoSource);
    preparePlaybackMock
      .mockResolvedValueOnce(playbackResponse())
      .mockResolvedValueOnce(playbackResponse({
        playMethod: "direct",
        streamUrl: "/media/direct/ticket/stream.mp4"
      }));
    attachVideoSourceMock
      .mockImplementationOnce((_video, _source, options) => {
        const onError = typeof options === "function" ? options : options?.onError;
        window.setTimeout(() => onError?.("HLS playback failed: bufferAppendError."), 0);
        return vi.fn();
      })
      .mockImplementationOnce(() => vi.fn());

    renderWatchPlayer({
      itemId: "movie-1",
      mediaSourceId: "media-1",
      audioStreamIndex: 2,
      subtitleStreamIndex: 3,
      title: "Example Movie"
    });

    await waitFor(() => {
      expect(preparePlaybackMock).toHaveBeenCalledWith("app-token", {
        itemId: "movie-1",
        mediaSourceId: "media-1",
        audioStreamIndex: 2,
        subtitleStreamIndex: 3,
        preferredPlayMethod: "direct"
      });
      expect(attachVideoSourceMock).toHaveBeenLastCalledWith(expect.any(HTMLVideoElement), {
        playMethod: "direct",
        streamUrl: "/media/direct/ticket/stream.mp4"
      }, expect.objectContaining({
        enableWorker: false,
        onError: expect.any(Function)
      }));
    });
    expect(preparePlaybackMock).toHaveBeenCalledWith("app-token", expect.objectContaining({
      preferredPlayMethod: "direct"
    }));
  });

  it("lets the host choose tracks before publishing staged media", async () => {
    const preparePlaybackMock = vi.mocked(preparePlayback);
    const onPrepareStagedMedia = vi.fn();
    preparePlaybackMock.mockResolvedValue(playbackResponse());

    renderWatchPlayer({
      isHost: true,
      stagedMedia: {
        itemId: "movie-1",
        title: "Example Movie",
        runtimeTicks: 7_200_000_000
      },
      onPrepareStagedMedia
    });

    await screen.findByLabelText("Playback track controls");
    expect(preparePlaybackMock).toHaveBeenCalledWith("app-token", {
      itemId: "movie-1"
    });
    expect(vi.mocked(attachVideoSource)).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Audio")).toHaveValue("1");
    expect(screen.getByLabelText("Subtitles")).toHaveValue("-1");

    fireEvent.change(screen.getByLabelText("Audio"), {
      target: {
        value: "2"
      }
    });
    fireEvent.change(screen.getByLabelText("Subtitles"), {
      target: {
        value: "3"
      }
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Prepare playback"
    }));

    expect(onPrepareStagedMedia).toHaveBeenCalledWith({
      itemId: "movie-1",
      title: "Example Movie",
      runtimeTicks: 7_200_000_000,
      mediaSourceId: "media-1",
      audioStreamIndex: 2,
      subtitleStreamIndex: 3
    });
    expect(preparePlaybackMock).toHaveBeenCalledTimes(1);
  });
});

function renderWatchPlayer(props: Partial<WatchPlayerPropsForTest> = {}) {
  return render(
    <WatchPlayer
      appToken="app-token"
      audioStreamIndex={undefined}
      canPrepare
      clockOffsetMs={0}
      isHost={false}
      itemId={undefined}
      mediaSourceId={undefined}
      onPlayerEvent={() => true}
      onPrepareStagedMedia={() => undefined}
      onStateUpdate={() => true}
      remotePlayerEvent={undefined}
      remoteStateUpdate={undefined}
      stagedMedia={undefined}
      subtitleStreamIndex={undefined}
      syncStatus="connected"
      title={undefined}
      {...props}
    />
  );
}

function playbackResponse(overrides: Partial<PlaybackPrepareResponse["playback"]> = {}) {
  return {
    playback: {
      itemId: "movie-1",
      mediaSourceId: "media-1",
      playMethod: "hls" as const,
      streamUrl: "/media/hls/ticket/master.m3u8",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      selectedAudioStreamIndex: 1,
      selectedSubtitleStreamIndex: -1,
      audioTracks: [{
        index: 1,
        type: "Audio" as const,
        label: "English - AAC"
      }, {
        index: 2,
        type: "Audio" as const,
        label: "Japanese - AAC"
      }],
      subtitleTracks: [{
        index: 3,
        type: "Subtitle" as const,
        label: "English"
      }],
      ...overrides
    }
  };
}
