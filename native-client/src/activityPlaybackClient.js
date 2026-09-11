const TICKS_PER_MS = 10_000;
const MAX_TICKS = 7 * 86_400 * 10_000_000;
const COPY_QUEUE = queue => queue.map(entry => ({ ...entry }));

function copy(snapshot) { return { ...snapshot, queue: COPY_QUEUE(snapshot.queue), ...(snapshot.command ? { command: { ...snapshot.command } } : {}) }; }
function projected(snapshot, serverNow) {
    const result = copy(snapshot);
    if (!result.paused && result.index >= 0) result.positionTicks = Math.min(MAX_TICKS,
        result.positionTicks + Math.max(0, serverNow - result.serverTimeMs) * TICKS_PER_MS);
    result.serverTimeMs = serverNow;
    return result;
}

function validSnapshot(value) {
    return value && typeof value.epoch === 'string' && Number.isSafeInteger(value.revision) && value.revision >= 0
        && Number.isSafeInteger(value.queueRevision) && value.queueRevision >= 0 && Array.isArray(value.queue)
        && value.queue.length <= 500 && value.queue.every(entry => typeof entry?.id === 'string' && typeof entry.itemId === 'string')
        && new Set(value.queue.map(entry => entry.id)).size === value.queue.length
        && Number.isInteger(value.index) && value.index >= -1 && value.index < value.queue.length
        && Number.isFinite(value.positionTicks) && value.positionTicks >= 0 && value.positionTicks <= MAX_TICKS
        && typeof value.paused === 'boolean' && Number.isFinite(value.serverTimeMs)
        && ['RepeatNone', 'RepeatOne', 'RepeatAll'].includes(value.repeatMode);
}

function reduce(snapshot, operation, serverNow) {
    const result = projected(snapshot, ['enqueue', 'setRepeatMode'].includes(operation.type) ? Math.max(snapshot.serverTimeMs, serverNow) : serverNow);
    switch (operation.type) {
        case 'setQueue':
            result.queue = COPY_QUEUE(operation.queue);
            result.index = operation.index;
            result.positionTicks = operation.positionTicks;
            result.paused = operation.paused;
            result.queueRevision += 1;
            break;
        case 'enqueue':
            result.queue.push(...COPY_QUEUE(operation.queue));
            if (result.index < 0) { result.index = 0; result.positionTicks = 0; result.paused = true; }
            result.queueRevision += 1;
            break;
        case 'select': {
            const index = result.queue.findIndex(entry => entry.id === operation.queueItemId);
            if (index < 0) throw new Error('The selected episode is no longer in this watch party.');
            result.queueRevision += 1;
            result.index = index;
            result.positionTicks = operation.positionTicks;
            result.paused = operation.paused;
            break;
        }
        case 'setPlayback':
        case 'seek':
            if (operation.positionTicks !== undefined) result.positionTicks = operation.positionTicks;
            result.paused = operation.paused;
            break;
        case 'stop':
            result.queue = [];
            result.index = -1;
            result.positionTicks = 0;
            result.paused = true;
            result.queueRevision += 1;
            break;
        case 'setRepeatMode':
            if (result.repeatMode !== operation.repeatMode) result.queueRevision += 1;
            result.repeatMode = operation.repeatMode;
            break;
        default: throw new Error('This playback action is unavailable.');
    }
    if (!validSnapshot(result)) throw new Error('Jellyfin returned an invalid playback selection.');
    return result;
}

function equivalent(a, b, serverNow) {
    if (!a || !b || a.epoch !== b.epoch || a.index !== b.index || a.paused !== b.paused || a.repeatMode !== b.repeatMode || a.queue.length !== b.queue.length) return false;
    if (a.queue.some((entry, index) => entry.id !== b.queue[index].id || entry.itemId !== b.queue[index].itemId)) return false;
    return Math.abs(projected(a, serverNow).positionTicks - projected(b, serverNow).positionTicks) < 2_500_000;
}

const messages = {
    activity_epoch_changed: 'This watch party changed. Reconnecting to its current playback…',
    activity_queue_changed: 'Someone changed the queue. Following the current episode.',
    native_item_denied: 'This selection is not available to everyone in this watch party.',
    native_session_expired: 'Your watch party connection expired. Reconnect to continue.',
    native_playback_denied: 'Your Jellyfin account does not have permission to play this selection.',
    native_player_not_connected: 'The watch party is reconnecting. Try again once it is connected.',
    activity_stale_command: 'The playback action arrived too late. Following the current party.'
};

