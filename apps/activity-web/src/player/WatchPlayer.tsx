import { Maximize2, Minimize2, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { preparePlayback } from "../api/client.js";
import type { PlaybackPrepareResponse } from "../api/types.js";
import { Button } from "../components/Button.js";
import {
  attachVideoSource,
  clientPlaybackLadder,
  prefersForcedWebm,
  progressiveMinBufferSeconds,
  progressiveMinSoakMs,
  probeClientMediaCapabilities,
  probeStreamUrl,
  waitForProgressiveBuffer,
  type ClientMediaCapabilities
} from "./hls.js";
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
  | { status: "ready"; expiresAt: string; playMethod: "hls" | "direct"; streamUrl: string; videoCodec?: string; audioCodec?: string; mediaSourceId: string }
  | { status: "error"; message: string };

type PreflightState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

type PreparedTrackState = PlaybackPrepareResponse["playback"] | undefined;
type PreferredPlayMethod = "hls" | "direct" | "webm";

type PlaybackAttempt = {
  at: string;
  stage: "prepare" | "probe" | "attach" | "info" | "error" | "fallback" | "success" | "renew";
  preferredPlayMethod: PreferredPlayMethod;
  playMethod?: "hls" | "direct" | undefined;
  streamUrl?: string | undefined;
  container?: string | undefined;
  videoCodec?: string | undefined;
  audioCodec?: string | undefined;
  message?: string | undefined;
  probe?: {
    ok: boolean;
    status?: number | undefined;
    contentType?: string | undefined;
    acceptRanges?: string | undefined;
    error?: string | undefined;
  } | undefined;
};

type PlaybackDiagnostics = {
  preferredPlayMethod: PreferredPlayMethod;
  fallbackChain: PreferredPlayMethod[];
  attempts: PlaybackAttempt[];
  capabilities?: ClientMediaCapabilities | undefined;
  lastError?: string | undefined;
  lastPrepareAt?: string | undefined;
  playMethod?: "hls" | "direct" | undefined;
  streamUrl?: string | undefined;
  expiresAt?: string | undefined;
  videoCodec?: string | undefined;
  audioCodec?: string | undefined;
  mediaSourceId?: string | undefined;
  userAgent?: string | undefined;
};

function initialDiagnostics(method: PreferredPlayMethod, ladder: PreferredPlayMethod[], video?: HTMLVideoElement | null): PlaybackDiagnostics {
  return {
    preferredPlayMethod: method,
    fallbackChain: [method],
    attempts: [{
      at: new Date().toISOString(),
      stage: "info",
      preferredPlayMethod: method,
      message: `Player reset; ladder=${ladder.join(" → ")}.`
    }],
    capabilities: probeClientMediaCapabilities(video),
    ...(typeof navigator !== "undefined" ? { userAgent: navigator.userAgent } : {})
  };
}

function nextFallbackMethod(current: PreferredPlayMethod, ladder: PreferredPlayMethod[]): PreferredPlayMethod | undefined {
  const index = ladder.indexOf(current);
  if (index < 0) {
    return ladder[0];
  }

  return ladder[index + 1];
}

function methodNotice(method: PreferredPlayMethod, linuxClient: boolean): string | undefined {
  if (method === "webm") {
    return linuxClient
      ? "Linux Discord: VP8/Opus WebM @480p (H.264 unsupported; prebuffering for smoother play)."
      : "Trying VP8/Opus WebM compatibility stream.";
  }

  if (method === "direct") {
    return "Trying forced H.264/AAC progressive MP4.";
  }

  return undefined;
}

const ticketRenewLeadMs = 60_000;

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
  const prepareGenerationRef = useRef(0);
  const playbackLadder = clientPlaybackLadder() as PreferredPlayMethod[];
  const initialMethod = playbackLadder[0] ?? "hls";
  const activeStageRef = useRef<PreferredPlayMethod>(initialMethod);
  const suppressEventsUntilRef = useRef(0);
  const appliedRemoteEventRef = useRef<RemotePlayerEvent | undefined>(undefined);
  const progressiveBufferingRef = useRef(false);
  const renewInFlightRef = useRef(false);
  const loggedPlaySuccessRef = useRef(false);
  const diagnosticsRef = useRef<PlaybackDiagnostics>(initialDiagnostics(initialMethod, playbackLadder));
  const [playerState, setPlayerState] = useState<PlayerState>({ status: "idle" });
  const [playerNotice, setPlayerNotice] = useState<string | undefined>();
  const [stagedPlayback, setStagedPlayback] = useState<PreparedTrackState>();
  const [preflightState, setPreflightState] = useState<PreflightState>({ status: "idle" });
  const [stagedAudioStreamIndex, setStagedAudioStreamIndex] = useState<number | undefined>();
  const [stagedSubtitleStreamIndex, setStagedSubtitleStreamIndex] = useState(-1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExpandedPlayer, setIsExpandedPlayer] = useState(false);
  const linuxClient = prefersForcedWebm();
  // Bound to itemId so a new media selection never prepares with a stale fallback method.
  const [playbackSession, setPlaybackSession] = useState<{ itemId: string | undefined; method: PreferredPlayMethod; generation: number }>(() => ({
    itemId: undefined,
    method: initialMethod,
    generation: 0
  }));
  const preferredPlayMethod = playbackSession.method;
  const [diagnostics, setDiagnostics] = useState<PlaybackDiagnostics>(() => initialDiagnostics(initialMethod, playbackLadder));
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | undefined>();

  function pushAttempt(attempt: Omit<PlaybackAttempt, "at">): void {
    const entry: PlaybackAttempt = {
      ...attempt,
      at: new Date().toISOString()
    };
    setDiagnostics((current) => {
      const next: PlaybackDiagnostics = {
        ...current,
        preferredPlayMethod: attempt.preferredPlayMethod,
        attempts: [...current.attempts, entry],
        ...(attempt.stage === "error" ? { lastError: attempt.message } : {}),
        ...(attempt.stage === "success" ? { lastError: undefined } : {}),
        ...(attempt.playMethod ? { playMethod: attempt.playMethod } : {}),
        ...(attempt.streamUrl ? { streamUrl: attempt.streamUrl } : {}),
        ...(attempt.videoCodec ? { videoCodec: attempt.videoCodec } : {}),
        ...(attempt.audioCodec ? { audioCodec: attempt.audioCodec } : {})
      };
      diagnosticsRef.current = next;
      return next;
    });
  }

  useEffect(() => {
    cleanupRef.current?.();
    cleanupRef.current = undefined;
    preparedKeyRef.current = undefined;
    const ladder = clientPlaybackLadder() as PreferredPlayMethod[];
    const start = ladder[0] ?? "hls";
    activeStageRef.current = start;
    renewInFlightRef.current = false;
    loggedPlaySuccessRef.current = false;
    progressiveBufferingRef.current = false;
    prepareGenerationRef.current += 1;
    setPlayerState({ status: "idle" });
    setPlayerNotice(methodNotice(start, linuxClient));
    setPlaybackSession({
      itemId,
      method: start,
      generation: prepareGenerationRef.current
    });
    const reset = initialDiagnostics(start, ladder, videoRef.current);
    diagnosticsRef.current = reset;
    setDiagnostics(reset);
    setCopyStatus(undefined);
  }, [itemId, linuxClient]);

  useEffect(() => () => cleanupRef.current?.(), []);

  useEffect(() => {
    function updateFullscreenState() {
      const frameIsFullscreen = currentFullscreenElement() === videoFrameRef.current;

      setIsFullscreen(frameIsFullscreen);
      if (frameIsFullscreen) {
        setIsExpandedPlayer(false);
      }
    }

    document.addEventListener("fullscreenchange", updateFullscreenState);
    document.addEventListener("webkitfullscreenchange", updateFullscreenState);

    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreenState);
      document.removeEventListener("webkitfullscreenchange", updateFullscreenState);
    };
  }, []);

  useEffect(() => {
    function collapseExpandedPlayer(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsExpandedPlayer(false);
      }
    }

    if (!isExpandedPlayer) {
      return;
    }

    document.body.classList.add("player-expanded-active");
    document.addEventListener("keydown", collapseExpandedPlayer);

    return () => {
      document.body.classList.remove("player-expanded-active");
      document.removeEventListener("keydown", collapseExpandedPlayer);
    };
  }, [isExpandedPlayer]);

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
    if (playerState.status !== "ready" || !remotePlayerEvent || !videoRef.current || appliedRemoteEventRef.current === remotePlayerEvent) {
      return;
    }

    if (progressiveBufferingRef.current) {
      return;
    }

    const delayMs = Math.max(0, remotePlayerEvent.targetServerTs - (Date.now() + clockOffsetMs));
    const timeout = window.setTimeout(() => {
      const video = videoRef.current;

      if (!video || progressiveBufferingRef.current) {
        return;
      }

      suppressEventsUntilRef.current = Date.now() + 2000;
      appliedRemoteEventRef.current = remotePlayerEvent;
      const lateBySeconds = remotePlayerEvent.action === "play"
        ? Math.max(0, (Date.now() + clockOffsetMs - remotePlayerEvent.targetServerTs) / 1000) : 0;
      void applyRemotePlayerEvent(video, { ...remotePlayerEvent, positionSeconds: remotePlayerEvent.positionSeconds + lateBySeconds }).catch(() => {
        setPlayerNotice("Press play once to join host playback.");
      });
    }, delayMs);

    return () => window.clearTimeout(timeout);
  }, [clockOffsetMs, playerState.status, remotePlayerEvent]);

  useEffect(() => {
    if (!appToken || !canPrepare || !itemId || !videoRef.current) {
      return;
    }

    // Ignore prepares until the session has been rebound to this itemId.
    if (playbackSession.itemId !== itemId) {
      return;
    }

    const prepareKey = `${itemId}:${mediaSourceId ?? ""}:${audioStreamIndex ?? ""}:${subtitleStreamIndex ?? ""}:${preferredPlayMethod}:${playbackSession.generation}`;

    if (preparedKeyRef.current === prepareKey) {
      return;
    }

    preparedKeyRef.current = prepareKey;
    const token = appToken;
    const selectedItemId = itemId;
    const sessionGeneration = playbackSession.generation;
    const controller = new AbortController();

    async function prepareSelectedPlayback() {
      setPlayerState({ status: "preparing" });
      setPlayerNotice(methodNotice(preferredPlayMethod, linuxClient));
      activeStageRef.current = preferredPlayMethod;
      pushAttempt({
        stage: "prepare",
        preferredPlayMethod,
        message: `Preparing playback with preferredPlayMethod=${preferredPlayMethod}.`
      });
      setDiagnostics((current) => ({
        ...current,
        preferredPlayMethod,
        lastPrepareAt: new Date().toISOString(),
        capabilities: probeClientMediaCapabilities(videoRef.current)
      }));

      try {
        // Always send preferred method for webm/direct, and for Linux (forced path).
        // On normal clients, omit preferredPlayMethod for the default "hls" slot so remux can win.
        const shouldSendPreferredMethod = preferredPlayMethod !== "hls" || linuxClient;
        const response = await preparePlayback(token, {
          itemId: selectedItemId,
          ...(mediaSourceId ? { mediaSourceId } : {}),
          ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
          ...(subtitleStreamIndex !== undefined && subtitleStreamIndex >= 0 ? { subtitleStreamIndex } : {}),
          ...(shouldSendPreferredMethod ? { preferredPlayMethod } : {})
        });

        if (controller.signal.aborted || !videoRef.current || sessionGeneration !== prepareGenerationRef.current) {
          return;
        }

        const video = videoRef.current;
        const previousTime = video.currentTime;
        const wasPlaying = !video.paused && !video.ended;
        const probe = await probeStreamUrl(response.playback.streamUrl);

        if (controller.signal.aborted || sessionGeneration !== prepareGenerationRef.current) {
          return;
        }

        pushAttempt({
          stage: "probe",
          preferredPlayMethod,
          playMethod: response.playback.playMethod,
          streamUrl: response.playback.streamUrl,
          container: response.playback.container,
          videoCodec: response.playback.videoCodec,
          audioCodec: response.playback.audioCodec,
          probe,
          message: probe.ok
            ? `Stream probe ok status=${probe.status} content-type=${probe.contentType ?? "n/a"}.`
            : `Stream probe failed status=${probe.status ?? "n/a"} error=${probe.error ?? "n/a"}.`
        });

        suppressEventsUntilRef.current = Date.now() + 2000;
        cleanupRef.current?.();
        activeStageRef.current = preferredPlayMethod;
        pushAttempt({
          stage: "attach",
          preferredPlayMethod,
          playMethod: response.playback.playMethod,
          streamUrl: response.playback.streamUrl,
          container: response.playback.container,
          videoCodec: response.playback.videoCodec,
          audioCodec: response.playback.audioCodec,
          message: `Attaching ${response.playback.playMethod} source.`
        });
        cleanupRef.current = attachVideoSource(video, {
          playMethod: response.playback.playMethod,
          streamUrl: response.playback.streamUrl
        }, {
          enableWorker: false,
          onError: (message) => {
            handlePlaybackSourceError(message);
          },
          onInfo: (message) => {
            pushAttempt({
              stage: "info",
              preferredPlayMethod,
              playMethod: response.playback.playMethod,
              streamUrl: response.playback.streamUrl,
              message
            });
          }
        });
        if (previousTime > 0) {
          video.currentTime = previousTime;
        }

        // Progressive live-transcodes underrun unless we soak before play.
        if (response.playback.playMethod === "direct") {
          progressiveBufferingRef.current = true;
          video.pause();
          setPlayerNotice(`Buffering progressive stream (~${Math.round(progressiveMinSoakMs / 1000)}s)…`);
          const bufferWait = await waitForProgressiveBuffer(video, progressiveMinBufferSeconds, progressiveMinSoakMs);
          if (controller.signal.aborted || sessionGeneration !== prepareGenerationRef.current) {
            progressiveBufferingRef.current = false;
            return;
          }

          pushAttempt({
            stage: "info",
            preferredPlayMethod,
            playMethod: response.playback.playMethod,
            streamUrl: response.playback.streamUrl,
            message: bufferWait.ready
              ? `Progressive ready (buffered=${bufferWait.bufferedSeconds.toFixed(1)}s readyState=${bufferWait.readyState} soaked=${bufferWait.soakedMs}ms).`
              : `Progressive partial (buffered=${bufferWait.bufferedSeconds.toFixed(1)}s readyState=${bufferWait.readyState} soaked=${bufferWait.soakedMs}ms); starting.`
          });
          progressiveBufferingRef.current = false;
          setPlayerNotice(undefined);
        }

        if (wasPlaying || response.playback.playMethod === "direct") {
          void video.play().catch(() => {
            setPlayerNotice("Press play once to resume playback.");
          });
        }
        setPlayerState({
          status: "ready",
          expiresAt: response.playback.expiresAt,
          playMethod: response.playback.playMethod,
          streamUrl: response.playback.streamUrl,
          mediaSourceId: response.playback.mediaSourceId,
          ...(response.playback.videoCodec ? { videoCodec: response.playback.videoCodec } : {}),
          ...(response.playback.audioCodec ? { audioCodec: response.playback.audioCodec } : {})
        });
        setDiagnostics((current) => ({
          ...current,
          preferredPlayMethod,
          playMethod: response.playback.playMethod,
          streamUrl: response.playback.streamUrl,
          expiresAt: response.playback.expiresAt,
          mediaSourceId: response.playback.mediaSourceId,
          lastPrepareAt: new Date().toISOString(),
          ...(response.playback.videoCodec ? { videoCodec: response.playback.videoCodec } : { videoCodec: undefined }),
          ...(response.playback.audioCodec ? { audioCodec: response.playback.audioCodec } : { audioCodec: undefined })
        }));
      } catch (error) {
        if (controller.signal.aborted || sessionGeneration !== prepareGenerationRef.current) {
          return;
        }

        preparedKeyRef.current = undefined;
        const message = error instanceof Error ? error.message : "Could not prepare playback.";
        pushAttempt({
          stage: "error",
          preferredPlayMethod,
          message: `Prepare failed: ${message}`
        });
        handlePlaybackSourceError(`Prepare failed: ${message}`);
      }
    }

    void prepareSelectedPlayback();

    return () => controller.abort();
  }, [appToken, audioStreamIndex, canPrepare, itemId, linuxClient, mediaSourceId, playbackSession, preferredPlayMethod, subtitleStreamIndex]);

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

      if (!video || video.ended || Date.now() < suppressEventsUntilRef.current) {
        return;
      }

      onStateUpdate({
        playState: video.paused ? "paused" : "playing",
        positionSeconds: video.currentTime
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isHost, onStateUpdate, playerState.status]);

  useEffect(() => {
    if (playerState.status !== "ready" || !appToken || !canPrepare || !itemId) {
      return;
    }

    const expiresAtMs = Date.parse(playerState.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }

    const renewAt = expiresAtMs - ticketRenewLeadMs - Date.now();
    const timeout = window.setTimeout(() => {
      void renewStreamTicket();
    }, Math.max(0, renewAt));

    return () => window.clearTimeout(timeout);
  }, [appToken, audioStreamIndex, canPrepare, itemId, mediaSourceId, playerState, preferredPlayMethod, subtitleStreamIndex]);

  const disabledReason = playbackDisabledReason({ appToken, canPrepare, itemId });
  const stagedAudioValue = stagedAudioStreamIndex ?? stagedPlayback?.selectedAudioStreamIndex;

  return (
    <section className="player-shell">
      <div className={isExpandedPlayer ? "video-frame video-frame-expanded" : "video-frame"} ref={videoFrameRef}>
        <video
          controls
          onEnded={() => sendHostPlayerEvent("ended")}
          onError={() => handleVideoError()}
          onPause={() => sendHostPlayerEvent("pause")}
          onPlay={() => {
            setPlayerNotice(undefined);
            if (!loggedPlaySuccessRef.current) {
              loggedPlaySuccessRef.current = true;
              pushAttempt({
                stage: "success",
                preferredPlayMethod: activeStageRef.current,
                playMethod: playerState.status === "ready" ? playerState.playMethod : undefined,
                streamUrl: playerState.status === "ready" ? playerState.streamUrl : undefined,
                message: "Video element fired play event."
              });
            }
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
          aria-label={isFullscreen || isExpandedPlayer ? "Exit fullscreen" : "Enter fullscreen"}
          className="fullscreen-button"
          onClick={toggleFullscreen}
          title={isFullscreen || isExpandedPlayer ? "Exit fullscreen" : "Enter fullscreen"}
          type="button"
        >
          {isFullscreen || isExpandedPlayer ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
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
      <div className="diagnostics-row">
        <button className="link-button" onClick={() => setShowDiagnostics((value) => !value)} type="button">
          {showDiagnostics ? "Hide diagnostics" : "Show diagnostics"}
        </button>
        {showDiagnostics ? (
          <button className="link-button" onClick={() => void copyDiagnostics()} type="button">
            Copy diagnostics
          </button>
        ) : null}
        {copyStatus ? <span className="muted-line">{copyStatus}</span> : null}
      </div>
      {showDiagnostics ? (
        <pre className="diagnostics-panel" aria-label="Playback diagnostics">
          {JSON.stringify(diagnostics, null, 2)}
        </pre>
      ) : null}
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
      handlePlaybackSourceError("Video playback failed.");
      return;
    }

    handlePlaybackSourceError(mediaErrorMessage(error));
  }

  function handlePlaybackSourceError(message: string): void {
    const stage = activeStageRef.current;
    pushAttempt({
      stage: "error",
      preferredPlayMethod: stage,
      message
    });

    const fallback = nextFallbackMethod(stage, playbackLadder);
    if (fallback) {
      preparedKeyRef.current = undefined;
      cleanupRef.current?.();
      cleanupRef.current = undefined;
      pushAttempt({
        stage: "fallback",
        preferredPlayMethod: fallback,
        message: `${stage} failed; falling back to ${fallback}. Cause: ${message}`
      });
      setDiagnostics((current) => ({
        ...current,
        fallbackChain: current.fallbackChain.includes(fallback)
          ? current.fallbackChain
          : [...current.fallbackChain, fallback],
        lastError: message
      }));
      setPlayerNotice(methodNotice(fallback, linuxClient));
      prepareGenerationRef.current += 1;
      setPlaybackSession((current) => ({
        itemId: current.itemId,
        method: fallback,
        generation: prepareGenerationRef.current
      }));
      return;
    }

    setPlayerState({ status: "error", message });
  }

  async function renewStreamTicket(): Promise<void> {
    if (!appToken || !itemId || renewInFlightRef.current || playerState.status !== "ready") {
      return;
    }

    renewInFlightRef.current = true;

    try {
      const renewMethod: PreferredPlayMethod = preferredPlayMethod;
      pushAttempt({
        stage: "renew",
        preferredPlayMethod: renewMethod,
        message: `Renewing stream ticket with preferredPlayMethod=${renewMethod}.`
      });
      const response = await preparePlayback(appToken, {
        itemId,
        ...(mediaSourceId ? { mediaSourceId } : {}),
        ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
        ...(subtitleStreamIndex !== undefined && subtitleStreamIndex >= 0 ? { subtitleStreamIndex } : {}),
        ...(renewMethod !== "hls" || linuxClient ? { preferredPlayMethod: renewMethod } : {})
      });

      const video = videoRef.current;
      if (!video) {
        return;
      }

      const previousTime = video.currentTime;
      const wasPlaying = !video.paused && !video.ended;
      suppressEventsUntilRef.current = Date.now() + 2000;
      cleanupRef.current?.();
      activeStageRef.current = renewMethod;
      cleanupRef.current = attachVideoSource(video, {
        playMethod: response.playback.playMethod,
        streamUrl: response.playback.streamUrl
      }, {
        enableWorker: false,
        onError: (message) => {
          handlePlaybackSourceError(message);
        },
        onInfo: (message) => {
          pushAttempt({
            stage: "info",
            preferredPlayMethod: renewMethod,
            playMethod: response.playback.playMethod,
            streamUrl: response.playback.streamUrl,
            message
          });
        }
      });
      if (previousTime > 0) {
        video.currentTime = previousTime;
      }
      if (wasPlaying) {
        void video.play().catch(() => {
          setPlayerNotice("Press play once to resume playback.");
        });
      }

      preparedKeyRef.current = `${itemId}:${mediaSourceId ?? ""}:${audioStreamIndex ?? ""}:${subtitleStreamIndex ?? ""}:${preferredPlayMethod}`;
      setPlayerState({
        status: "ready",
        expiresAt: response.playback.expiresAt,
        playMethod: response.playback.playMethod,
        streamUrl: response.playback.streamUrl,
        mediaSourceId: response.playback.mediaSourceId,
        ...(response.playback.videoCodec ? { videoCodec: response.playback.videoCodec } : {}),
        ...(response.playback.audioCodec ? { audioCodec: response.playback.audioCodec } : {})
      });
      setDiagnostics((current) => ({
        ...current,
        playMethod: response.playback.playMethod,
        streamUrl: response.playback.streamUrl,
        expiresAt: response.playback.expiresAt,
        mediaSourceId: response.playback.mediaSourceId,
        lastPrepareAt: new Date().toISOString(),
        ...(response.playback.videoCodec ? { videoCodec: response.playback.videoCodec } : { videoCodec: undefined }),
        ...(response.playback.audioCodec ? { audioCodec: response.playback.audioCodec } : { audioCodec: undefined })
      }));
      setPlayerNotice(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not renew stream ticket.";
      pushAttempt({
        stage: "error",
        preferredPlayMethod,
        message: `Ticket renew failed: ${message}`
      });
      setPlayerNotice("Stream ticket renewal failed. Playback may stop soon.");
    } finally {
      renewInFlightRef.current = false;
    }
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

  async function copyDiagnostics(): Promise<void> {
    const payload = JSON.stringify(diagnostics, null, 2);

    try {
      await navigator.clipboard.writeText(payload);
      setCopyStatus("Diagnostics copied.");
    } catch {
      setCopyStatus("Could not copy diagnostics.");
    }
  }

  function toggleFullscreen(): void {
    const frame = videoFrameRef.current;

    if (!frame) {
      return;
    }

    if (currentFullscreenElement()) {
      void exitFullscreen().catch(() => {
        setIsExpandedPlayer(false);
      });
      return;
    }

    if (isExpandedPlayer) {
      setIsExpandedPlayer(false);
      return;
    }

    if (!fullscreenIsEnabled()) {
      setIsExpandedPlayer(true);
      return;
    }

    void requestElementFullscreen(frame).catch(() => {
      setIsExpandedPlayer(true);
    });
  }
}

type FullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

function currentFullscreenElement(): Element | null {
  const fullscreenDocument = document as FullscreenDocument;

  return document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;
}

function fullscreenIsEnabled(): boolean {
  const fullscreenDocument = document as FullscreenDocument;

  return document.fullscreenEnabled || fullscreenDocument.webkitFullscreenEnabled === true;
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
