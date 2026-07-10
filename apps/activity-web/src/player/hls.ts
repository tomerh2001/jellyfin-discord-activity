import Hls from "hls.js";

const highQualityBandwidthEstimate = 20_000_000;

export type PlayerSource = {
  playMethod: "hls" | "direct";
  streamUrl: string;
};

export type AttachVideoSourceOptions = {
  /** Prefer disabling workers inside Discord iframes (Linux Electron is flaky with workers). */
  enableWorker?: boolean;
  onError?: (message: string) => void;
  onInfo?: (message: string) => void;
};

export type ClientMediaCapabilities = {
  hlsJsSupported: boolean;
  mediaSourceSupported: boolean;
  canPlayMp4: string;
  canPlayH264: string;
  canPlayAac: string;
  canPlayWebm: string;
  canPlayVp9: string;
  canPlayOpus: string;
  isLinuxDiscord: boolean;
};

export function isHlsUrl(url: string): boolean {
  return url.includes(".m3u8");
}

export function isLinuxDiscordClient(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const ua = navigator.userAgent.toLowerCase();
  const isLinux = ua.includes("linux") && !ua.includes("android");
  const isDiscord = ua.includes("discord") || Boolean((window as Window & { DiscordNative?: unknown }).DiscordNative);

  return isLinux && isDiscord;
}

/**
 * Linux Discord often fails MPEG-TS H.264 and progressive H.264, and progressive WebM
 * underruns under load. Prefer fMP4 HLS first (baseline H.264), then realtime WebM (VP8).
 */
export function prefersForcedWebm(): boolean {
  return isLinuxDiscordClient();
}

/** @deprecated Prefer clientPlaybackLadder. */
export function prefersForcedHls(): boolean {
  return isLinuxDiscordClient();
}

/** @deprecated Use clientPlaybackLadder. */
export function prefersDirectPlayMethod(): boolean {
  return false;
}

/** Preferred playback ladder for this client (first entry is the initial attempt). */
export function clientPlaybackLadder(): Array<"hls" | "direct" | "webm"> {
  if (isLinuxDiscordClient()) {
    // 1) fMP4 HLS (baseline H.264) — smooth segments if the client accepts H.264 in fMP4
    // 2) realtime progressive WebM (VP8) — works when H.264 is rejected, tuned for encode speed
    // 3) progressive MP4 last resort
    return ["hls", "webm", "direct"];
  }

  return ["hls", "direct", "webm"];
}

/** Minimum forward buffer (seconds) before autoplay of progressive streams. */
export const progressiveMinBufferSeconds = 6;

export function probeClientMediaCapabilities(video?: HTMLVideoElement | null): ClientMediaCapabilities {
  const probe = video ?? (typeof document !== "undefined" ? document.createElement("video") : null);
  const canPlay = (type: string): string => {
    if (!probe) {
      return "unknown";
    }

    try {
      return probe.canPlayType(type) || "no";
    } catch {
      return "error";
    }
  };

  return {
    hlsJsSupported: typeof Hls !== "undefined" && Hls.isSupported(),
    mediaSourceSupported: typeof window !== "undefined" && typeof window.MediaSource !== "undefined",
    canPlayMp4: canPlay("video/mp4"),
    canPlayH264: canPlay('video/mp4; codecs="avc1.42E01E"'),
    canPlayAac: canPlay('audio/mp4; codecs="mp4a.40.2"'),
    canPlayWebm: canPlay("video/webm"),
    canPlayVp9: canPlay('video/webm; codecs="vp9"'),
    canPlayOpus: canPlay('audio/webm; codecs="opus"'),
    isLinuxDiscord: isLinuxDiscordClient()
  };
}

export async function probeStreamUrl(streamUrl: string): Promise<{
  ok: boolean;
  status?: number | undefined;
  contentType?: string | undefined;
  acceptRanges?: string | undefined;
  error?: string | undefined;
}> {
  try {
    const response = await fetch(streamUrl, {
      method: "GET",
      headers: {
        Range: "bytes=0-1"
      }
    });
    const contentType = response.headers.get("content-type");
    const acceptRanges = response.headers.get("accept-ranges");

    return {
      ok: response.ok || response.status === 206,
      status: response.status,
      ...(contentType ? { contentType } : {}),
      ...(acceptRanges ? { acceptRanges } : {})
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "stream probe failed"
    };
  }
}

