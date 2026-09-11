import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativePlaybackAdapter } from '../src/nativePlaybackAdapter.js';
import { createActivityPlaybackClient } from '../src/activityPlaybackClient.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
    const effects = []; const commands = []; const errors = []; const prepared = []; const intents = []; const eventHandlers = new Map();
    const domHandlers = new Map(); const intervals = new Map(); const timers = new Map();
    let at = Date.now(); let id = 0; let active = false; let paused = true; let ticks = 0; let rate = 1;
    let receiver; let core; let nativeQueue = []; let currentId; let repeat = 'RepeatNone';
    const events = {
        on(target, event, callback) {
            const handlers = eventHandlers.get(target) || new Map(); eventHandlers.set(target, handlers);
            handlers.set(event, [...handlers.get(event) || [], callback]);
        },
        off(target, event, callback) { const handlers = eventHandlers.get(target); if (handlers) handlers.set(event, (handlers.get(event) || []).filter(fn => fn !== callback)); },
        trigger(target, event, args = []) { for (const callback of eventHandlers.get(target)?.get(event) || []) callback({ type: event }, ...args); }
    };
    const queue = {
        getPlaylist: () => nativeQueue.slice(), setPlaylist: values => { nativeQueue = values.slice(); repeat = 'RepeatNone'; },
        getRepeatMode: () => repeat, setRepeatMode: value => { repeat = value; }, setPlaylistState: value => { currentId = value; }
    };
    const player = { getPlaybackRate: () => rate, setPlaybackRate: value => { rate = value; effects.push(['rate', value]); } };
    const manager = {
        _playQueueManager: queue, getCurrentPlayer: () => active ? player : undefined,
        getCurrentTicks: () => ticks, paused: () => paused, getRepeatMode: () => repeat,
        setRepeatMode(value) { repeat = value; effects.push(['repeat', value]); },
        getItemsForPlayback: async (_server, { Ids }) => ({ Items: Ids.split(',').map(Id => ({ Id, ServerId: 'server', MediaType: 'Video' })) }),
        pause() { paused = true; effects.push(['pause']); events.trigger(player, 'pause'); },
        unpause() { paused = false; effects.push(['unpause']); events.trigger(player, 'unpause'); },
        seek(value) { ticks = value; effects.push(['seek', value]); },
        stop() { active = false; paused = true; effects.push(['stop']); return Promise.resolve(); },
        playPause() {}, nextTrack() {}, previousTrack() {}, setCurrentPlaylistItem() {}, clearQueue() {}, removeFromPlaylist() {}, movePlaylistItem() {},
        setQueueShuffleMode() { nativeQueue.reverse(); }, toggleQueueShuffleMode() { nativeQueue.reverse(); },
        setVolume(value) { effects.push(['volume', value]); },
        activityPlayPrepared(values, options) {
            effects.push(['prepare', values[options.startIndex].Id]);
            const pending = deferred(); prepared.push({ ...pending, values, options });
            return pending.promise.then(() => {
                if (!options.activityIsCurrent()) return;
                active = true; paused = false; ticks = options.startPositionTicks;
                queue.setPlaylist(values); queue.setPlaylistState(values[options.startIndex].PlaylistItemId);
                events.trigger(manager, 'playerchange');
                effects.push(['started', values[options.startIndex].Id]);
            });
        }
    };
    const originalPause = manager.pause;
    const initial = { epoch: 'party', revision: 0, queueRevision: 0, queue: [], index: -1, positionTicks: 0, paused: true, repeatMode: 'RepeatNone', serverTimeMs: at };
    const host = { crypto: { randomUUID: () => `entry-${++id}` }, document: {
        addEventListener: (event, callback) => domHandlers.set(event, callback), removeEventListener: event => domHandlers.delete(event)
    }, setInterval: callback => { const value = ++id; intervals.set(value, callback); return value; }, clearInterval: value => intervals.delete(value) };
    const adapter = createNativePlaybackAdapter({ playbackManager: manager, events, apiClient: { serverId: () => 'server' }, baseUrl: '/jf/cap',
        onError: value => errors.push(value), host,
        createClient(options) {
            core = createActivityPlaybackClient({ ...options, now: () => at, newId: () => `command-${++id}`,
                setTimer: callback => { const value = ++id; timers.set(value, callback); return value; }, clearTimer: value => timers.delete(value),
                transport: { snapshot: async () => ({ snapshot: initial, clientId: 'local' }), isConnected: () => true,
                    subscribe(callback) { receiver = callback; return () => {}; },
                    send(command) { effects.push(['send', command.type]); commands.push(command); }
                }
            });
            return { ...core, submit(operation, options) { intents.push({ operation, options }); return core.submit(operation, options); } };
        }
    });
    await adapter.start();
    const begin = (ids = ['one', 'two', 'three']) => {
        void manager.activityPlayback.playPrepared(ids.map(Id => ({ Id, ServerId: 'server', MediaType: 'Video' })), { startIndex: 0 });
        return prepared.at(-1);
    };
    const start = async ids => { const pending = begin(ids); pending.resolve(); await tick(); return pending; };
    const ack = () => {
        const state = core.getSnapshot(); const command = commands.at(-1);
        receiver({ snapshot: { ...state, revision: command.sequence, command: { id: command.id, sequence: command.sequence, clientId: 'local' } },
            clientId: 'local', ack: { id: command.id } });
    };
    return { manager, adapter, commands, effects, errors, prepared, intents, player, events, domHandlers, intervals, timers, originalPause,
        begin, start, ack, core, get currentId() { return currentId; }, get paused() { return paused; }, get ticks() { return ticks; },
        setTicks(value) { ticks = value; }, physicalPause(value) { paused = value; events.trigger(player, value ? 'pause' : 'unpause'); },
        advance(milliseconds) { at += milliseconds; },
        remote(state) { receiver({ snapshot: { ...core.getSnapshot(), ...state, revision: 100, serverTimeMs: at }, clientId: 'local' }); },
        runInterval() { for (const callback of intervals.values()) callback(); }
    };
}