/** One optimistic timeline, with acknowledgements that never replay a local click. */
export function createActivityPlaybackClient({ baseUrl, apiClient, apply, onError = () => {}, transport: suppliedTransport,
    now = () => Date.now(), newId = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout,
    acknowledgementTimeout = 5_000 }) {
    const transport = suppliedTransport || createActivityPlaybackTransport({ baseUrl, apiClient });
    let disposed = false;
    let authoritative;
    let intended;
    let clientId;
    let sequence = 0;
    let processedThrough = 0;
    let offset = 0;
    let bestRoundTrip = Infinity;
    let refreshPending;
    let stopTransport;
    let connected = false;
    const pending = new Map();
    const serverNow = () => now() + offset;
    const errorText = error => messages[error?.code] || error?.message || 'Could not synchronize playback. Reconnect to the watch party.';

    function effects(next, metadata) {
        if (disposed) return;
        // The native adapter starts local effects in this call, before any send.
        try { Promise.resolve(apply(copy(next), metadata)).catch(error => { if (!disposed) onError(errorText(error)); }); }
        catch (error) { onError(errorText(error)); }
    }
    function discardPending(message) {
        for (const entry of pending.values()) {
            clearTimer(entry.timer);
            entry.reject(new Error(message));
        }
        pending.clear();
    }
    function derive() {
        let value = copy(authoritative);
        for (const entry of pending.values()) {
            if (entry.command.sequence <= processedThrough) continue;
            if (entry.command.expectedQueueRevision !== value.queueRevision) continue;
            try { value = reduce(value, entry.operation, entry.command.issuedAt); }
            catch { /* A concurrent queue replacement is settled by the server's rejection. */ }
        }
        return projected(value, serverNow());
    }
    function accept(data, origin = 'remote') {
        if (disposed || !validSnapshot(data?.snapshot) || typeof data.clientId !== 'string') return;
        const snapshot = data.snapshot;
        const changedIdentity = clientId !== undefined && (clientId !== data.clientId || authoritative?.epoch !== snapshot.epoch);
        if (changedIdentity) {
            discardPending('The watch party changed. The current playback has been restored.');
            sequence = 0;
            processedThrough = 0;
        }
        clientId = data.clientId;
        const receivedSequence = data.sequence ?? (snapshot.command?.clientId === clientId ? snapshot.command.sequence : 0);
        if (Number.isSafeInteger(receivedSequence) && receivedSequence >= 0) {
            sequence = Math.max(sequence, receivedSequence);
            processedThrough = Math.max(processedThrough, receivedSequence);
        }
        const ackId = typeof data.ack === 'string' ? data.ack : data.ack?.id;
        const commandId = ackId || (snapshot.command?.clientId === clientId ? snapshot.command.id : undefined);
        const own = commandId && pending.get(commandId);
        if (own) {
            clearTimer(own.timer);
            pending.delete(commandId);
            own.resolve(copy(snapshot));
        }
        // A repeated revision may carry a newer projected position for clock recovery.
        const obsolete = authoritative && !changedIdentity && (snapshot.revision < authoritative.revision
            || (snapshot.revision === authoritative.revision && snapshot.serverTimeMs < authoritative.serverTimeMs));
        if (!obsolete) authoritative = copy(snapshot);
        const previous = intended;
        intended = derive();
        if (!equivalent(previous, intended, serverNow())) effects(intended, { origin: changedIdentity ? 'reconcile' : origin });
    }
    function rejected(data) {
        if (disposed) return;
        const entry = pending.get(data?.id);
        const followedAutomaticAdvance = entry?.automatic && data?.code === 'activity_queue_changed' && validSnapshot(data.snapshot);
        if (entry) {
            clearTimer(entry.timer);
            pending.delete(data.id);
            if (followedAutomaticAdvance) entry.resolve(copy(data.snapshot));
            else entry.reject(new Error(messages[data.code] || 'Could not synchronize this playback action.'));
        }
        if (!followedAutomaticAdvance) onError(messages[data?.code] || 'Could not synchronize this playback action. Following the current party.');
        if (data?.snapshot && data.clientId) accept(data, 'reconcile');
        else void refresh().catch(() => {});
    }
    function status(open) {
        if (disposed) return;
        const wasConnected = connected;
        connected = open;
        if (!open && (wasConnected || pending.size)) {
            discardPending('Connection interrupted. Previous playback actions will not be replayed.');
            if (authoritative) onError('Connection interrupted. Reconnecting to the watch party…');
        }
        if (open) void refresh().catch(() => {});
    }
    function refresh() {
        if (disposed) return Promise.reject(new Error('This watch party connection has closed.'));
        if (refreshPending) return refreshPending;
        const started = now();
        refreshPending = transport.snapshot().then(data => {
            if (disposed) return undefined;
            const roundTrip = Math.max(0, now() - started);
            if (validSnapshot(data?.snapshot) && roundTrip <= bestRoundTrip) {
                bestRoundTrip = roundTrip;
                offset = data.snapshot.serverTimeMs - (started + roundTrip / 2);
            }
            accept(data, 'reconcile');
            if (!authoritative) throw new Error('Could not read the current watch party.');
            return projected(intended, serverNow());
        }).catch(error => {
            if (!disposed) onError(errorText(error));
            throw error;
        }).finally(() => { refreshPending = undefined; });
        return refreshPending;
    }
    function arm(entry) {
        entry.timer = setTimer(() => {
            if (disposed || !pending.has(entry.command.id)) return;
            if (connected && entry.attempts < 2) {
                entry.attempts += 1;
                try { transport.send(entry.command); arm(entry); return; }
                catch { /* Resolve the current state instead of replaying on a new connection. */ }
            }
            pending.delete(entry.command.id);
            entry.reject(new Error('Playback synchronization timed out.'));
            onError('Playback synchronization timed out. Restoring the current party…');
            void refresh().catch(() => {});
        }, acknowledgementTimeout);
    }
    function submit(operation, { automatic = false } = {}) {
        if (disposed || !intended || !connected) return Promise.reject(new Error('The watch party is reconnecting. Try again once it is connected.'));
        const issuedAt = serverNow();
        if (operation.type === 'setPlayback' && operation.positionTicks === undefined) {
            operation = { ...operation, positionTicks: projected(intended, issuedAt).positionTicks };
        }
        if (operation.positionTicks !== undefined) operation = { ...operation, positionTicks: Math.round(operation.positionTicks) };
        const command = { ...operation, epoch: intended.epoch, id: newId(), sequence: ++sequence,
            expectedQueueRevision: intended.queueRevision, issuedAt };
        let next;
        try { next = reduce(intended, operation, issuedAt); }
        catch (error) { return Promise.reject(error); }
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const entry = { command, operation: { ...operation, ...(operation.queue ? { queue: COPY_QUEUE(operation.queue) } : {}) }, resolve, reject, attempts: 0, automatic };
        pending.set(command.id, entry);
        intended = next;
        effects(next, { origin: 'local', type: operation.type, commandId: command.id });
        try { transport.send(command); arm(entry); }
        catch (error) {
            pending.delete(command.id);
            reject(error);
            onError(errorText(error));
            void refresh().catch(() => {});
        }
        return promise;
    }
    return {
        start() {
            if (!stopTransport) stopTransport = transport.subscribe(accept, rejected, status);
            connected = transport.isConnected();
            return refresh();
        },
        submit,
        refresh,
        getSnapshot() { return intended ? projected(intended, serverNow()) : undefined; },
        dispose() {
            if (disposed) return;
            disposed = true;
            stopTransport?.();
            discardPending('The watch party connection has closed.');
            transport.dispose?.();
        }
    };
}

