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
 * Linux Discord rejects many static remux/progressive originals with MEDIA_ERR_SRC_NOT_SUPPORTED.
 * Force HLS (segmented) for that client instead of remux/direct-first.
 */
export function prefersForcedHls(): boolean {
  return isLinuxDiscordClient();
}

/** @deprecated Use prefersForcedHls — Linux should not start on static remux. */
export function prefersDirectPlayMethod(): boolean {
  return false;
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
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) {
          return;
        }

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const responseCode = data.response?.code;

          if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) {
            onError?.(`HLS network error ${responseCode}: ${data.details}.`);
            hls.destroy();
            return;
          }

          if (networkRecoveryAttempts >= 2) {
            onError?.(`HLS network error: ${data.details}.`);
            hls.destroy();
            return;
          }

          networkRecoveryAttempts += 1;
          hls.startLoad();
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (!mediaRecoveryAttempted) {
            mediaRecoveryAttempted = true;
            hls.recoverMediaError();
            return;
          }

          hls.destroy();
          onError?.(`Video decoder error while playing HLS media: ${data.details}.`);
          return;
        }

        onError?.(`HLS playback failed: ${data.details}.`);
        hls.destroy();
      });
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(source.streamUrl);
      });

      return () => hls.destroy();
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = source.streamUrl;
      return () => clearVideo(video);
    }

    onError?.("HLS playback is not supported by this Discord client.");
    return () => clearVideo(video);
  }

  // Progressive MP4 path — set explicit MIME hint for picky Chromium embeds.
  video.setAttribute("preload", "auto");
  video.src = source.streamUrl;
  return () => clearVideo(video);
}

function clearVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}
