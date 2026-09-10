/** Discord authentication and party selection live in the native document. */
export function preferredAccount(data, party, matches) {
    const eligible = data.connections.filter(connection => !party || matches(connection, party));
    return eligible.find(connection => connection.id === data.preferredConnectionId);
}

export function sameParty(left, right) {
    return left?.id === right?.id && left?.groupId === right?.groupId
        && left?.serverId === right?.serverId && left?.serverUrl === right?.serverUrl;
}

export function createActivityController(broker, installLaunch, deviceId) {
    let session;
    let selection;
    let party;
    let preferredConnectionId;
    const rejected = new Set();
    const issued = new Set();
    let refreshing = false;
    let closed = false;
    let leaving = false;
    let pending;
    let selecting;
    let logoutPending;
    let autoResumeUsed = false;
    let revision = 0;
    const stopRejected = broker.onSessionRejected(token => {
        if (issued.has(token)) rejected.add(token);
    });
    function assertOpen() {
        if (closed || leaving) throw new Error('The Activity is closed.');
    }
    function recoveryRequired() {
        return Object.assign(new Error('Your Discord session could not be restored. Try connecting again.'), { recoveryRequired: true });
    }
    async function call(method, ...args) {
        assertOpen();
        if (Date.parse(session.exchange.expiresAt) <= Date.now()) rejected.add(session.exchange.appToken);
        if (rejected.has(session.exchange.appToken)) await resume();
        const token = session.exchange.appToken;
        try { return await broker[method](token, ...args); }
        catch (error) {
            assertOpen();
            if (!rejected.has(token)) throw error;
            // Another request may have already renewed while this old response
            // was in flight. Retry it once using the established replacement.
            if (session.exchange.appToken === token) await resume();
            const retryToken = session.exchange.appToken;
            try { return await broker[method](retryToken, ...args); }
            catch (retryError) {
                assertOpen();
                if (rejected.has(retryToken)) throw recoveryRequired();
                throw retryError;
            }
        }
    }
    let resumePending;
    async function resume() {
        assertOpen();
        if (resumePending) return resumePending;
        if (autoResumeUsed) throw recoveryRequired();
        // A failed replacement is surfaced to the user. Background polling must
        // not keep issuing new sessions when Discord membership remains invalid.
        autoResumeUsed = true;
        resumePending ??= broker.resumeActivitySession().then(async value => {
            if (closed || leaving) {
                await broker.logout(value.exchange.appToken);
                throw new Error('The Activity is closed.');
            }
            session = value;
            issued.add(value.exchange.appToken);
            refreshing = Boolean(selection);
        }).catch(error => {
            assertOpen();
            throw Object.assign(recoveryRequired(), { cause: error });
        }).finally(() => { resumePending = undefined; });
        return resumePending;
    }
    return {
        get session() { return session; },
        get selection() { return selection; },
        get party() { return party; },
        get busy() { return Boolean(pending || logoutPending) || leaving; },
        get needsLaunch() { return refreshing; },
        async start() { session = await broker.startActivitySession(); issued.add(session.exchange.appToken); return session; },
        retryRecovery() { assertOpen(); autoResumeUsed = false; },
        call,
        async load() {
            const generation = revision;
            const [data, current] = await Promise.all([call('getConnections'), call('getParty')]);
            if (!closed && !leaving && !logoutPending && generation === revision) {
                preferredConnectionId = data.preferredConnectionId;
                party = current;
            }
            return { data, party };
        },
        select(connection, replaceParty = false) {
            assertOpen();
            if (logoutPending) throw new Error('Wait for sign out to finish.');
            if (pending) return pending;
            const generation = ++revision;
            const currentSelection = () => !closed && !leaving && generation === revision;
            selecting = connection;
            const operation = (async () => {
                let current = await call('getParty');
                if (!currentSelection()) return;
                if (current && !replaceParty && !broker.matchesPartyServer(connection, current)) {
                    throw new Error('This party is using another Jellyfin server. Connect an account on that server to join.');
                }
                if (!current || replaceParty) current = await call('joinParty', connection.id);
                if (!currentSelection()) return;
                if (preferredConnectionId !== connection.id) {
                    await call('savePreference', connection.id);
                    if (!currentSelection()) return;
                    preferredConnectionId = connection.id;
                }
                const launch = await call('launchNative', connection.id, deviceId);
                if (!currentSelection()) return;
                await installLaunch(launch, connection, currentSelection);
                if (!currentSelection()) return;
                selection = connection;
                party = current;
                refreshing = false;
            })().catch(error => {
                // A revoked launch may fail after another account has signed
                // in. Its obsolete error must not replace the new login UI.
                if (currentSelection()) throw error;
            }).finally(() => {
                if (pending === operation) { pending = undefined; selecting = undefined; }
            });
            pending = operation;
            return operation;
        },
        cancelSelection() {
            assertOpen();
            // Opening native login is a local choice, not a saved-account
            // deletion. Invalidate reconnects before they can restore a client.
            revision++;
            pending = undefined;
            selecting = undefined;
            selection = undefined;
            refreshing = false;
        },
        logoutAccount() {
            assertOpen();
            if (logoutPending) return logoutPending;
            const connection = selection || selecting;
            // Invalidate and detach an outstanding launch immediately. Its late
            // completion must neither install a client nor clear a new login.
            revision++;
            pending = undefined;
            selecting = undefined;
            const operation = (async () => {
                if (connection) await call('deleteConnection', connection.id);
                selection = undefined;
                preferredConnectionId = undefined;
                refreshing = false;
            })().finally(() => { if (logoutPending === operation) logoutPending = undefined; });
            logoutPending = operation;
            return operation;
        },
        async poll() {
            if (closed || leaving || pending || logoutPending) return false;
            const generation = revision;
            const previous = party;
            const next = await call('getParty');
            if (closed || leaving || pending || logoutPending || generation !== revision) return false;
            if (!sameParty(previous, next)) {
                party = next;
                selection = undefined;
                refreshing = false;
                return true;
            }
            return false;
        },
        async leave() {
            assertOpen();
            leaving = true;
            revision++;
            const token = session.exchange.appToken;
            try { await broker.logout(token); }
            catch (error) {
                // An already expired/revoked app token cannot retain access.
                // Do not start a new Discord session just to sign out of it.
                if (!rejected.has(token)) { leaving = false; throw error; }
            }
            closed = true;
            stopRejected();
            broker.clearActivitySession();
            try { broker.closeDiscordActivity(session.discord); }
            catch { /* Broker sign-out succeeded even if Discord already closed. */ }
        },
        dispose() { closed = true; stopRejected(); }
    };
}
