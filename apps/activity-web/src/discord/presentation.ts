import type { ActivityDiscordContext } from "./sdk.js";

export type ActivityLayout = "focused" | "pip" | "grid";
export type ActivityPresentation = { layout: ActivityLayout; preview: boolean };

/** Layout updates only describe the current document; they never restart it. */
export function observeActivityPresentation(discord: ActivityDiscordContext, callback: (presentation: ActivityPresentation) => void): () => void {
  let layout: ActivityLayout = "focused";
  let active = true;
  let previous: ActivityPresentation | undefined;
  const report = () => {
    if (!active) return;
    const preview = layout !== "focused" || (window.innerWidth <= 480 && window.innerHeight <= 300);
    if (previous?.layout === layout && previous.preview === preview) return;
    previous = { layout, preview };
    callback({ ...previous });
  };
  const updated = ({ layout_mode }: { layout_mode: number }) => {
    if (!active || !Number.isInteger(layout_mode) || layout_mode < 0 || layout_mode > 2) return;
    layout = (["focused", "pip", "grid"] as const)[layout_mode]!;
    report();
  };
  const sdk = discord.sdk;
  window.addEventListener("resize", report);
  if (sdk) void sdk.subscribe("ACTIVITY_LAYOUT_MODE_UPDATE", updated).catch(() => undefined);
  report();
  return () => {
    if (!active) return;
    active = false;
    window.removeEventListener("resize", report);
    // A replacement observer may attach in the same turn. Let it do so before
    // the SDK decides whether to remove the shared remote subscription as well.
    if (sdk) queueMicrotask(() => { void sdk.unsubscribe("ACTIVITY_LAYOUT_MODE_UPDATE", updated).catch(() => undefined); });
  };
}
