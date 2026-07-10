import Hls from "hls.js";

const highQualityBandwidthEstimate = 20_000_000;

export type PlayerSource = {
  playMethod: "hls" | "direct";
  streamUrl: string;
};

export function isHlsUrl(url: string): boolean {
  return url.endsWith(".m3u8");
}

export function attachVideoSource(video: HTMLVideoElement, source: PlayerSource, onError?: (message: string) => void): () => void {
  if (source.playMethod === "hls" || isHlsUrl(source.streamUrl)) {
    if (Hls.isSupported()) {
      let networkRecoveryAttempts = 0;
      let mediaRecoveryAttempted = false;
      const hls = new Hls({
        abrEwmaDefaultEstimate: highQualityBandwidthEstimate,
        abrEwmaDefaultEstimateMax: highQualityBandwidthEstimate,
        capLevelToPlayerSize: false,
        enableWorker: true
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

  video.src = source.streamUrl;
  return () => clearVideo(video);
}

function clearVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}
