/** Keep Jellyfin's player, queue and reporting, with Activity-owned timing. */
export function createNativePlaybackAdapter({ playbackManager: manager, events, apiClient, baseUrl, createClient, onError, host = window }) {
    const original = new Map();
    const installed = new Map();
    const items = new Map();
    const playOptions = new Map();
    let closed = false;
    let generation = 0;
    let preparing;
    let desired;
    let activeEntry;
    let endedEntry;
    let player;
    let buffered = false;
    let lastCorrection = 0;
    let automaticRate;
    let baseRate = 1;
    let ignoreSeek;
    let nativeGestureUntil = 0;
    let lastError;
    let preparationSequence = 0;
    const serverId = apiClient.serverId();
    const now = () => Date.now();
    const getPlayer = () => manager.getCurrentPlayer();
    const position = () => {
        const current = getPlayer();
        return current ? Math.max(0, manager.getCurrentTicks(current) || 0) : 0;
    };
    const invoke = (name, ...args) => original.get(name).apply(manager, args);
    const report = error => {
        const message = typeof error === 'string' ? error : error instanceof Error ? error.message : 'Could not synchronize playback.';
        if (!closed && !(lastError?.message === message && now() - lastError.at < 1000)) {
            lastError = { message, at: now() }; onError(message);
        }
    };
    const submit = (operation, options) => {
        if (closed) return Promise.resolve();
        try { return Promise.resolve(client.submit(operation, options)).catch(report); }
        catch (error) { report(error); return Promise.resolve(); }
    };
    const snapshot = () => client.getSnapshot();
    const currentEntry = state => state?.queue?.[state.index];
    const entryKey = entry => entry && JSON.stringify([entry.id, entry.itemId]);
    const cached = entry => items.get(entry.id)?.Id === entry.itemId;
    const sameQueue = (left, right) => left.length === right.length && left.every((item, index) => item.PlaylistItemId === right[index].id && item.Id === right[index].itemId);

    function resetRate() {
        if (automaticRate != null && player?.setPlaybackRate && player.getPlaybackRate() === automaticRate) player.setPlaybackRate(baseRate);
        automaticRate = undefined;
    }

    function seek(ticks) {
        if (!getPlayer()) return;
        ignoreSeek = { ticks, until: now() + 2000 };
        invoke('seek', ticks);
    }

    function applyTimeline(state, { origin, type } = {}, force = false) {
        const current = getPlayer();
        if (!current || preparing || entryKey(currentEntry(state)) !== activeEntry) return;
        const drift = state.positionTicks - position();
        if (type === 'seek' || type === 'select' || force || (state.paused && Math.abs(drift) > 1_000_000)) {
            resetRate();
            if (Math.abs(drift) > 100_000 || type === 'seek' || type === 'select') seek(state.positionTicks);
        } else if (origin !== 'local' && !buffered && !state.paused) {
            const milliseconds = drift / 10_000;
            if (Math.abs(milliseconds) > 1500 && now() - lastCorrection > 3000) {
                resetRate(); lastCorrection = now(); seek(state.positionTicks);
            } else if (Math.abs(milliseconds) > 250 && Math.abs(milliseconds) <= 1500 && current.setPlaybackRate && current.getPlaybackRate) {
                if (automaticRate == null || current.getPlaybackRate() !== automaticRate) baseRate = current.getPlaybackRate() || 1;
                automaticRate = baseRate * (milliseconds > 0 ? 1.03 : 0.97);
                current.setPlaybackRate(automaticRate);
            } else if (Math.abs(milliseconds) <= 150) resetRate();
        }
        if (state.paused) { resetRate(); if (!manager.paused()) invoke('pause'); }
        else if (manager.paused()) invoke('unpause');
    }

    async function hydrate(queue) {
        const missing = [...new Set(queue.filter(entry => !cached(entry)).map(entry => entry.itemId))];
        if (missing.length) {
            const result = await manager.getItemsForPlayback(serverId, { Ids: missing.join(',') });
            const found = new Map(result.Items.map(item => [item.Id, item]));
            for (const entry of queue) {
                if (!cached(entry)) {
                    const item = found.get(entry.itemId);
                    if (!item) throw new Error('An item in this watch party is unavailable to your Jellyfin account.');
                    items.set(entry.id, { ...item, PlaylistItemId: entry.id });
                }
            }
        }
        return queue.map(entry => items.get(entry.id));
    }

    function updateQueue(state, preparedItems) {
        const queue = manager._playQueueManager;
        if (sameQueue(queue.getPlaylist(), state.queue)) return;
        queue.setPlaylist(preparedItems);
        applyRepeat(state);
        queue.setPlaylistState(currentEntry(state)?.id);
        if (getPlayer()) events.trigger(getPlayer(), 'playlistitemadd');
    }

    function applyRepeat(state) {
        const mode = state.repeatMode || 'RepeatNone';
        if (manager._playQueueManager.getRepeatMode() === mode) return;
        if (getPlayer()) invoke('setRepeatMode', mode);
        else manager._playQueueManager.setRepeatMode(mode);
    }

    function apply(state, metadata = {}) {
        if (closed) return;
        desired = state;
        const entry = currentEntry(state);
        const identity = entryKey(entry);
        applyRepeat(state);
        if (!entry) {
            generation++; preparationSequence++; preparing = undefined; activeEntry = undefined; endedEntry = undefined;
            resetRate();
            if (getPlayer()) void Promise.resolve(invoke('stop')).then(() => { if (!closed && desired === state) applyRepeat(state); }).catch(report);
            return;
        }
        if (preparing?.entry === identity) return;
        if (activeEntry === identity && getPlayer()) {
            if (!sameQueue(manager._playQueueManager.getPlaylist(), state.queue)) {
                const current = generation;
                if (state.queue.every(cached)) updateQueue(state, state.queue.map(value => items.get(value.id)));
                else void hydrate(state.queue).then(values => {
                    if (!closed && current === generation && desired === state) updateQueue(state, values);
                }).catch(report);
            }
            applyTimeline(state, metadata);
            return;
        }
        preparationSequence++;
        const current = ++generation;
        const attempt = { entry: identity };
        preparing = attempt;
        resetRate(); buffered = false;
        const isCurrent = () => !closed && current === generation && entryKey(currentEntry(desired)) === identity;
        const begin = values => {
            if (!isCurrent()) return;
            const latest = snapshot() || desired;
            const options = { ...playOptions.get(entry.id), serverId, fullscreen: true,
                startIndex: values.findIndex(item => item.PlaylistItemId === entry.id && item.Id === entry.itemId),
                startPositionTicks: latest.positionTicks,
                activityIsCurrent: isCurrent, activityRetainTracks: Boolean(activeEntry || endedEntry) };
            return manager.activityPlayPrepared(values, options).then(() => {
                if (!isCurrent()) return;
                activeEntry = identity; endedEntry = undefined;
                preparing = undefined;
                apply(snapshot() || desired);
                applyTimeline(snapshot() || desired, metadata, true);
            });
        };
        // A local prepared queue reaches the native pipeline during the gesture,
        // before any command acknowledgement or remote participant response.
        if (state.queue.every(cached)) {
            try { void Promise.resolve(begin(state.queue.map(value => items.get(value.id)))).catch(error => {
                if (isCurrent()) { preparing = undefined; report(error); }
            }); }
            catch (error) { preparing = undefined; report(error); }
        } else void hydrate(state.queue).then(begin).catch(error => {
            if (isCurrent()) { preparing = undefined; report(error); }
        });
    }

    const client = createClient({ baseUrl, apiClient, apply, onError: report });
    const replace = (name, callback) => {
        original.set(name, manager[name]); installed.set(name, callback); manager[name] = callback;
    };
    const desiredPaused = () => snapshot()?.paused ?? manager.paused() ?? true;
    replace('pause', () => submit({ type: 'setPlayback', paused: true, positionTicks: position() }));
    replace('unpause', () => submit({ type: 'setPlayback', paused: false, positionTicks: position() }));
    replace('playPause', () => submit({ type: 'setPlayback', paused: !desiredPaused(), positionTicks: position() }));
    replace('seek', ticks => submit({ type: 'seek', positionTicks: Math.max(0, Math.round(ticks)), paused: desiredPaused() }));
    replace('stop', () => submit({ type: 'stop' }));
    replace('setRepeatMode', repeatMode => submit({ type: 'setRepeatMode', repeatMode }));
    const select = (entry, paused = false, options) => entry ? submit({ type: 'select', queueItemId: entry.id, positionTicks: 0, paused }, options) : Promise.resolve();
    replace('nextTrack', () => { const state = snapshot(); return select(state?.queue?.[state.index + 1]); });
    replace('previousTrack', () => { const state = snapshot(); return select(state?.queue?.[state.index - 1]); });
    replace('setCurrentPlaylistItem', id => select(snapshot()?.queue.find(entry => entry.id === id)));
    const replaceQueue = queue => {
        const state = snapshot();
        if (!state) return;
        if (!queue.length) return submit({ type: 'stop' });
        const id = currentEntry(state)?.id;
        const index = Math.max(0, queue.findIndex(entry => entry.id === id));
        return submit({ type: 'setQueue', queue, index: queue.length ? index : -1,
            positionTicks: queue[index]?.id === id ? position() : 0, paused: state.paused });
    };
    replace('clearQueue', clearCurrent => replaceQueue(clearCurrent ? [] : [currentEntry(snapshot())].filter(Boolean)));
    replace('removeFromPlaylist', ids => replaceQueue(snapshot()?.queue.filter(entry => !ids.includes(entry.id)) || []));
    replace('movePlaylistItem', (id, newIndex) => {
        const queue = [...snapshot()?.queue || []]; const index = queue.findIndex(entry => entry.id === id);
        if (index < 0 || newIndex < 0 || newIndex >= queue.length) return;
        queue.splice(newIndex, 0, queue.splice(index, 1)[0]); return replaceQueue(queue);
    });
    for (const name of ['setQueueShuffleMode', 'toggleQueueShuffleMode']) replace(name, (...args) => {
        invoke(name, ...args);
        return replaceQueue(manager._playQueueManager.getPlaylist().map(item => ({ id: item.PlaylistItemId, itemId: item.Id })));
    });

    const hook = {
        beginPreparation: () => ++preparationSequence,
        isPreparationCurrent: value => !closed && value === preparationSequence,
        playPrepared(values, options) {
            const queue = values.map(item => {
                const id = host.crypto.randomUUID();
                items.set(id, { ...item, PlaylistItemId: id }); playOptions.set(id, { ...options });
                return { id, itemId: item.Id };
            });
            return submit({ type: 'setQueue', queue, index: Math.min(options.startIndex || 0, queue.length - 1),
                positionTicks: options.startPositionTicks || 0, paused: false });
        },
        queuePrepared(values, mode) {
            const state = snapshot();
            if (!currentEntry(state)) return hook.playPrepared(values, {});
            const additions = values.map(item => {
                const id = host.crypto.randomUUID(); items.set(id, { ...item, PlaylistItemId: id });
                return { id, itemId: item.Id };
            });
            const queue = [...state.queue];
            queue.splice(mode === 'next' ? state.index + 1 : queue.length, 0, ...additions);
            return replaceQueue(queue);
        },
        captureEnded(state) {
            const current = snapshot();
            if (!current || state.PlayState?.PlaylistItemId !== currentEntry(current)?.id || activeEntry !== entryKey(currentEntry(current))) return;
            // HTML media clears its source on ended. A repeat must prepare a
            // fresh playback instance even when the queue entry is unchanged.
            endedEntry = activeEntry; activeEntry = undefined;
            return { epoch: current.epoch, queueRevision: current.queueRevision };
        },
        ended(state, ended) {
            const current = snapshot();
            if (!current || !ended || ended.epoch !== current.epoch || ended.queueRevision !== current.queueRevision
                || state.PlayState?.PlaylistItemId !== currentEntry(current)?.id) return;
            const repeat = current.repeatMode;
            const next = repeat === 'RepeatOne' ? current.index
                : current.index + 1 < current.queue.length ? current.index + 1
                    : repeat === 'RepeatAll' ? 0 : -1;
            if (next < 0) return submit({ type: 'stop' }, { automatic: true });
            return select(current.queue[next], false, { automatic: true });
        }
    };
    manager.activityPlayback = hook;
    const nativePausedChanged = () => {
        // Native fullscreen controls need their original gesture. Browser/OS
        // interruption and autoplay recovery are personal, never party commands.
        if (closed || preparing || buffered || now() > nativeGestureUntil || !nativeGestureUntil || !getPlayer() || !currentEntry(snapshot())) return;
        nativeGestureUntil = 0;
        const paused = Boolean(manager.paused());
        if (paused !== desiredPaused()) void submit({ type: 'setPlayback', paused, positionTicks: position() });
    };
    const playing = () => { buffered = false; if (!preparing && snapshot()) applyTimeline(snapshot(), { origin: 'reconcile' }); };
    const waiting = () => { buffered = true; resetRate(); };
    const bind = () => {
        resetRate();
        if (player) for (const [name, handler] of [['pause', nativePausedChanged], ['unpause', nativePausedChanged], ['playing', playing], ['waiting', waiting]]) events.off(player, name, handler);
        player = getPlayer();
        if (player) for (const [name, handler] of [['pause', nativePausedChanged], ['unpause', nativePausedChanged], ['playing', playing], ['waiting', waiting]]) events.on(player, name, handler);
    };
    events.on(manager, 'playerchange', bind); bind();
    const seeked = event => {
        if (closed || preparing || now() > nativeGestureUntil || !nativeGestureUntil || !event.target?.matches?.('video.htmlvideoplayer, audio.htmlaudioplayer')) return;
        const state = snapshot(); if (!currentEntry(state)) return;
        const ticks = position();
        if (ignoreSeek && now() <= ignoreSeek.until && Math.abs(ticks - ignoreSeek.ticks) < 5_000_000) return;
        if (Math.abs(ticks - state.positionTicks) > 5_000_000) {
            nativeGestureUntil = 0;
            void submit({ type: 'seek', positionTicks: ticks, paused: state.paused });
        }
    };
    const gesture = event => {
        if (event.isTrusted && event.target?.closest?.('.videoPlayerContainer, audio.htmlaudioplayer')) nativeGestureUntil = now() + 1500;
    };
    for (const event of ['pointerdown', 'touchstart', 'keydown']) host.document.addEventListener(event, gesture, true);
    host.document.addEventListener('seeked', seeked, true);
    const timer = host.setInterval(() => {
        if (!closed && !preparing && !buffered && snapshot()) applyTimeline(snapshot(), { origin: 'reconcile' });
    }, 1000);
    return {
        start: () => client.start(),
        getSnapshot: snapshot,
        dispose() {
            closed = true; generation++; preparationSequence++; preparing = undefined;
            client.dispose(); resetRate(); host.clearInterval(timer);
            host.document.removeEventListener('seeked', seeked, true);
            for (const event of ['pointerdown', 'touchstart', 'keydown']) host.document.removeEventListener(event, gesture, true);
            events.off(manager, 'playerchange', bind);
            if (player) for (const [name, handler] of [['pause', nativePausedChanged], ['unpause', nativePausedChanged], ['playing', playing], ['waiting', waiting]]) events.off(player, name, handler);
            for (const [name, callback] of installed) if (manager[name] === callback) manager[name] = original.get(name);
            if (manager.activityPlayback === hook) delete manager.activityPlayback;
            items.clear(); playOptions.clear();
        }
    };
}
