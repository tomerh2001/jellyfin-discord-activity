import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActivityDiscordContext } from "../discord/sdk.js";

export type ActivityLayout = "focused" | "pip" | "grid";
export type NativePresentation = { layout: ActivityLayout; preview: boolean };

const smallViewport = () => window.innerWidth <= 480 && window.innerHeight <= 300;
export const fullscreenUnavailable = "This Discord client does not allow web fullscreen. Use Discord’s window fullscreen control, if available.";

/** Must be called directly by a click handler, before any awaited operation. */
export async function toggleActivityFullscreen(element: HTMLElement): Promise<void> {
  const document = element.ownerDocument;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    if (!element.requestFullscreen || document.fullscreenEnabled === false) throw new Error(fullscreenUnavailable);
    await element.requestFullscreen({ navigationUI: "hide" });
  }
}

export function useActivityPresentation(discord: ActivityDiscordContext, enabled = true) {
  const [layout, setLayout] = useState<ActivityLayout>("focused");
  const [small, setSmall] = useState(smallViewport);
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement));
  useEffect(() => {
    const resized = () => setSmall(smallViewport());
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    window.addEventListener("resize", resized);
    document.addEventListener("fullscreenchange", changed);
    return () => { window.removeEventListener("resize", resized); document.removeEventListener("fullscreenchange", changed); };
  }, []);
  useEffect(() => {
    const sdk = discord.sdk;
    if (!enabled || !sdk?.subscribe) return;
    let cancelled = false;
    const updated = ({ layout_mode }: { layout_mode: number }) => {
      if (!cancelled && layout_mode >= 0 && layout_mode <= 2) setLayout((["focused", "pip", "grid"] as const)[layout_mode]!);
    };
    // Layout changes resize the existing native frame; they never restart OAuth,
    // exchange capabilities, or recreate Jellyfin's player/WebSocket.
    void sdk.subscribe("ACTIVITY_LAYOUT_MODE_UPDATE", updated).catch(() => undefined);
    return () => {
      cancelled = true;
      // Let a StrictMode effect replay attach its replacement before SDK
      // unsubscribe decides whether to remove the remote subscription too.
      queueMicrotask(() => { void sdk.unsubscribe("ACTIVITY_LAYOUT_MODE_UPDATE", updated).catch(() => undefined); });
    };
  }, [discord, enabled]);
  const presentation = useMemo<NativePresentation>(() => ({ layout, preview: layout !== "focused" || small }), [layout, small]);
  const toggleFullscreen = useCallback((element: HTMLElement) => toggleActivityFullscreen(element), []);
  return { presentation, fullscreen, toggleFullscreen };
}