/** Reuse Jellyfin's authenticated socket, including its normal reconnect lifecycle. */
export function createActivityPlaybackTransport({ baseUrl, apiClient, fetchImpl = fetch }) {
    const controller = new AbortController();
    return {
        isConnected: () => apiClient.isWebSocketOpen(),
        subscribe(onState, onError, onStatus) {
            const stop = apiClient.subscribe(['ActivityPlaybackState', 'ActivityPlaybackError'], message => {
                if (message.MessageType === 'ActivityPlaybackState') onState(message.Data);
                else onError(message.Data);
            });
            const stopStatus = apiClient._sdk.webSocket.onStatusChange(value => onStatus(value === 1));
            return () => { stop(); stopStatus(); };
        },
        async snapshot() {
            const request = new AbortController();
            const abort = () => request.abort();
            controller.signal.addEventListener('abort', abort, { once: true });
            if (controller.signal.aborted) abort();
            const timeout = setTimeout(abort, 10_000);
            try {
                const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/Activity/Playback`, {
                    credentials: 'omit', cache: 'no-store', signal: request.signal
                });
                if (!response.ok) {
                    const error = new Error('Could not reconnect to the watch party.');
                    error.code = (await response.json().catch(() => ({})))?.error?.code;
                    throw error;
                }
                return await response.json();
            } finally {
                clearTimeout(timeout);
                controller.signal.removeEventListener('abort', abort);
            }
        },
        send(command) {
            if (!apiClient.isWebSocketOpen()) throw new Error('The watch party is reconnecting.');
            apiClient._sdk.webSocket.sendMessage({ MessageType: 'ActivityPlaybackCommand', Data: command });
        },
        dispose() { controller.abort(); }
    };
}
