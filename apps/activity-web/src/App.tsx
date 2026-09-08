import { useCallback, useEffect, useRef, useState } from "react";
import { exchangeDiscordCode, getPublicConfig, logout } from "./api/client.js";
import { getConnections, getParty, joinParty, launchNative, matchesPartyServer, savePreference, type Connection, type Connections, type NativeLaunch, type Party } from "./api/native.js";
import type { DiscordExchangeResponse } from "./api/types.js";
import { authenticateDiscord, authorizeDiscord, closeDiscordActivity, getConnectedParticipants, initializeDiscord, type ActivityDiscordContext } from "./discord/sdk.js";
import type { ActivityParticipant } from "./discord/participants.js";
import { NativeClient } from "./native/NativeClient.js";
import { ConnectionsPanel } from "./native/ConnectionsPanel.js";

type Session = { discord: ActivityDiscordContext; exchange: DiscordExchangeResponse };

async function startSession(): Promise<Session> {
  const config = await getPublicConfig();
  const discord = await initializeDiscord(config);
  const authorization = await authorizeDiscord(discord, config);
  const exchange = await exchangeDiscordCode({
    code: authorization.code, instanceId: discord.instanceId,
    ...(discord.guildId ? { guildId: discord.guildId } : {}),
    ...(discord.channelId ? { channelId: discord.channelId } : {}),
    ...(discord.isMock && discord.user ? { mockUser: discord.user } : {})
  });
  try {
    await authenticateDiscord(discord, exchange.discordAccessToken ?? authorization.discordAccessToken);
  } catch {
    await logout(exchange.appToken).catch(() => undefined);
    throw new Error("Discord could not authorize this Activity. Close it and open /watch again.");
  }
  return { discord, exchange };
}