test('native prepared queue starts before sending and immediate local pause/seek/play never wait for acknowledgements', async () => {
    const f = await fixture();
    const pending = f.begin();
    assert.deepEqual(f.effects.slice(0, 2), [['prepare', 'one'], ['send', 'setQueue']]);
    pending.resolve(); await tick();
    const before = f.effects.length;
    void f.manager.pause();
    assert.equal(f.paused, true);
    assert.deepEqual(f.effects.slice(before, before + 2), [['pause'], ['send', 'setPlayback']]);
    void f.manager.seek(40_000_000);
    assert.equal(f.ticks, 40_000_000);
    assert.equal(f.paused, true, 'seeking a paused party stays paused');
    void f.manager.playPause(); assert.equal(f.paused, false);
    void f.manager.playPause(); assert.equal(f.paused, true, 'a second click uses current local intent before any response');
    assert.equal(f.prepared.length, 1);
    f.ack(); await tick();
    assert.equal(f.prepared.length, 1, 'own acknowledgement cannot restart the video');
    f.adapter.dispose();
});

test('rapid next/previous commands prepare the latest explicit queue entry and stale completions cannot replace it', async () => {
    const f = await fixture(); await f.start();
    void f.manager.nextTrack(); const second = f.prepared.at(-1);
    void f.manager.nextTrack(); const third = f.prepared.at(-1);
    assert.equal(second.values[second.options.startIndex].Id, 'two');
    assert.equal(third.values[third.options.startIndex].Id, 'three');
    third.resolve(); await tick(); second.resolve(); await tick();
    assert.equal(f.currentId, f.core.getSnapshot().queue[2].id);
    assert.equal(f.effects.filter(effect => effect[0] === 'started' && effect[1] === 'two').length, 0);
    assert.equal(f.commands.at(-1).type, 'select');
    void f.manager.previousTrack(); assert.equal(f.prepared.at(-1).values[f.prepared.at(-1).options.startIndex].Id, 'two');
    f.adapter.dispose(); f.prepared.at(-1).resolve(); await tick();
});