export function attachVideoSource(
  video: HTMLVideoElement,
  source: PlayerSource,
  onErrorOrOptions?: ((message: string) => void) | AttachVideoSourceOptions
): () => void {
  const options: AttachVideoSourceOptions = typeof onErrorOrOptions === "function"
    ? { onError: onErrorOrOptions }
    : (onErrorOrOptions ?? {});
  const onError = options.onError;
  const onInfo = options.onInfo;
  const enableWorker = options.enableWorker ?? false;

  if (source.playMethod === "hls" || isHlsUrl(source.streamUrl)) {
    if (Hls.isSupported()) {
      let networkRecoveryAttempts = 0;
      let mediaRecoveryAttempted = false;
      const hls = new Hls({
        abrEwmaDefaultEstimate: highQualityBandwidthEstimate,
        abrEwmaDefaultEstimateMax: highQualityBandwidthEstimate,
        capLevelToPlayerSize: false,
        enableWorker,
        lowLatencyMode: false,
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 60
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        onInfo?.("HLS manifest parsed.");
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) {
          onInfo?.(`HLS non-fatal ${data.type}: ${data.details}`);
          return;
        }

        const responseCode = data.response?.code;
        const responseText = data.response?.text
          ? ` body=${String(data.response.text).slice(0, 120)}`
          : "";
        const codePart = responseCode !== undefined ? ` code=${responseCode}` : "";

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) {
            onError?.(`HLS network error${codePart}: ${data.details}.${responseText}`);
            hls.destroy();
            return;
          }

          if (networkRecoveryAttempts >= 2) {
            onError?.(`HLS network error${codePart}: ${data.details}.${responseText}`);
            hls.destroy();
            return;
          }

          networkRecoveryAttempts += 1;
          onInfo?.(`HLS network recovery attempt ${networkRecoveryAttempts}: ${data.details}`);
          hls.startLoad();
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (!mediaRecoveryAttempted) {
            mediaRecoveryAttempted = true;
            onInfo?.(`HLS media recovery: ${data.details}`);
            hls.recoverMediaError();
            return;
          }

          hls.destroy();
          onError?.(`Video decoder error while playing HLS media: ${data.details}.`);
          return;
        }

        onError?.(`HLS playback failed (${data.type}): ${data.details}.${codePart}${responseText}`);
        hls.destroy();
      });
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        onInfo?.("HLS media attached; loading source.");
        hls.loadSource(source.streamUrl);
      });

      return () => hls.destroy();
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      onInfo?.("Using native HLS.");
      video.src = source.streamUrl;
      return () => clearVideo(video);
    }

    onError?.("HLS playback is not supported by this Discord client (no MSE / native HLS).");
    return () => clearVideo(video);
  }

  // Progressive path — set explicit MIME hint for picky Chromium embeds.
  video.setAttribute("preload", "auto");
  const isWebm = source.streamUrl.includes(".webm");
  video.setAttribute("type", isWebm ? "video/webm" : "video/mp4");
  onInfo?.(isWebm
    ? "Attaching progressive WebM source (live-transcode; waiting for buffer before play)."
    : "Attaching progressive MP4 source.");
  video.src = source.streamUrl;
  return () => clearVideo(video);
}

export function bufferedAheadSeconds(video: HTMLVideoElement): number {
  if (!video.buffered.length) {
    return 0;
  }

  try {
    const end = video.buffered.end(video.buffered.length - 1);
    return Math.max(0, end - video.currentTime);
  } catch {
    return 0;
  }
}

/** Wait until progressive media has enough forward buffer, or timeout. */
export async function waitForProgressiveBuffer(
  video: HTMLVideoElement,
  minSeconds: number,
  timeoutMs = 20_000
): Promise<{ ready: boolean; bufferedSeconds: number }> {
  return new Promise((resolve) => {
    let settled = false;
    let poll = 0;
    let timeout = 0;

    const finish = (ready: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("canplay", onProgress);
      video.removeEventListener("loadeddata", onProgress);
      if (poll) {
        window.clearInterval(poll);
      }
      if (timeout) {
        window.clearTimeout(timeout);
      }
      resolve({ ready, bufferedSeconds: bufferedAheadSeconds(video) });
    };

    const onProgress = () => {
      if (bufferedAheadSeconds(video) >= minSeconds) {
        finish(true);
      }
    };

    onProgress();
    video.addEventListener("progress", onProgress);
    video.addEventListener("canplay", onProgress);
    video.addEventListener("loadeddata", onProgress);

    // Some Electron builds under-report progress events.
    poll = window.setInterval(onProgress, 250);
    timeout = window.setTimeout(() => {
      finish(bufferedAheadSeconds(video) >= minSeconds * 0.5);
    }, timeoutMs);
  });
}

function clearVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.removeAttribute("type");
  video.load();
}
