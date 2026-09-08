import { Activity, LogOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  claimRoomHost,
  exchangeDiscordCode,
  getCurrentRoom,
  getHealth,
  getMe,
  getPublicConfig,
  logout,
  selectRoomMedia
} from "./api/client.js";
import type {
  DiscordExchangeResponse,
  HealthResponse,
  JellyfinItem,
  MeResponse,
  PublicEnv,
  RoomResponse
} from "./api/types.js";
import { Button } from "./components/Button.js";
import { ErrorPanel } from "./components/ErrorPanel.js";
import { Loading } from "./components/Loading.js";
import {
  authenticateDiscord,
  authorizeDiscord,
  closeDiscordActivity,
  getConnectedParticipants,
  initializeDiscord,
  type ActivityDiscordContext
} from "./discord/sdk.js";
import type { ActivityParticipant } from "./discord/participants.js";
import { LinkAccount } from "./jellyfin/LinkAccount.js";
import { LibraryBrowser } from "./jellyfin/LibraryBrowser.js";
import { WatchPlayer, type HostStagedMedia, type PreparedMediaSelection } from "./player/WatchPlayer.js";
import { HostControls } from "./room/HostControls.js";
import { ParticipantList, type DisplayParticipant } from "./room/ParticipantList.js";
import { useRoomSync } from "./room/RoomProvider.js";

type BootState =
  | { status: "loading" }
  | { status: "ready"; discord: ActivityDiscordContext; health: HealthResponse; config: PublicEnv }
  | { status: "error"; message: string };

type AuthUiState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "authenticated"; exchange: DiscordExchangeResponse; me: MeResponse }
  | { status: "closed" }
  | { status: "error"; message: string };

export function App() {
  const [bootState, setBootState] = useState<BootState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    async function boot() {
      try {
        const [health, config] = await Promise.all([
          getHealth(controller.signal),
          getPublicConfig(controller.signal)
        ]);
        const discord = await initializeDiscord(config);

        setBootState({ status: "ready", discord, health, config });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        const message = error instanceof Error ? error.message : "Failed to boot Activity.";
        setBootState({ status: "error", message });
      }
    }

    void boot();

    return () => controller.abort();
  }, []);

  if (bootState.status === "loading") {
    return <Loading />;
  }

  if (bootState.status === "error") {
    return <ErrorPanel title="Activity failed to start" message={bootState.message} />;
  }

  return (
    <ActivityShell
      config={bootState.config}
      discord={bootState.discord}
    />
  );
}

type ActivityShellProps = {
  config: PublicEnv;
  discord: ActivityDiscordContext;
};

