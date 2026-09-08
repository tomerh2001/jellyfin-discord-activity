import { useEffect, useRef } from "react";
import type { NativeLaunch } from "../api/native.js";
import type { NativePresentation } from "./useActivityPresentation.js";

const CHANNEL = "jellyfin-watch-native";
const statuses = new Set(["joining", "connected", "disconnected", "reconnecting", "reauthorize", "error", "signed-out", "playing", "browsing", "playback"]);

export function NativeClient({ launch, onStatus, onVideoChange, presentation }: {
  launch: NativeLaunch; onStatus: (status: string) => void;
  onVideoChange: (active: boolean) => void; presentation: NativePresentation;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const childNonce = useRef<string | undefined>(undefined);
  const statusCallback = useRef(onStatus);
  const videoCallback = useRef(onVideoChange);
  const currentPresentation = useRef(presentation);
  statusCallback.current = onStatus;
  videoCallback.current = onVideoChange;
  currentPresentation.current = presentation;
  useEffect(() => {
    childNonce.current = undefined;
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (!event.data || typeof event.data !== "object") return;
      const data = event.data as Record<string, unknown>;
      if (data.channel !== CHANNEL || typeof data.nonce !== "string" || !/^[a-zA-Z0-9-]{16,100}$/.test(data.nonce)) return;
      if (data.type === "ready") {
        childNonce.current = data.nonce;
        videoCallback.current(false);
        frame.current?.contentWindow?.postMessage({ channel: CHANNEL, type: "bootstrap", nonce: data.nonce, launch, presentation: currentPresentation.current }, window.location.origin);
      } else if (data.type === "status" && data.nonce === childNonce.current && typeof data.status === "string" && statuses.has(data.status)) {
        statusCallback.current(data.status);
      } else if (data.type === "video" && data.nonce === childNonce.current && typeof data.active === "boolean") {
        videoCallback.current(data.active);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [launch]);
  useEffect(() => {
    if (childNonce.current) frame.current?.contentWindow?.postMessage({ channel: CHANNEL, type: "presentation", nonce: childNonce.current, presentation }, window.location.origin);
  }, [presentation]);
  return <iframe ref={frame} className="native-client" title="Jellyfin" src="/jellyfin-web/index.html"
    allow="autoplay; encrypted-media; fullscreen" allowFullScreen sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" />;
}