test('buffering and OS/autoplay pauses do not send party commands; actual native control gestures still do', async () => {
    const f = await fixture(); await f.start(); const count = f.commands.length;
    f.events.trigger(f.player, 'waiting'); f.physicalPause(true); f.runInterval();
    assert.equal(f.commands.length, count);
    f.events.trigger(f.player, 'playing');
    f.physicalPause(true);
    assert.equal(f.commands.length, count, 'an OS pause with no native control gesture stays personal');
    f.domHandlers.get('pointerdown')({ isTrusted: true, target: { closest: () => ({}) } });
    f.physicalPause(true);
    assert.equal(f.commands.length, count + 1);
    assert.equal(f.commands.at(-1).paused, true);
    f.adapter.dispose();
});

test('native queue edits retain playback, empty queue stops, duplicate media entries retain distinct shared ids', async () => {
    const f = await fixture(); await f.start(['same', 'same', 'other']);
    const state = f.core.getSnapshot();
    assert.notEqual(state.queue[0].id, state.queue[1].id);
    void f.manager.movePlaylistItem(state.queue[2].id, 1);
    assert.deepEqual(f.manager._playQueueManager.getPlaylist().map(item => item.Id), ['same', 'other', 'same']);
    assert.equal(f.prepared.length, 1);
    void f.manager.clearQueue(true);
    assert.equal(f.commands.at(-1).type, 'stop');
    assert.equal(f.paused, true);
    f.adapter.dispose();
});

test('disposing restores native controls and invalidates pending media preparation without broadcasting Stop', async () => {
    const f = await fixture(); const pending = f.begin(); const count = f.commands.length;
    f.adapter.dispose(); pending.resolve(); await tick();
    assert.equal(f.manager.pause, f.originalPause);
    assert.equal(f.manager.activityPlayback, undefined);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.domHandlers.size, 0);
    assert.equal(f.commands.length, count);
    assert.equal(f.effects.some(effect => effect[0] === 'started'), false);
    assert.deepEqual(f.errors, []);
});

test('automatic episode-end checks the ended entry before advancing a replaced party and RepeatOne starts a fresh instance', async () => {
    const f = await fixture(); await f.start();
    const oldEntry = f.core.getSnapshot().queue[0].id;
    void f.manager.nextTrack(); const count = f.commands.length;
    f.manager.activityPlayback.ended({ PlayState: { PlaylistItemId: oldEntry } });
    assert.equal(f.commands.length, count, 'a delayed ended callback cannot skip the new episode');
    f.prepared.at(-1).resolve(); await tick();
    void f.manager.setRepeatMode('RepeatOne');
    assert.equal(f.manager.getRepeatMode(), 'RepeatOne', 'repeat changes apply locally before acknowledgement');
    const before = f.core.getSnapshot();
    const stopped = { PlayState: { PlaylistItemId: before.queue[before.index].id } };
    const ended = f.manager.activityPlayback.captureEnded(stopped);
    void f.manager.activityPlayback.ended(stopped, ended);
    assert.equal(f.commands.at(-1).queueItemId, before.queue[before.index].id);
    assert.equal(f.core.getSnapshot().queueRevision, before.queueRevision + 1, 'a repeated episode owns a fresh queue revision');
    assert.equal(f.prepared.length, 3, 'ended clears the native source, so RepeatOne prepares the same item again');
    const countAfterRepeat = f.commands.length;
    f.manager.activityPlayback.ended(stopped, ended);
    assert.equal(f.commands.length, countAfterRepeat, 'a delayed end belongs to its captured playback revision');
    f.prepared.at(-1).resolve(); await tick();
    assert.equal(f.manager.getRepeatMode(), 'RepeatOne', 'native setPlaylist must not reset the shared repeat choice');
    f.adapter.dispose();
});