function ActivityShell({ config, discord }: ActivityShellProps) {
  const [authState, setAuthState] = useState<AuthUiState>({ status: "idle" });
  const [participants, setParticipants] = useState<ActivityParticipant[]>(() => fallbackParticipants(discord));
  const [jellyfinLinked, setJellyfinLinked] = useState(false);
  const [room, setRoom] = useState<RoomResponse["room"] | undefined>();
  const [roomError, setRoomError] = useState<string | undefined>();
  const [stagedMedia, setStagedMedia] = useState<HostStagedMedia | undefined>();
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | undefined>();
  const leavePending = useRef(false);
  const appToken = authState.status === "authenticated" ? authState.exchange.appToken : undefined;
  const hasLeft = authState.status === "closed";

  useEffect(() => {
    if (hasLeft) return;
    let cancelled = false;

    async function refreshParticipants() {
      try {
        const connected = await getConnectedParticipants(discord);

        if (!cancelled && connected.length > 0) {
          setParticipants(connected);
        }
      } catch {
        if (!cancelled) {
          setParticipants(fallbackParticipants(discord));
        }
      }
    }

    void refreshParticipants();
    const interval = window.setInterval(() => {
      void refreshParticipants();
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [discord, hasLeft]);

  useEffect(() => {
    if (!appToken) return;
    const controller = new AbortController();

    async function refreshRoom() {
      try {
        const response = await getCurrentRoom(appToken!, discord.instanceId, controller.signal);
        if (!controller.signal.aborted) {
          setRoom(response.room);
          setRoomError(undefined);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setRoomError(error instanceof Error ? error.message : "Could not load room state.");
        }
      }
    }

    void refreshRoom();
    const interval = window.setInterval(() => {
      void refreshRoom();
    }, 5_000);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [discord.instanceId, appToken]);

  async function authenticate() {
    setAuthState({ status: "pending" });

    try {
      const authorization = await authorizeDiscord(discord, config);
      const exchange = await exchangeDiscordCode({
        code: authorization.code,
        instanceId: discord.instanceId,
        ...(discord.guildId ? { guildId: discord.guildId } : {}),
        ...(discord.channelId ? { channelId: discord.channelId } : {}),
        ...(discord.isMock && discord.user ? { mockUser: discord.user } : {})
      });

      await authenticateDiscord(discord, exchange.discordAccessToken ?? authorization.discordAccessToken);

      const me = await getMe(exchange.appToken);
      setAuthState({ status: "authenticated", exchange, me });
      setJellyfinLinked(config.jellyfinAuthMode === "shared" || me.jellyfinLinked);

      const currentUser = me.discordUser;
      setParticipants((current) => mergeParticipants(current, [{
        id: currentUser.id,
        username: currentUser.globalName ?? currentUser.username,
        ...(currentUser.globalName !== undefined ? { globalName: currentUser.globalName } : {}),
        ...(currentUser.avatar !== undefined ? { avatar: currentUser.avatar } : {})
      }]));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Discord authentication failed.";
      setAuthState({ status: "error", message });
    }
  }

  async function signOut() {
    if (authState.status !== "authenticated" || leavePending.current) return;
    leavePending.current = true;
    setLeaving(true);
    setLeaveError(undefined);

    try {
      await logout(authState.exchange.appToken);
    } catch {
      setLeaveError("Could not confirm sign-out. Try leaving again.");
      leavePending.current = false;
      setLeaving(false);
      return;
    }

    // A second AUTHORIZE on this authenticated RPC socket is rejected by Discord.
    // Revoke our session first, then leave the Activity instead of offering re-login.
    setAuthState({ status: "closed" });
    setJellyfinLinked(false);
    setRoom(undefined);
    setRoomError(undefined);
    setStagedMedia(undefined);
    setParticipants([]);
    try {
      closeDiscordActivity(discord);
    } catch {
      setLeaveError("You are signed out. Close this Activity before opening /watch again.");
    }
    setLeaving(false);
  }

  const discordUserId = authState.status === "authenticated" ? authState.me.discordUser.id : undefined;
  const roomSync = useRoomSync({
    appToken,
    instanceId: discord.instanceId,
    guildId: discord.guildId,
    channelId: discord.channelId,
    publicWsUrl: config.publicWsUrl
  });
  const activeRoom = roomSync.room ?? room;
  const isHost = Boolean(discordUserId && activeRoom?.hostDiscordUserId === discordUserId);
  const canClaimHost = Boolean(appToken && (!activeRoom?.hostDiscordUserId || isHost));
  const jellyfinAvailable = config.jellyfinAuthMode === "shared" ? Boolean(appToken) : jellyfinLinked;
  const displayParticipants: DisplayParticipant[] = roomSync.participants.length > 0
    ? roomSync.participants.map((participant) => ({
      id: participant.discordUserId,
      username: participant.username,
      ...(participant.avatar !== undefined ? { avatar: participant.avatar } : {}),
      isHost: participant.isHost
    }))
    : participants.map((participant) => ({
      id: participant.id,
      username: participant.username,
      ...(participant.avatar !== undefined ? { avatar: participant.avatar } : {})
    }));
  const handleJellyfinLinkedChange = useCallback((linked: boolean) => {
    setJellyfinLinked(linked);
  }, []);

  async function claimHost() {
    if (!appToken) {
      return;
    }

    if (roomSync.claimHost()) {
      setRoomError(undefined);
      return;
    }

    try {
      const response = await claimRoomHost(appToken, {
        instanceId: discord.instanceId,
        ...(discord.guildId ? { guildId: discord.guildId } : {}),
        ...(discord.channelId ? { channelId: discord.channelId } : {})
      });
      setRoom(response.room);
      setRoomError(undefined);
    } catch (error) {
      setRoomError(error instanceof Error ? error.message : "Could not claim host.");
    }
  }

  function stageMedia(item: JellyfinItem) {
    const title = item.seriesName ? `${item.seriesName} - ${item.name}` : item.name;

    setStagedMedia({
      itemId: item.id,
      title,
      ...(item.runtimeTicks ? { runtimeTicks: item.runtimeTicks } : {})
    });
    setRoomError(undefined);
  }

  async function prepareMediaForRoom(input: PreparedMediaSelection) {
    if (!appToken) {
      return;
    }

    try {
      if (roomSync.selectMedia({
        itemId: input.itemId,
        mediaSourceId: input.mediaSourceId,
        title: input.title,
        ...(input.runtimeTicks ? { runtimeTicks: input.runtimeTicks } : {}),
        ...(input.audioStreamIndex !== undefined ? { audioStreamIndex: input.audioStreamIndex } : {}),
        ...(input.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: input.subtitleStreamIndex } : {})
      })) {
        setStagedMedia(undefined);
        setRoomError(undefined);
        return;
      }

      const response = await selectRoomMedia(appToken, {
        instanceId: discord.instanceId,
        itemId: input.itemId,
        mediaSourceId: input.mediaSourceId,
        title: input.title,
        ...(input.runtimeTicks ? { runtimeTicks: input.runtimeTicks } : {}),
        ...(input.audioStreamIndex !== undefined ? { audioStreamIndex: input.audioStreamIndex } : {}),
        ...(input.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: input.subtitleStreamIndex } : {})
      });
      setRoom(response.room);
      setStagedMedia(undefined);
      setRoomError(undefined);
    } catch (error) {
      setRoomError(error instanceof Error ? error.message : "Could not prepare media.");
    }
  }

  if (hasLeft) {
    return (
      <main className="app-shell">
        <h1>You left the watch party</h1>
        <p>Open /watch in Discord to join again.</p>
        {leaveError ? <p role="alert">{leaveError}</p> : null}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="action-bar">
        <AuthControls
          authState={authState}
          leaving={leaving}
          onAuthenticate={() => void authenticate()}
          onLogout={() => void signOut()}
        />
      </section>

      {leaveError ? <ErrorPanel title="Could not leave watch party" message={leaveError} /> : null}

      {authState.status === "error" ? (
        <ErrorPanel title="Discord authentication failed" message={authState.message} />
      ) : null}
      {roomError ? (
        <ErrorPanel title="Room update failed" message={roomError} />
      ) : null}
      {roomSync.error ? (
        <ErrorPanel title="Room sync warning" message={roomSync.error} />
      ) : null}

      <div className="workspace">
        <div className="primary-column">
          <WatchPlayer
            appToken={appToken}
            canPrepare={jellyfinAvailable}
            clockOffsetMs={roomSync.clockOffsetMs}
            isHost={isHost}
            itemId={activeRoom?.itemId}
            mediaSourceId={activeRoom?.mediaSourceId}
            audioStreamIndex={activeRoom?.audioStreamIndex}
            subtitleStreamIndex={activeRoom?.subtitleStreamIndex}
            stagedMedia={isHost ? stagedMedia : undefined}
            onPrepareStagedMedia={(input) => void prepareMediaForRoom(input)}
            onPlayerEvent={roomSync.sendPlayerEvent}
            onStateUpdate={roomSync.sendStateUpdate}
            remotePlayerEvent={roomSync.remotePlayerEvent}
            remoteStateUpdate={roomSync.remoteStateUpdate}
            syncStatus={roomSync.status}
            title={activeRoom?.title}
          />
          {isHost && jellyfinAvailable ? (
            <LibraryBrowser
              appToken={appToken}
              canSelectMedia={Boolean(isHost && jellyfinAvailable)}
              onSelectMedia={stageMedia}
              selectedItemId={stagedMedia?.itemId ?? activeRoom?.itemId}
            />
          ) : null}
        </div>
        <aside className="side-column">
          <ParticipantList participants={displayParticipants} />
          <HostControls
            canClaimHost={canClaimHost}
            hostLabel={hostLabel(activeRoom, isHost, roomSync.status)}
            isHost={isHost}
            onClaimHost={() => void claimHost()}
          />
          {config.jellyfinAuthMode === "per-user" && appToken && !jellyfinAvailable ? (
            <LinkAccount
              appToken={appToken}
              authMode={config.jellyfinAuthMode}
              linkedFromMe={jellyfinLinked}
              onLinkedChange={handleJellyfinLinkedChange}
            />
          ) : null}
        </aside>
      </div>
    </main>
  );
}

type AuthControlsProps = {
  authState: AuthUiState;
  leaving: boolean;
  onAuthenticate: () => void;
  onLogout: () => void;
};

function AuthControls({ authState, leaving, onAuthenticate, onLogout }: AuthControlsProps) {
  if (authState.status === "authenticated") {
    return (
      <Button disabled={leaving} icon={<LogOut aria-hidden="true" />} onClick={onLogout}>
        {leaving ? "Leaving" : "Leave watch party"}
      </Button>
    );
  }

  return (
    <Button
      disabled={authState.status === "pending"}
      icon={<Activity aria-hidden="true" />}
      onClick={onAuthenticate}
    >
      {authState.status === "pending" ? "Authenticating" : "Authenticate"}
    </Button>
  );
}

function fallbackParticipants(discord: ActivityDiscordContext): ActivityParticipant[] {
  if (!discord.user) {
    return [];
  }

  return [{
    id: discord.user.id,
    username: discord.user.globalName ?? discord.user.username,
    ...(discord.user.globalName !== undefined ? { globalName: discord.user.globalName } : {}),
    ...(discord.user.avatar !== undefined ? { avatar: discord.user.avatar } : {})
  }];
}

function mergeParticipants(current: ActivityParticipant[], next: ActivityParticipant[]): ActivityParticipant[] {
  const byId = new Map(current.map((participant) => [participant.id, participant]));

  for (const participant of next) {
    byId.set(participant.id, participant);
  }

  return Array.from(byId.values());
}

function hostLabel(room: RoomResponse["room"] | undefined, isHost: boolean, syncStatus: string): string {
  if (isHost) {
    return `You can browse Jellyfin and control playback. Sync is ${syncStatus}.`;
  }

  if (room?.hostDiscordUserId) {
    return "Waiting for the host to select media.";
  }

  return "No host has been claimed for this Activity instance.";
}
