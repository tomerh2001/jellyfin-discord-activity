// Controller state for the Modern Jellyfin dialogs. Rendering belongs to the
// single React host so bootstrap and account transitions share the same UI.
export function createNativeUi({ onChange = () => {}, toast = () => {},
    setTimeout: schedule = globalThis.setTimeout, clearTimeout: unschedule = globalThis.clearTimeout,
    now = Date.now } = {}) {
    let sequence = 0;
    let snapshot = [];
    const listeners = new Set();
    const publish = () => { onChange(); for (const listener of listeners) listener(); };
    const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
    const getSnapshot = () => snapshot;
    const safeError = (cause, fallback = 'Could not connect. Try again.') =>
        cause instanceof Error && cause.message ? cause.message.slice(0, 500) : fallback;

    function open(kind, state, canDismiss = () => true, cleanup = () => {}) {
        const id = ++sequence;
        let closed = false;
        let resolve;
        const result = new Promise(done => { resolve = done; });
        const dialog = {
            result,
            get closed() { return closed; },
            update(patch) {
                if (closed) return;
                snapshot = snapshot.map(item => item.id === id ? { ...item, ...patch } : item);
                publish();
            },
            close(value) {
                if (closed) return;
                closed = true;
                cleanup();
                snapshot = snapshot.filter(item => item.id !== id);
                publish();
                resolve(value);
            },
            dismiss() { if (canDismiss()) dialog.close(); }
        };
        snapshot = [...snapshot, { id, kind, ...state, dismiss: dialog.dismiss }];
        publish();
        return dialog;
    }

    async function chooseAccount(options) {
        const { party, changingServer = false, canCancel = true, signal } = options;
        if (signal?.aborted) return null;
        let data = options.data;
        let pending = false;
        let quick;
        let pollTimer;
        let pollController;
        let clearCredentials = () => {};
        let dialog;
        const matches = connection => !party || connection.serverId === party.serverId && connection.serverUrl === party.serverUrl;
        const update = patch => dialog.update({ data, pending, quick, ...patch });
        function stopQuick() {
            quick = undefined;
            unschedule(pollTimer); pollTimer = undefined;
            pollController?.abort(); pollController = undefined;
        }
        const abort = () => dialog.close(null);
        function finish(connection) {
            if (dialog.closed) return;
            if (!matches(connection)) {
                update({ error: 'This account belongs to another Jellyfin server. Sign in to the party’s server.' });
                return;
            }
            dialog.close(connection);
        }
        async function perform(operation, status) {
            if (pending || quick || dialog.closed) return;
            pending = true; update({ error: '', status });
            try { await operation(); }
            catch (cause) { if (!dialog.closed) update({ error: safeError(cause) }); }
            finally { pending = false; update({ status: '' }); }
        }
        function schedulePoll() {
            if (!dialog.closed && quick) pollTimer = schedule(() => { pollTimer = undefined; void poll(); }, 2000);
        }
        async function poll() {
            const current = quick;
            if (dialog.closed || !current) return;
            if (!Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= now()) {
                stopQuick(); update({ error: 'This Quick Connect code expired. Request a new code to try again.' }); return;
            }
            const controller = new AbortController();
            pollController = controller;
            try {
                const result = await options.onQuickPoll(current.id, controller.signal);
                if (dialog.closed || quick !== current || controller.signal.aborted) return;
                if (result.status === 'connected') { stopQuick(); finish(result.connection); update(); }
                else schedulePoll();
            } catch (cause) {
                if (dialog.closed || quick !== current || controller.signal.aborted) return;
                stopQuick(); update({ error: safeError(cause, 'Quick Connect was interrupted. Request a new code to try again.') });
            } finally { if (pollController === controller) pollController = undefined; }
        }
        const actions = {
            matches,
            bindCredentials(clear) { clearCredentials = clear; },
            select(connection) { if (!pending && !quick) finish(connection); },
            signIn(input) {
                return perform(async () => {
                    const connection = await options.onConnect({ serverUrl: input.serverUrl.trim(), username: input.username.trim(), password: input.password });
                    clearCredentials(); finish(connection);
                }, 'Signing in…');
            },
            quickStart: options.onQuickStart && options.onQuickPoll ? serverUrl => perform(async () => {
                const started = await options.onQuickStart(serverUrl.trim());
                if (dialog.closed) return;
                quick = started; schedulePoll();
            }, 'Starting Quick Connect…') : undefined,
            quickCancel() { stopQuick(); update(); },
            community: options.onCommunity ? () => perform(async () => finish(await options.onCommunity()), 'Connecting community account…') : undefined,
            refresh: options.onRefresh ? () => perform(async () => {
                const refreshed = await options.onRefresh();
                if (!dialog.closed) { data = refreshed; update(); }
            }, 'Loading your accounts…') : undefined,
            remove: options.onDelete && options.onRefresh ? id => perform(async () => {
                await options.onDelete(id);
                if (dialog.closed) return;
                const refreshed = await options.onRefresh();
                if (!dialog.closed) { data = refreshed; update(); }
            }, 'Removing saved account…') : undefined
        };
        dialog = open('accounts', { data, party, changingServer, canCancel, pending, quick,
            notice: options.notice, error: '', status: '', actions }, () => canCancel && !pending, () => {
            stopQuick(); clearCredentials(); signal?.removeEventListener('abort', abort);
        });
        signal?.addEventListener('abort', abort, { once: true });
        // Abort can arrive while a synchronous host mount is notifying listeners.
        if (signal?.aborted) abort();
        return (await dialog.result) ?? null;
    }

    async function confirmServerChange(connection) {
        const dialog = open('confirm', { connection });
        dialog.update({ confirm: () => dialog.close(true), cancel: () => dialog.close(false) });
        return Boolean(await dialog.result);
    }

    async function showWatchMenu({ anchor, status, onInvite, onAccounts, onChangeServer, onLeave,
        onSyncSettings, onResumePlayback, onHaltPlayback }) {
        const actions = [
            ['invite', 'Invite friends', 'person_add', onInvite],
            ['accounts', 'Jellyfin accounts', 'account_circle', onAccounts],
            ['server', 'Change server', 'dns', onChangeServer],
            ['sync', 'SyncPlay settings', 'settings', onSyncSettings],
            ['resume', 'Resume playback', 'play_arrow', onResumePlayback],
            ['halt', 'Stop playback', 'stop', onHaltPlayback],
            ['leave', 'Leave watch party', 'exit_to_app', onLeave]
        ].filter(([, , , callback]) => callback);
        const dialog = open('menu', { anchor, status, actions });
        let operation;
        dialog.update({ select(id) {
            if (dialog.closed) return;
            const action = actions.find(([value]) => value === id);
            dialog.close();
            // Invoke during the actual click, preserving clipboard/user activation.
            try { operation = Promise.resolve(action?.[3]()).catch(cause => toast(safeError(cause, 'Could not complete that action. Try again.'))); }
            catch (cause) { toast(safeError(cause, 'Could not complete that action. Try again.')); }
        } });
        await dialog.result;
        await operation;
    }

    function showLoading(text = 'Connecting to Discord…') {
        const dialog = open('loading', { text }, () => false);
        return { close: () => dialog.close() };
    }

    async function showStartupError({ message, onRetry, onLeave }) {
        let pending = false;
        const dialog = open('startupError', { error: message || 'The connection was interrupted. Try again.', pending }, () => false);
        const perform = async callback => {
            if (pending || dialog.closed) return;
            pending = true; dialog.update({ pending });
            try { await callback(); dialog.close(); }
            catch (cause) { dialog.update({ error: safeError(cause) }); }
            finally { pending = false; dialog.update({ pending }); }
        };
        dialog.update({ retry: onRetry ? () => perform(onRetry) : undefined, leave: onLeave ? () => perform(onLeave) : undefined });
        await dialog.result;
    }

    async function showClosed({ onClose } = {}) {
        let pending = false;
        const dialog = open('closed', { pending }, () => Boolean(onClose) && !pending);
        if (onClose) dialog.update({ exit: async () => {
            if (pending || dialog.closed) return;
            pending = true; dialog.update({ pending });
            try { await onClose(); dialog.close(); }
            catch { toast('You are signed out. Close this Activity in Discord.'); }
            finally { pending = false; dialog.update({ pending }); }
        } });
        await dialog.result;
    }

    function mountPlaybackPermission({ onActivate, label, disabled = false }) {
        const dialog = open('playbackPermission', { onActivate, label, disabled }, () => false);
        return { update: patch => dialog.update(patch), close: () => dialog.close() };
    }

    return { subscribe, getSnapshot, chooseAccount, confirmServerChange, showWatchMenu, showLoading,
        showStartupError, showClosed, mountPlaybackPermission };
}