test('Stop and a remote title replacement invalidate native item translation still in flight', async () => {
    for (const action of ['stop', 'replace']) {
        const f = await fixture(); const hook = f.manager.activityPlayback;
        const preparation = hook.beginPreparation();
        assert.equal(hook.isPreparationCurrent(preparation), true);
        if (action === 'stop') void f.manager.stop();
        else f.remote({ queue: [{ id: 'remote-entry', itemId: 'remote-title' }], index: 0, positionTicks: 0, paused: false, queueRevision: 1 });
        assert.equal(hook.isPreparationCurrent(preparation), false, action);
        f.adapter.dispose(); await tick();
    }
});


test('remote queue entry id reuse with a different media id hydrates and plays the authorized replacement', async () => {
    const f = await fixture(); await f.start(['old']); f.ack(); await tick();
    const before = f.core.getSnapshot();
    f.remote({ queue: [{ id: before.queue[0].id, itemId: 'replacement' }], queueRevision: before.queueRevision + 1 });
    await tick();
    assert.equal(f.prepared.at(-1).values[0].Id, 'replacement');
    f.prepared.at(-1).resolve(); await tick();
    assert.equal(f.manager._playQueueManager.getPlaylist()[0].Id, 'replacement');
    f.adapter.dispose();
});

test('shared RepeatAll chooses the first entry at the end while RepeatNone stops the queue', async () => {
    for (const repeatMode of ['RepeatAll', 'RepeatNone']) {
        const f = await fixture(); await f.start(['only']);
        void f.manager.setRepeatMode(repeatMode);
        const state = { PlayState: { PlaylistItemId: f.currentId } };
        const ended = f.manager.activityPlayback.captureEnded(state);
        void f.manager.activityPlayback.ended(state, ended);
        assert.equal(f.commands.at(-1).type, repeatMode === 'RepeatAll' ? 'select' : 'stop');
        f.adapter.dispose();
    }
});


test('only natural episode ends mark their selection or Stop as automatic', async () => {
    for (const ids of [['one', 'two'], ['only']]) {
        const f = await fixture(); await f.start(ids);
        void f.manager.pause(); void f.manager.seek(10_000_000); void f.manager.unpause();
        assert.ok(f.intents.every(intent => intent.options?.automatic !== true));
        const state = { PlayState: { PlaylistItemId: f.currentId } };
        const ended = f.manager.activityPlayback.captureEnded(state);
        void f.manager.activityPlayback.ended(state, ended);
        assert.equal(f.intents.at(-1).options.automatic, true);
        assert.equal(f.intents.at(-1).operation.type, ids.length > 1 ? 'select' : 'stop');
        void f.manager.stop();
        assert.equal(f.intents.at(-1).operation.type, 'stop');
        assert.notEqual(f.intents.at(-1).options?.automatic, true, 'manual Stop must retain conflict feedback');
        f.adapter.dispose();
    }
});

test('a queue insertion during remote hydration cannot use the new index against an older prepared array', async () => {
    const f = await fixture();
    const delayed = deferred();
    f.manager.getItemsForPlayback = () => delayed.promise;
    const oldQueue = [{ id: 'a', itemId: 'one' }, { id: 'b', itemId: 'two' }];
    f.remote({ queue: oldQueue, index: 0, queueRevision: 1, paused: false });
    f.remote({ queue: [{ id: 'x', itemId: 'inserted' }, ...oldQueue], index: 1, queueRevision: 2, paused: false });
    delayed.resolve({ Items: [{ Id: 'one', ServerId: 'server' }, { Id: 'two', ServerId: 'server' }] });
    await tick();
    const prepared = f.prepared.at(-1);
    assert.equal(prepared.values[prepared.options.startIndex].Id, 'one', 'the chosen entry remains one after its queue index changes');
    f.adapter.dispose();
});
