import { useEffect, useRef } from "react";
import type { NativeLaunch } from "../api/native.js";

const CHANNEL = "jellyfin-watch-native";
const statuses = new Set(["joining", "connected", "disconnected", "reconnecting", "reauthorize", "error", "signed-out", "playing", "browsing", "playback"]);

export function NativeClient({ launch, onStatus }: { launch: NativeLaunch; onStatus: (status: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const statusCallback = useRef(onStatus);
  statusCallback.current = onStatus;
  useEffect(() => {
    let nonce: string | undefined;
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (!event.data || typeof event.data !== "object") return;
      const data = event.data as Record<string, unknown>;
      if (data.channel !== CHANNEL || typeof data.nonce !== "string" || !/^[a-zA-Z0-9-]{16,100}$/.test(data.nonce)) return;
      if (data.type === "ready") {
        nonce = data.nonce;
        frame.current?.contentWindow?.postMessage({ channel: CHANNEL, type: "bootstrap", nonce, launch }, window.location.origin);
      } else if (data.type === "status" && data.nonce === nonce && typeof data.status === "string" && statuses.has(data.status)) {
        statusCallback.current(data.status);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [launch]);
  return <iframe ref={frame} className="native-client" title="Jellyfin" src="/jellyfin-web/index.html"
    allow="autoplay; encrypted-media" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" />;
}