export function App() {
  // StrictMode can replay effects. A single promise keeps the RPC authorization
  // and SDK instance stable for the lifetime of this Activity document.
  const startup = useRef<Promise<Session> | null>(null);
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    startup.current ??= startSession();
    void startup.current.then(value => { if (!cancelled) setSession(value); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);
  if (error) return <main className="centered"><h1>Open Jellyfin Watch in Discord</h1><p>Close this Activity and open /watch again to connect.</p></main>;
  if (!session) return <main className="centered" role="status"><img className="welcome-logo" src="/branding/jellyfin-watch-icon.png" alt="" /><h1>Jellyfin Watch</h1><p>Connecting to Discord…</p></main>;
  return <ActivityShell session={session} />;
}

function ActivityShell({ session: { discord, exchange } }: { session: Session }) {
  const token = exchange.appToken;
  const [connections, setConnections] = useState<Connections>();
  const [party, setParty] = useState<Party | null>(null);
  const [selection, setSelection] = useState<Connection>();
  const [launch, setLaunch] = useState<NativeLaunch>();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [changingServer, setChangingServer] = useState(false);
  const [proposedServer, setProposedServer] = useState<Connection>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Connecting");
  const [participants, setParticipants] = useState<ActivityParticipant[]>([{ id: exchange.user.id, username: exchange.user.username,
    ...(exchange.user.globalName !== undefined ? { globalName: exchange.user.globalName } : {}),
    ...(exchange.user.avatar !== undefined ? { avatar: exchange.user.avatar } : {}) }]);
  const [closed, setClosed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leavePending = useRef(false);
  const selectPending = useRef(false);
  const initialLoad = useRef(false);
  const currentParty = useRef<Party | null | undefined>(undefined);
  const partyRevision = useRef(0);
  const deviceId = useRef(crypto.randomUUID());

  const refresh = useCallback(async () => {
    const data = await getConnections(token);
    setConnections(data);
    if (selection && !data.connections.some(connection => connection.id === selection.id)) {
      setLaunch(undefined); setSelection(undefined); setAccountsOpen(true);
    }
  }, [token, selection]);
  const select = useCallback(async (connection: Connection, replaceParty = false) => {
    if (selectPending.current || leavePending.current) return;
    selectPending.current = true; partyRevision.current += 1; setPending(true); setError("");
    try {
      // A saved preferred account must never replace someone else's running party.
      let current = await getParty(token);
      if (!replaceParty && current && !matchesPartyServer(connection, current)) throw new Error("This party is watching from another Jellyfin server. Sign in to the party’s server to join.");
      if (replaceParty || !current) current = await joinParty(token, connection.id);
      if (currentParty.current && currentParty.current.id !== current.id) { setLaunch(undefined); setSelection(undefined); }
      currentParty.current = current; setParty(current);
      await savePreference(token, connection.id);
      const nextLaunch = await launchNative(token, connection.id, deviceId.current);
      if (leavePending.current) return;
      setParty(current); setSelection(connection); setLaunch(nextLaunch); setStatus("Opening Jellyfin"); setAccountsOpen(false); setChangingServer(false); setProposedServer(undefined);
    } finally { selectPending.current = false; setPending(false); }
  }, [token]);

  useEffect(() => {
    if (initialLoad.current) return;
    initialLoad.current = true;
    void Promise.all([getConnections(token), getParty(token)]).then(async ([data, current]) => {
      setConnections(data); setParty(current); currentParty.current = current;
      const eligible = data.connections.filter(connection => !current || matchesPartyServer(connection, current));
      const preferred = eligible.find(connection => connection.id === data.preferredConnectionId) ?? (eligible.length === 1 ? eligible[0] : undefined);
      if (preferred) await select(preferred); else setAccountsOpen(true);
    }).catch(cause => { setError(cause instanceof Error ? cause.message : "Could not load your Jellyfin accounts. Try again."); setAccountsOpen(true); });
  }, [token, select]);

  useEffect(() => {
    if (closed) return;
    let cancelled = false;
    const refreshParticipants = async () => {
      try { const users = await getConnectedParticipants(discord); if (!cancelled && users.length) setParticipants(users); } catch { /* Keep the last known participants during transient RPC failures. */ }
    };
    void refreshParticipants();
    const interval = setInterval(() => { void refreshParticipants(); }, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [discord, closed]);

  useEffect(() => {
    if (closed) return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling || selectPending.current || leavePending.current || currentParty.current === undefined) return;
      polling = true;
      const revision = partyRevision.current;
      try {
        const next = await getParty(token);
        if (cancelled || selectPending.current || leavePending.current || revision !== partyRevision.current) return;
        const previous = currentParty.current;
        if (previous?.id !== next?.id || previous?.groupId !== next?.groupId || previous?.serverId !== next?.serverId || previous?.serverUrl !== next?.serverUrl) {
          currentParty.current = next; setParty(next);
          setLaunch(undefined); setSelection(undefined); setChangingServer(false); setProposedServer(undefined); setAccountsOpen(true);
          setError(next ? "The party’s server changed. Choose your account to join the new watch party." : "The watch party ended. Choose a server to start again.");
        }
      } catch { /* Retry transient network failures without interrupting playback. */ }
      finally { polling = false; }
    };
    const interval = setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [closed, token]);

  const nativeStatus = useCallback((value: string) => {
    const labels: Record<string, string> = { joining: "Joining watch party", connected: "Watching together", disconnected: "Party disconnected", reconnecting: "Reconnecting", error: "Jellyfin connection interrupted", "signed-out": "Account signed out", playing: "Watching together", browsing: "Choose something to watch" };
    if (labels[value]) setStatus(labels[value]);
    if (value === "reauthorize" && selection) {
      void select(selection).catch(() => { setError("Could not reconnect to Jellyfin. Choose your account to try again."); setAccountsOpen(true); });
    }
    if (value === "error" || value === "signed-out") { setError("The Jellyfin connection ended. Choose your account to reconnect."); setAccountsOpen(true); }
  }, [selection, select]);

  async function invite() {
    if (!discord.sdk || !discord.guildId) { setError("Use the Discord channel’s invite or Join Activity controls to invite friends here."); return; }
    try { await discord.sdk.commands.openInviteDialog(); } catch { setError("Discord could not open an invite. Check your channel invite permission or use the channel’s Join Activity controls."); }
  }
  async function leave() {
    if (leavePending.current) return;
    leavePending.current = true; setLeaving(true); setError("");
    try { await logout(token); } catch { setError("Could not confirm sign-out. Try leaving again."); leavePending.current = false; setLeaving(false); return; }
    setClosed(true); setLaunch(undefined); setSelection(undefined); setConnections(undefined); setParty(null); setParticipants([]);
    try { closeDiscordActivity(discord); } catch { setError("You are signed out. Close this Activity before opening /watch again."); }
    setLeaving(false);
  }
  if (closed) return <main className="centered"><h1>You left the watch party</h1><p>Open /watch in Discord to join again.</p>{error && <p role="alert">{error}</p>}</main>;
  return <main className="activity-shell">
    <header className="activity-toolbar">
      <div className="brand"><img src="/branding/jellyfin-watch-icon.png" alt="" /><div><strong>Jellyfin Watch</strong><span>{selection ? `${selection.serverName} · ${selection.jellyfinUsername}` : "Watch together"}</span></div></div>
      <div className="participants" aria-label={`${participants.length} viewers`}>{participants.slice(0, 5).map(user => <span key={user.id} title={user.globalName || user.username} aria-label={user.globalName || user.username}>
        {user.avatar ? <img src={`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`} alt="" /> : (user.globalName || user.username).slice(0, 1).toUpperCase()}</span>)}</div>
      <nav aria-label="Watch party"><button disabled={leaving} onClick={() => { void invite(); }}>Invite friends</button><button disabled={leaving || pending} onClick={() => { setChangingServer(false); setAccountsOpen(true); }}>Accounts</button><button disabled={leaving || pending || !party} onClick={() => { setChangingServer(true); setAccountsOpen(true); }}>Change server</button><button disabled={leaving} onClick={() => { void leave(); }}>{leaving ? "Leaving…" : "Leave watch party"}</button></nav>
    </header>
    {error && <div className="shell-notice" role="alert">{error}<button onClick={() => { setError(""); void refresh().then(() => setAccountsOpen(true)).catch(() => setError("Could not load your accounts. Try again.")); }}>Try again</button></div>}
    <div className="activity-content">
    {launch && <NativeClient key={launch.accessToken} launch={launch} onStatus={nativeStatus} />}
    {!launch && !connections && <div className="centered" role="status">Loading your accounts…</div>}
    {pending && <div className="connecting-overlay" role="status">Joining your watch party…</div>}
    {connections && (accountsOpen || !launch) && <div className={launch ? "accounts-overlay" : "accounts-page"}>
      <ConnectionsPanel key={`${changingServer ? "change" : "join"}:${party?.id || "new"}`} token={token} data={connections} party={changingServer ? null : party} changingServer={changingServer}
        onSelect={changingServer ? async connection => { setProposedServer(connection); } : select} onRefresh={refresh}
        {...(launch || changingServer ? { onClose: () => { setChangingServer(false); setAccountsOpen(false); } } : {})} />
    </div>}
    {proposedServer && <div className="confirmation-overlay"><section className="connections-panel" role="dialog" aria-modal="true" aria-labelledby="change-server-title">
      <h1 id="change-server-title">Change server for everyone?</h1>
      <p>This ends the current watch party and opens {proposedServer.serverName}. Everyone will need to reconnect with an account on that server.</p>
      <div className="confirmation-actions"><button disabled={pending} onClick={() => setProposedServer(undefined)}>Keep current server</button>
        <button className="primary-button" disabled={pending} onClick={() => { void select(proposedServer, true).catch(() => { setProposedServer(undefined); setError("Could not change the party’s server. Choose an account to try again."); }); }}>Confirm change server</button></div>
    </section></div>}
    {launch && <div className="party-status" role="status">{status}</div>}
    </div>
  </main>;
}
