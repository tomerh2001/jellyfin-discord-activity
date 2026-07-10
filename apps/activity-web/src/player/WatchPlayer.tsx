import { Maximize2, Minimize2, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { preparePlayback } from "../api/client.js";
import type { PlaybackPrepareResponse } from "../api/types.js";
import { Button } from "../components/Button.js";
import { attachVideoSource } from "./hls.js";
import {
  correctionForDrift,
  type RemotePlayerEvent,
  type RemoteStateUpdate,
  type SyncStatus
} from "./usePlaybackSync.js";

type WatchPlayerProps = {
  appToken: string | undefined;
  canPrepare: boolean;
  clockOffsetMs: number;
  isHost: boolean;
  itemId: string | undefined;
  mediaSourceId: string | undefined;
  audioStreamIndex: number | undefined;
  subtitleStreamIndex: number | undefined;
  stagedMedia: HostStagedMedia | undefined;
  onPrepareStagedMedia: (input: PreparedMediaSelection) => void;
  onPlayerEvent: (input: {
    action: "play" | "pause" | "seek" | "buffering" | "ended";
    positionSeconds: number;
  }) => boolean;
  onStateUpdate: (input: {
    playState: "playing" | "paused" | "buffering";
    positionSeconds: number;
  }) => boolean;
  remotePlayerEvent: RemotePlayerEvent | undefined;
  remoteStateUpdate: RemoteStateUpdate | undefined;
  syncStatus: SyncStatus;
  title: string | undefined;
};

export type WatchPlayerPropsForTest = WatchPlayerProps;

export type HostStagedMedia = {
  itemId: string;
  title: string;
  runtimeTicks?: number;
};

export type PreparedMediaSelection = HostStagedMedia & {
  mediaSourceId: string;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
};

type PlayerState =
  | { status: "idle" }
  | { status: "preparing" }
  | { status: "ready"; expiresAt: string; playMethod: "hls" | "direct" }
  | { status: "error"; message: string };

type PreflightState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

type PreparedTrackState = PlaybackPrepareResponse["playback"] | undefined;

export function WatchPlayer({
  appToken,
  canPrepare,
  clockOffsetMs,
  isHost,
  itemId,
  mediaSourceId,
  audioStreamIndex,
  subtitleStreamIndex,
  stagedMedia,
  onPrepareStagedMedia,
  onPlayerEvent,
  onStateUpdate,
  remotePlayerEvent,
  remoteStateUpdate,
  syncStatus,
  title
}: WatchPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoFrameRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const preparedKeyRef = useRef<string | undefined>(undefined);
  const suppressEventsUntilRef = useRef(0);
  const [playerState, setPlayerState] = useState<PlayerState>({ status: "idle" });
  const [playerNotice, setPlayerNotice] = useState<string | undefined>();
  const [stagedPlayback, setStagedPlayback] = useState<PreparedTrackState>();
  const [preflightState, setPreflightState] = useState<PreflightState>({ status: "idle" });
  const [stagedAudioStreamIndex, setStagedAudioStreamIndex] = useState<number | undefined>();
  const [stagedSubtitleStreamIndex, setStagedSubtitleStreamIndex] = useState(-1);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    cleanupRef.current?.();
    cleanupRef.current = undefined;
    preparedKeyRef.current = undefined;
    setPlayerState({ status: "idle" });
    setPlayerNotice(undefined);
  }, [itemId]);

  useEffect(() => () => cleanupRef.current?.(), []);

  useEffect(() => {
    function updateFullscreenState() {
      setIsFullscreen(currentFullscreenElement() === videoFrameRef.current);
    }

    document.addEventListener("fullscreenchange", updateFullscreenState);
    document.addEventListener("webkitfullscreenchange", updateFullscreenState);

    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreenState);
      document.removeEventListener("webkitfullscreenchange", updateFullscreenState);
    };
  }, []);

  useEffect(() => {
    setStagedPlayback(undefined);
    setPreflightState(stagedMedia ? { status: "loading" } : { status: "idle" });
    setStagedAudioStreamIndex(undefined);
    setStagedSubtitleStreamIndex(-1);
  }, [stagedMedia?.itemId]);

  useEffect(() => {
    if (!isHost || !appToken || !canPrepare || !stagedMedia) {
      return;
    }

    const token = appToken;
    const pendingItemId = stagedMedia.itemId;
    const controller = new AbortController();

    async function loadTrackOptions() {
      setPreflightState({ status: "loading" });

      try {
        const response = await preparePlayback(token, {
          itemId: pendingItemId
        });

        if (controller.signal.aborted) {
          return;
        }

        setStagedPlayback(response.playback);
        setStagedAudioStreamIndex(response.playback.selectedAudioStreamIndex);
        setStagedSubtitleStreamIndex(response.playback.selectedSubtitleStreamIndex >= 0
          ? response.playback.selectedSubtitleStreamIndex
          : -1);
        setPreflightState({ status: "ready" });
      } catch (error) {
        if (!controller.signal.aborted) {
          setStagedPlayback(undefined);
          setPreflightState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not load playback tracks."
          });
        }
      }
    }

    void loadTrackOptions();

    return () => controller.abort();
  }, [appToken, canPrepare, isHost, stagedMedia]);

  useEffect(() => {
    if (isHost || playerState.status !== "ready" || !remotePlayerEvent || !videoRef.current) {
      return;
    }

    const delayMs = Math.max(0, remotePlayerEvent.targetServerTs - (Date.now() + clockOffsetMs));
    const timeout = window.setTimeout(() => {
      const video = videoRef.current;

      if (!video) {
        return;
      }

      suppressEventsUntilRef.current = Date.now() + 2000;
      void applyRemotePlayerEvent(video, remotePlayerEvent).catch(() => {
        setPlayerNotice("Press play once to join host playback.");
      });
    }, delayMs);

    return () => window.clearTimeout(timeout);
  }, [clockOffsetMs, isHost, playerState.status, remotePlayerEvent]);

  useEffect(() => {
    if (!appToken || !canPrepare || !itemId || !videoRef.current) {
      return;
    }

    const prepareKey = `${itemId}:${mediaSourceId ?? ""}:${audioStreamIndex ?? ""}:${subtitleStreamIndex ?? ""}`;

    if (preparedKeyRef.current === prepareKey) {
      return;
    }

    preparedKeyRef.current = prepareKey;
    const token = appToken;
    const selectedItemId = itemId;
    const controller = new AbortController();

    async function prepareSelectedPlayback() {
      setPlayerState({ status: "preparing" });
      setPlayerNotice(undefined);

      try {
        const response = await preparePlayback(token, {
          itemId: selectedItemId,
          ...(mediaSourceId ? { mediaSourceId } : {}),
          ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
          ...(subtitleStreamIndex !== undefined && subtitleStreamIndex >= 0 ? { subtitleStreamIndex } : {})
        });

        if (controller.signal.aborted || !videoRef.current) {
          return;
        }

        const video = videoRef.current;
        const previousTime = video.currentTime;
        const wasPlaying = !video.paused && !video.ended;
        suppressEventsUntilRef.current = Date.now() + 2000;
        cleanupRef.current?.();
        cleanupRef.current = attachVideoSource(video, {
          playMethod: response.playback.playMethod,
          streamUrl: response.playback.streamUrl
        }, (message) => {
          setPlayerState({ status: "error", message });
        });
        if (previousTime > 0) {
          video.currentTime = previousTime;
        }
        if (wasPlaying) {
          void video.play().catch(() => {
            setPlayerNotice("Press play once to resume playback.");
          });
        }
        setPlayerState({
          status: "ready",
          expiresAt: response.playback.expiresAt,
          playMethod: response.playback.playMethod
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        preparedKeyRef.current = undefined;
        setPlayerState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not prepare playback."
        });
      }
    }

    void prepareSelectedPlayback();

    return () => controller.abort();
  }, [appToken, audioStreamIndex, canPrepare, itemId, mediaSourceId, subtitleStreamIndex]);

  useEffect(() => {
    if (isHost || playerState.status !== "ready" || !remoteStateUpdate || !videoRef.current) {
      return;
    }

    const video = videoRef.current;
    const elapsedSeconds = remoteStateUpdate.playState === "playing"
      ? Math.max(0, (Date.now() + clockOffsetMs - remoteStateUpdate.serverTs) / 1000)
      : 0;
    const targetSeconds = remoteStateUpdate.positionSeconds + elapsedSeconds;
    const correction = correctionForDrift(video.currentTime, targetSeconds);

    if (correction.type === "seek") {
      suppressEventsUntilRef.current = Date.now() + 2000;
      video.currentTime = targetSeconds;
      video.playbackRate = 1;
      if (remoteStateUpdate.playState === "playing") {
        void video.play().catch(() => {
          setPlayerNotice("Press play once to join host playback.");
        });
      }
      return;
    }

    video.playbackRate = correction.type === "rate" ? correction.rate : 1;

    if (remoteStateUpdate.playState === "playing" && video.paused) {
      void video.play().catch(() => {
        setPlayerNotice("Press play once to join host playback.");
      });
    }

    if (remoteStateUpdate.playState === "paused" && !video.paused) {
      video.pause();
    }
  }, [clockOffsetMs, isHost, playerState.status, remoteStateUpdate]);

  useEffect(() => {
    if (!isHost || playerState.status !== "ready") {
      return;
    }

    const interval = window.setInterval(() => {
      const video = videoRef.current;

      if (!video || video.ended) {
        return;
      }

      onStateUpdate({
        playState: video.paused ? "paused" : "playing",
        positionSeconds: video.currentTime
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isHost, onStateUpdate, playerState.status]);

  const disabledReason = playbackDisabledReason({ appToken, canPrepare, itemId });
  const stagedAudioValue = stagedAudioStreamIndex ?? stagedPlayback?.selectedAudioStreamIndex;

  return (
    <section className="player-shell">
      <div className="video-frame" ref={videoFrameRef}>
        <video
          controls
          onEnded={() => sendHostPlayerEvent("ended")}
          onError={() => handleVideoError()}
          onPause={() => sendHostPlayerEvent("pause")}
          onPlay={() => {
            setPlayerNotice(undefined);
            sendHostPlayerEvent("play");
          }}
          onSeeked={() => sendHostPlayerEvent("seek")}
          onWaiting={() => sendHostPlayerEvent("buffering")}
          playsInline
          poster=""
          ref={videoRef}
        />
        {playerState.status === "idle" ? (
          <div className="video-placeholder">
            <Play aria-hidden="true" />
          </div>
        ) : null}
        <button
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          className="fullscreen-button"
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          type="button"
        >
          {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      </div>
      <div className="player-footer">
        <span>{title ? `Selected: ${title}` : "No media selected."}</span>
        <span className="status-pill">{playerStatusLabel(playerState, syncStatus)}</span>
      </div>
      {disabledReason ? <p className="muted-line">{disabledReason}</p> : null}
      {playerState.status === "preparing" ? (
        <p className="muted-line">Preparing selected media.</p>
      ) : null}
      {playerState.status === "ready" && !isHost ? (
        <p className="muted-line">Playback will follow the host. If Discord blocks autoplay, press play once to join playback.</p>
      ) : null}
      {isHost && stagedMedia ? (
        <div className="host-prepare-panel">
          <div>
            <span className="eyebrow">Ready to prepare</span>
            <h3>{stagedMedia.title}</h3>
          </div>
          {preflightState.status === "loading" ? (
            <p className="muted-line">Loading audio and subtitle options.</p>
          ) : null}
          {preflightState.status === "error" ? (
            <p className="inline-error">{preflightState.message}</p>
          ) : null}
          {stagedPlayback && (stagedPlayback.audioTracks.length > 1 || stagedPlayback.subtitleTracks.length > 0) ? (
            <TrackControls
              audioTracks={stagedPlayback.audioTracks}
              audioValue={stagedAudioValue}
              onAudioChange={setStagedAudioStreamIndex}
              onSubtitleChange={setStagedSubtitleStreamIndex}
              subtitleTracks={stagedPlayback.subtitleTracks}
              subtitleValue={stagedSubtitleStreamIndex}
            />
          ) : null}
          <Button disabled={preflightState.status !== "ready" || !stagedPlayback} onClick={prepareStagedMedia}>
            Prepare playback
          </Button>
        </div>
      ) : null}
      {playerNotice ? <p className="muted-line">{playerNotice}</p> : null}
      {playerState.status === "error" ? <p className="inline-error">{playerState.message}</p> : null}
    </section>
  );

  function sendHostPlayerEvent(action: "play" | "pause" | "seek" | "buffering" | "ended"): void {
    const video = videoRef.current;

    if (!isHost || playerState.status !== "ready" || !video || Date.now() < suppressEventsUntilRef.current) {
      return;
    }

    onPlayerEvent({
      action,
      positionSeconds: video.currentTime
    });
  }

  function handleVideoError(): void {
    const error = videoRef.current?.error;

    if (!error) {
      setPlayerState({ status: "error", message: "Video playback failed." });
      return;
    }

    setPlayerState({
      status: "error",
      message: mediaErrorMessage(error)
    });
  }

  function prepareStagedMedia(): void {
    if (!stagedMedia || !stagedPlayback) {
      return;
    }

    const selectedAudio = stagedAudioStreamIndex ?? stagedPlayback.selectedAudioStreamIndex;

    onPrepareStagedMedia({
      ...stagedMedia,
      mediaSourceId: stagedPlayback.mediaSourceId,
      ...(selectedAudio !== undefined ? { audioStreamIndex: selectedAudio } : {}),
      ...(stagedSubtitleStreamIndex >= 0 ? { subtitleStreamIndex: stagedSubtitleStreamIndex } : {})
    });
  }

  function toggleFullscreen(): void {
    const frame = videoFrameRef.current;

    if (!frame) {
      return;
    }

    if (currentFullscreenElement()) {
      void exitFullscreen().catch(() => {
        setPlayerNotice("Fullscreen could not be closed by this client.");
      });
      return;
    }

    void requestElementFullscreen(frame).catch(() => {
      setPlayerNotice("Fullscreen is not available in this client.");
    });
  }
}

type FullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

function currentFullscreenElement(): Element | null {
  const fullscreenDocument = document as FullscreenDocument;

  return document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;
}

async function requestElementFullscreen(element: HTMLElement): Promise<void> {
  const fullscreenElement = element as FullscreenElement;

  if (element.requestFullscreen) {
    await element.requestFullscreen();
    return;
  }

  if (fullscreenElement.webkitRequestFullscreen) {
    await fullscreenElement.webkitRequestFullscreen();
    return;
  }

  throw new Error("Fullscreen is unavailable.");
}

async function exitFullscreen(): Promise<void> {
  const fullscreenDocument = document as FullscreenDocument;

  if (document.exitFullscreen) {
    await document.exitFullscreen();
    return;
  }

  if (fullscreenDocument.webkitExitFullscreen) {
    await fullscreenDocument.webkitExitFullscreen();
    return;
  }

  throw new Error("Fullscreen is unavailable.");
}

type TrackControlsProps = {
  audioTracks: NonNullable<PreparedTrackState>["audioTracks"];
  audioValue: number | undefined;
  subtitleTracks: NonNullable<PreparedTrackState>["subtitleTracks"];
  subtitleValue: number;
  onAudioChange: (value: number) => void;
  onSubtitleChange: (value: number) => void;
};

function TrackControls({
  audioTracks,
  audioValue,
  subtitleTracks,
  subtitleValue,
  onAudioChange,
  onSubtitleChange
}: TrackControlsProps) {
  return (
    <div className="track-controls" aria-label="Playback track controls">
      {audioTracks.length > 1 ? (
        <label>
          <span>Audio</span>
          <select
            onChange={(event) => onAudioChange(Number(event.target.value))}
            value={audioValue ?? ""}
          >
            {audioTracks.map((track) => (
              <option key={track.index} value={track.index}>
                {track.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {subtitleTracks.length > 0 ? (
        <label>
          <span>Subtitles</span>
          <select
            onChange={(event) => onSubtitleChange(Number(event.target.value))}
            value={subtitleValue}
          >
            <option value={-1}>Off</option>
            {subtitleTracks.map((track) => (
              <option key={track.index} value={track.index}>
                {track.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function mediaErrorMessage(error: MediaError): string {
  switch (error.code) {
    case 1:
      return "Video playback was aborted.";
    case 2:
      return "Video playback failed because the media stream was interrupted.";
    case 3:
      return "Video playback failed because the Discord client could not decode the media stream.";
    case 4:
      return "Video playback failed because the Discord client rejected the media source as unsupported.";
    default:
      return `Video playback failed with media error ${error.code}.`;
  }
}

function playbackDisabledReason(input: {
  appToken: string | undefined;
  canPrepare: boolean;
  itemId: string | undefined;
}): string | undefined {
  if (!input.appToken) {
    return "Authenticate with Discord before preparing playback.";
  }

  if (!input.canPrepare) {
    return "Link your Jellyfin account to play the selected item.";
  }

  if (!input.itemId) {
    return "Waiting for the host to select media.";
  }

  return undefined;
}

function playerStatusLabel(playerState: PlayerState, syncStatus: string): string {
  if (playerState.status === "ready") {
    return playerState.playMethod;
  }

  if (playerState.status === "preparing") {
    return "loading";
  }

  if (playerState.status === "error") {
    return "error";
  }

  return syncStatus;
}

async function applyRemotePlayerEvent(video: HTMLVideoElement, event: RemotePlayerEvent): Promise<void> {
  if (Math.abs(video.currentTime - event.positionSeconds) > 0.25 || event.action === "seek") {
    video.currentTime = event.positionSeconds;
  }

  if (event.action === "play") {
    await video.play();
    return;
  }

  if (event.action === "pause" || event.action === "seek" || event.action === "ended") {
    video.pause();
  }
}
