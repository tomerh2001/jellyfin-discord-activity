import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePlayback } from "../api/client.js";
import { attachVideoSource } from "./hls.js";
import { WatchPlayer, type WatchPlayerPropsForTest } from "./WatchPlayer.js";

vi.mock("../api/client.js", () => ({
  preparePlayback: vi.fn()
}));

vi.mock("./hls.js", () => ({
  attachVideoSource: vi.fn(() => vi.fn())
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
    }, expect.any(Function));
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

function playbackResponse() {
  return {
    playback: {
      itemId: "movie-1",
      mediaSourceId: "media-1",
      playMethod: "hls" as const,
      streamUrl: "/media/hls/ticket/master.m3u8",
      expiresAt: "2026-07-09T12:00:00.000Z",
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
      }]
    }
  };
}
