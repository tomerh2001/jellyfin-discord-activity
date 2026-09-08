/** Loaded once as a classic script by the native Jellyfin document. No UI mount. */
export { startActivitySession, resumeActivitySession, clearActivitySession, StartupTimeout } from "./discord/session.js";
export { logout } from "./api/client.js";
export {
  getConnections, getParty, joinParty, launchNative, matchesPartyServer,
  savePreference, connectAccount, connectCommunity, deleteConnection,
  startQuickConnect, pollQuickConnect
} from "./api/native.js";
export { onSessionRejected } from "./api/sessionRecovery.js";
export { closeDiscordActivity, getConnectedParticipants } from "./discord/sdk.js";
export { observeActivityPresentation } from "./discord/presentation.js";

export type { ActivitySession } from "./discord/session.js";
export type { ActivityDiscordContext } from "./discord/sdk.js";
export type { ActivityParticipant } from "./discord/participants.js";
export type { ActivityLayout, ActivityPresentation } from "./discord/presentation.js";
export type { Connection, Connections, Party, NativeLaunch, QuickConnect } from "./api/native.js";

declare global {
  interface Window { JellyfinWatch: typeof import("./library.js"); }
}
