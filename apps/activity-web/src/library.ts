/** Loaded once as a classic script by the native Jellyfin document. No UI mount. */
import { startActivitySession } from "./discord/session.js";
export { startActivitySession, resumeActivitySession, clearActivitySession, StartupTimeout } from "./discord/session.js";
export { logout } from "./api/client.js";
export {
  getConnections, getParty, joinParty, launchNative, matchesPartyServer,
  savePreference, connectAccount, connectCommunity, deleteConnection,
  startQuickConnect, pollQuickConnect, saveNativeRestore
} from "./api/native.js";
export { normalizeNativeRoute } from "@app/shared";
export { onSessionRejected } from "./api/sessionRecovery.js";
export { closeDiscordActivity, getConnectedParticipants } from "./discord/sdk.js";
export { observeActivityPresentation } from "./discord/presentation.js";
export { createWatchPresence } from "./discord/richPresence.js";

export type { ActivitySession } from "./discord/session.js";
export type { ActivityDiscordContext } from "./discord/sdk.js";
export type { ActivityParticipant } from "./discord/participants.js";
export type { ActivityLayout, ActivityPresentation } from "./discord/presentation.js";
export type { Connection, Connections, Party, NativeLaunch, QuickConnect } from "./api/native.js";

declare global {
  interface Window { JellyfinWatch: typeof import("./library.js"); }
}

// Begin the existing, deduplicated handshake while the browser downloads and
// initializes native Jellyfin. No account/party action depends on this preload;
// the native controller still awaits verified authentication before proceeding.
// A later native start shares this operation (or retries a failed preload), so
// no promise rejection escapes before the native error dialog is available.
if (new URLSearchParams(window.location.search).has("frame_id")) {
  void startActivitySession().catch(() => {});
}
