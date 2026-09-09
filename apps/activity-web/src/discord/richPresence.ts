import type { DiscordSDK } from "@discord/embedded-app-sdk";
import type { ActivityDiscordContext } from "./sdk.js";

/** Deliberately excludes Jellyfin server addresses, identifiers and credentials. */
export type WatchSnapshot = {
  kind: "episode" | "movie" | "audio" | "video";
  title: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeEndNumber?: number;
  year?: number;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  buffering: boolean;
  playbackRate: number;
};

type Activity = NonNullable<Parameters<DiscordSDK["commands"]["setActivity"]>[0]["activity"]>;
const MIN_INTERVAL_MS = 5_000;
const RETRY_DELAY_MS = 30_000;

// Discord's presence text fields have small limits. Preserve whole Unicode
// characters and reserve room for episode numbers/status when names are long.
function clipped(value: string, limit = 128): string {
  // eslint-disable-next-line no-control-regex -- Strip controls from display metadata.
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  let result = "";
  for (const char of clean) {
    if (result.length + char.length > limit - 1) break;
    result += char;
  }
  return `${result}…`;
}

function numbered(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function time(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function safeMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function formatWatchActivity(snapshot: WatchSnapshot, now: number, iconUrl?: string): Activity {
  const title = clipped(snapshot.title) || (snapshot.kind === "audio" ? "Audio" : "Video");
  let details = title;
  if (snapshot.kind === "episode") {
    const season = numbered(snapshot.seasonNumber) ? ` · Season ${snapshot.seasonNumber}` : "";
    const episode = numbered(snapshot.episodeNumber)
      ? ` · Episode ${snapshot.episodeNumber}${numbered(snapshot.episodeEndNumber) && snapshot.episodeEndNumber > snapshot.episodeNumber ? `–${snapshot.episodeEndNumber}` : ""}` : "";
    const suffix = season + episode;
    details = clipped(snapshot.seriesName || title, 128 - suffix.length) + suffix;
  } else if (snapshot.kind === "movie" && numbered(snapshot.year) && snapshot.year > 0) {
    const suffix = ` (${snapshot.year})`;
    details = clipped(title, 128 - suffix.length) + suffix;
  }
  const duration = safeMs(snapshot.durationMs);
  const position = Math.min(safeMs(snapshot.positionMs), duration || Infinity);
  const status = snapshot.buffering ? "Buffering" : snapshot.paused ? "Paused" : "Playing";
  const progress = snapshot.paused || snapshot.buffering ? ` · ${time(position)}${duration ? ` / ${time(duration)}` : ""}` : "";
  const stateSuffix = `${status}${progress}`;
  const state = snapshot.kind === "episode" && snapshot.seriesName && title !== clipped(snapshot.seriesName)
    ? `${clipped(title, 128 - stateSuffix.length - 3)} · ${stateSuffix}` : stateSuffix;
  const rate = Number.isFinite(snapshot.playbackRate) && snapshot.playbackRate > 0 ? snapshot.playbackRate : 1;
  const displayDetails = details.length < 2 ? `${details} · ${snapshot.kind === "audio" ? "Audio" : "Video"}` : details;
  return {
    type: snapshot.kind === "audio" ? 2 : 3,
    details: displayDetails,
    state,
    timestamps: snapshot.paused || snapshot.buffering ? null : {
      // SET_ACTIVITY (RPC) accepts Unix seconds, unlike received Gateway events.
      start: Math.floor((now - position / rate) / 1000),
      ...(duration ? { end: Math.floor((now + (duration - position) / rate) / 1000) } : {})
    },
    assets: iconUrl ? { large_image: iconUrl, large_text: displayDetails } : null
  };
}

function applicationIcon(context: ActivityDiscordContext): string | undefined {
  const app = context.application;
  // Public Discord artwork only. Never publish protected Jellyfin artwork URLs.
  return app && /^\d{1,30}$/.test(app.id) && /^(?:a_)?[a-f\d]{32}$/.test(app.icon ?? "")
    ? `https://cdn.discordapp.com/app-icons/${app.id}/${app.icon}.png` : undefined;
}

const transports = new WeakMap<DiscordSDK, { publisher: ReturnType<typeof createPublisher>; owner: number }>();

/** One transport per authenticated Discord document, with an account-local lease. */
export function createWatchPresence(context: ActivityDiscordContext) {
  const sdk = context.sdk;
  if (context.isMock || context.isStandalone || !sdk || !context.grantedScopes?.includes("rpc.activities.write")) {
    return { update(_snapshot: WatchSnapshot | null) {}, clear() {}, dispose() {} };
  }
  let transport = sdk ? transports.get(sdk) : undefined;
  if (!transport) {
    transport = { publisher: createPublisher(context), owner: 0 };
    if (sdk) transports.set(sdk, transport);
  }
  const current = transport;
  const owner = ++current.owner;
  let closed = false;
  current.publisher.clear();
  const update = (snapshot: WatchSnapshot | null) => {
    if (!closed && current.owner === owner) current.publisher.update(snapshot);
  };
  return { update, clear: () => update(null), dispose() { update(null); closed = true; } };
}

/** Latest-state, rate-limited RPC publisher. Never participates in authentication. */
function createPublisher(context: ActivityDiscordContext) {
  const sdk = context.sdk;
  let enabled = !context.isMock && !context.isStandalone && !!sdk && context.grantedScopes?.includes("rpc.activities.write") === true;
  let desired: Activity | null = null;
  let published: Activity | null | undefined = null;
  let version = 0;
  let lastAttempt = -Infinity;
  let retryAfter = -Infinity;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const icon = applicationIcon(context);

  const cancelTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const same = (a: Activity | null | undefined, b: Activity | null | undefined) => JSON.stringify(a) === JSON.stringify(b);

  function flush() {
    cancelTimer();
    if (!enabled || !sdk || inFlight || same(desired, published)) return;
    const delay = Math.max(lastAttempt + MIN_INTERVAL_MS, retryAfter) - Date.now();
    if (delay > 0) { timer = setTimeout(flush, delay); return; }
    const sending = desired;
    const sendingVersion = version;
    inFlight = true;
    lastAttempt = Date.now();
    let deadline: ReturnType<typeof setTimeout>;
    const command = Promise.resolve().then(() => sdk.commands.setActivity({ activity: sending }));
    void Promise.race([command, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Presence response timed out")), 10_000);
    })]).then(() => {
      published = sending;
      retryAfter = -Infinity;
    }).catch((error: unknown) => {
      // A denied/unsupported command must never trigger another consent flow or
      // interrupt playback. Retry transient failures only after a fresh update.
      const code = (error as { code?: number } | null)?.code;
      if (code === 4002 || code === 4006 || code === 4009 || code === 4010) enabled = false;
      // A lost response doesn't prove that Discord didn't apply the command.
      published = undefined;
      retryAfter = Date.now() + RETRY_DELAY_MS;
    }).finally(() => {
      clearTimeout(deadline);
      inFlight = false;
      if (retryAfter === -Infinity || version !== sendingVersion) flush();
    });
  }

  function update(snapshot: WatchSnapshot | null) {
    if (!enabled) return;
    const next = snapshot ? formatWatchActivity(snapshot, Date.now(), icon) : null;
    // Native time updates can round the same playback clock by a second. Keep
    // its stable anchor so periodic reads don't become periodic Discord RPCs.
    if (next?.timestamps && desired?.timestamps && next.details === desired.details && next.state === desired.state
      && Math.abs((next.timestamps.start ?? 0) - (desired.timestamps.start ?? 0)) <= 2
      && Math.abs((next.timestamps.end ?? 0) - (desired.timestamps.end ?? 0)) <= 2) next.timestamps = desired.timestamps;
    if (!same(next, desired)) version++;
    desired = next;
    flush();
  }

  return {
    update,
    clear() { update(null); }
  };
}
