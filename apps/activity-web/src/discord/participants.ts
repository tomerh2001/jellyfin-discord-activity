import type { ActivityDiscordContext } from "./sdk.js";

export type ActivityParticipant = {
  id: string;
  displayName: string;
  avatarUrl?: string;
  isSelf: boolean;
};

export type ActivityParticipantsSnapshot = {
  participants: ActivityParticipant[];
  loading: boolean;
  error?: string;
};

type DiscordParticipant = {
  id: string;
  username: string;
  nickname?: string | undefined;
  global_name?: string | null | undefined;
  avatar?: string | null | undefined;
};

const EVENT = "ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE";
const LOAD_ERROR = "Could not load everyone in this Activity. Open this list again to retry.";
const LIVE_ERROR = "Live participant updates are unavailable. Open this list again to refresh.";

/** Display data only. SDK roster membership never grants Jellyfin access. */
export function mapActivityParticipants(context: ActivityDiscordContext, users: readonly DiscordParticipant[]): ActivityParticipant[] {
  const seen = new Set<string>();
  return users.filter(user => {
    if (!user.id || seen.has(user.id)) return false;
    seen.add(user.id); return true;
  }).map(user => {
    const avatarUrl = /^\d{1,24}$/.test(user.id) && /^(?:a_)?[a-f\d]{32}$/i.test(user.avatar ?? "")
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : undefined;
    return {
      id: user.id,
      displayName: user.nickname?.trim() || user.global_name?.trim() || user.username,
      ...(avatarUrl ? { avatarUrl } : {}),
      isSelf: user.id === context.user?.id
    };
  }).sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
}

export function selfParticipant(context: ActivityDiscordContext): ActivityParticipant[] {
  return context.user ? mapActivityParticipants(context, [{
    id: context.user.id, username: context.user.username,
    ...(context.user.globalName !== undefined ? { global_name: context.user.globalName } : {}),
    ...(context.user.avatar !== undefined ? { avatar: context.user.avatar } : {})
  }]) : [];
}

/** One initial snapshot plus push updates; refreshing the panel never reauthenticates. */
export function observeActivityParticipants(context: ActivityDiscordContext, onChange: (snapshot: ActivityParticipantsSnapshot) => void): {
  dispose(): void;
  refresh(): Promise<void>;
} {
  const sdk = context.sdk;
  let active = true;
  let revision = 0;
  let participants = selfParticipant(context);
  let loading = Boolean(sdk);
  let loadError: string | undefined;
  let liveError: string | undefined;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    const error = loadError || liveError;
    if (active) onChange({ participants: participants.map(value => ({ ...value })), loading,
      ...(error ? { error } : {}) });
  };
  const updated = (value: { participants: DiscordParticipant[] }) => {
    if (!active) return;
    revision += 1;
    participants = mapActivityParticipants(context, value.participants);
    loading = false;
    loadError = undefined;
    liveError = undefined;
    publish();
  };
  const refresh = (): Promise<void> => {
    if (!active || !sdk) return Promise.resolve();
    if (pending) return pending;
    const startingRevision = revision;
    loading = true;
    loadError = undefined;
    publish();
    pending = (async () => {
      try {
        const result = await Promise.race([
          sdk.commands.getActivityInstanceConnectedParticipants(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Participant request timed out")), 10_000); })
        ]);
        // A join/leave push that arrives during this request is newer than the
        // request's snapshot. Never resurrect a departed person with late data.
        if (active && revision === startingRevision) participants = mapActivityParticipants(context, result.participants);
      } catch {
        if (active && revision === startingRevision) loadError = LOAD_ERROR;
      } finally {
        clearTimeout(timer); timer = undefined;
        loading = false;
        pending = undefined;
        publish();
      }
    })();
    return pending;
  };
  publish();
  if (sdk) {
    void sdk.subscribe(EVENT, updated).catch(() => {
      if (!active) return;
      liveError = LIVE_ERROR; publish();
    });
    void refresh();
  }
  return {
    refresh,
    dispose() {
      if (!active) return;
      active = false;
      clearTimeout(timer); timer = undefined;
      // Let a replacement observer attach before the SDK decides whether this
      // is the last local subscriber and removes its remote subscription.
      if (sdk) queueMicrotask(() => { void sdk.unsubscribe(EVENT, updated).catch(() => undefined); });
    }
  };
}
