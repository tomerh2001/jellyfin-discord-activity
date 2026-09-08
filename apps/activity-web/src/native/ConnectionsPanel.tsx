import { useEffect, useState, type FormEvent } from "react";
import { connectAccount, connectCommunity, deleteConnection, matchesPartyServer, pollQuickConnect, startQuickConnect, type Connection, type Connections, type Party, type QuickConnect } from "../api/native.js";

export function ConnectionsPanel({ token, data, party, changingServer = false, onSelect, onRefresh, onClose }: {
  token: string; data: Connections; party: Party | null; onSelect: (connection: Connection) => Promise<void>;
  onRefresh: () => Promise<void>; onClose?: () => void; changingServer?: boolean;
}) {
  const [serverUrl, setServerUrl] = useState(party?.serverUrl || data.defaultServerUrl);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [quick, setQuick] = useState<QuickConnect>();

  useEffect(() => {
    if (!quick) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= Date.parse(quick.expiresAt)) {
        setQuick(undefined); setError("This code expired. Start Quick Connect again."); return;
      }
      try {
        const result = await pollQuickConnect(token, quick.id, controller.signal);
        if (controller.signal.aborted) return;
        if (result.status === "connected") {
          setQuick(undefined); await onRefresh(); await onSelect(result.connection);
        } else timeout = setTimeout(() => { void poll(); }, 3000);
      } catch (cause) {
        if (!controller.signal.aborted) { setQuick(undefined); setError(message(cause)); }
      }
    };
    timeout = setTimeout(() => { void poll(); }, 3000);
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [quick, token, onRefresh, onSelect]);

  async function perform(action: () => Promise<void>) {
    if (pending) return;
    setPending(true); setError("");
    try { await action(); } catch (cause) { setError(message(cause)); } finally { setPending(false); }
  }
  function signIn(event: FormEvent) {
    event.preventDefault();
    void perform(async () => {
      const connection = await connectAccount(token, { serverUrl: serverUrl.trim(), username: username.trim(), password });
      setPassword(""); await onRefresh(); await onSelect(connection);
    });
  }
  return <section className="connections-panel" aria-label="Jellyfin accounts">
    <div className="panel-heading"><div><p className="eyebrow">Jellyfin Watch</p><h1>{changingServer ? "Change the party’s server" : "Your Jellyfin"}</h1></div>
      {onClose && <button className="quiet-button" onClick={onClose}>Back to watching</button>}</div>
    <p>{changingServer ? "Choose another server for everyone. You’ll confirm before the current watch party ends." : party ? "Sign in to this party’s Jellyfin server to watch together." : "Connect your server and pick something to watch together."}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {data.connections.length > 0 && <div className="saved-connections" aria-label="Saved accounts">
      {data.connections.map(connection => <div className="saved-connection" key={connection.id}>
        <button disabled={pending || !!party && !matchesPartyServer(connection, party)} onClick={() => { void perform(() => onSelect(connection)); }}>
          <strong>{connection.serverName}</strong><span>{connection.jellyfinUsername}{connection.kind === "community" ? " · Community account" : ""}</span>
          {!!party && !matchesPartyServer(connection, party) && <small>Another server — this party is already running</small>}
        </button>
        <button className="quiet-button" aria-label={`Remove ${connection.jellyfinUsername} from ${connection.serverName}`} disabled={pending}
          onClick={() => { void perform(async () => { await deleteConnection(token, connection.id); await onRefresh(); }); }}>Remove</button>
      </div>)}
    </div>}
    <form onSubmit={signIn}>
      <label>Server URL<input name="serverUrl" type="url" autoComplete="url" placeholder="https://jellyfin.example.com" value={serverUrl} onChange={event => setServerUrl(event.target.value)} required readOnly={!!party} disabled={pending || !!quick} /></label>
      <label>Username<input name="username" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required disabled={pending || !!quick} /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={pending || !!quick} /></label>
      <button className="primary-button" type="submit" disabled={pending || !!quick}>{pending ? "Connecting…" : "Sign in"}</button>
    </form>
    {quick ? <div className="quick-connect" role="status"><p>Enter this code in Jellyfin → Settings → Quick Connect:</p><strong>{quick.code}</strong>
      <button className="quiet-button" onClick={() => setQuick(undefined)}>Cancel Quick Connect</button></div> :
      <button className="secondary-button" disabled={pending || !serverUrl.trim()} onClick={() => { void perform(async () => { setQuick(await startQuickConnect(token, serverUrl.trim())); }); }}>Use Quick Connect</button>}
    {data.communityAvailable && <button className="secondary-button" disabled={pending || !!quick} onClick={() => { void perform(async () => {
      const connection = await connectCommunity(token); await onRefresh(); await onSelect(connection);
    }); }}>Use community account</button>}
  </section>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : "Could not connect. Try again."; }
