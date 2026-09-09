import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { observeWatchPresence, watchPresenceSnapshot } from '../src/watchPresence.js';
const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');

function fixture({ alreadyPlayed = false, audio = false } = {}) {
    const window = new JSDOM(`<${audio ? 'audio class="mediaPlayerAudio"' : 'video class="htmlvideoplayer"'}></${audio ? 'audio' : 'video'}>`, { url: 'https://activity.test/' }).window;
    const document = window.document;
    const media = document.querySelector('video, audio');
    const values = { paused: !alreadyPlayed, readyState: 4, ended: false, currentTime: 12, duration: 1380, playbackRate: 1,
        currentSrc: 'https://activity.test/jf/synthetic/stream.mp4', played: { length: alreadyPlayed ? 1 : 0 } };
    for (const name of Object.keys(values)) Object.defineProperty(media, name, { configurable: true, get: () => values[name] });
    const item = { Id: 'episode-id', ServerId: 'server-id', Type: 'Episode', MediaType: audio ? 'Audio' : 'Video', Name: 'Rebirth',
        SeriesName: 'Death Note', ParentIndexNumber: 1, IndexNumber: 1, ProductionYear: 2006, RunTimeTicks: 13800000000 };
    const model = { player: { isLocalPlayer: true }, item, source: { Id: 'source-id' }, valid: true, positionTicks: 120000000 };
    const managerEvents = new Map(); const timers = new Map(); const calls = [];
    const playbackManager = { getCurrentPlayer: () => model.player, currentItem: player => { assert.equal(player, model.player); return model.item; },
        currentMediaSource: player => { assert.equal(player, model.player); return model.source; },
        getPlayerState: player => { assert.equal(player, model.player); return { PlayState: { PositionTicks: model.positionTicks }, NowPlayingItem: model.item }; } };
    const events = { on: (target, name, callback) => { assert.equal(target, playbackManager); managerEvents.set(name, callback); },
        off: (target, name, callback) => { assert.equal(target, playbackManager); assert.equal(managerEvents.get(name), callback); managerEvents.delete(name); } };
    const publisher = Object.fromEntries(['update', 'clear', 'dispose'].map(method => [method, value => calls.push({ method, value })]));
    const observer = observeWatchPresence({ document, playbackManager, events, publisher, isCurrent: () => model.valid,
        setInterval: (callback, ms) => { assert.equal(ms, 15000); timers.set(1, callback); return 1; }, clearInterval: id => timers.delete(id) });
    return { window, document, media, values, model, managerEvents, timers, calls, publisher, observer,
        updates: () => calls.filter(call => call.method === 'update').map(call => call.value),
        emit: (event, changes = {}, target = media) => { Object.assign(values, changes); target.dispatchEvent(new window.Event(event)); },
        manager: (name, ...args) => managerEvents.get(name)?.({}, ...args),
        poll: () => timers.get(1)?.(),
        close: () => { observer.dispose(); window.close(); } };
}

test('presence snapshot uses native episode metadata and absolute ticks without copying private fields', () => {
    const media = { paused: false, readyState: 4, currentTime: 5, duration: 60, playbackRate: 1.25 };
    const snapshot = watchPresenceSnapshot({ Type: 'Episode', Name: 'Rebirth\n\u202e episode', SeriesName: 'Death Note', ParentIndexNumber: 1,
        IndexNumber: 1, IndexNumberEnd: 2, ProductionYear: 2006, RunTimeTicks: 13800000000, Id: 'private-id', Path: '/private/file',
        ServerUrl: 'https://private.test', Token: 'secret', ProviderIds: { Imdb: 'tt000' } },
    { PlayState: { PositionTicks: 6050000000 }, NowPlayingItem: { RunTimeTicks: 13800000000 } }, media);
    assert.deepEqual(snapshot, { kind: 'episode', title: 'Rebirth episode', seriesName: 'Death Note', seasonNumber: 1, episodeNumber: 1,
        episodeEndNumber: 2, year: 2006, positionMs: 605000, durationMs: 1380000, paused: false, buffering: false, playbackRate: 1.25 });
    assert.equal(JSON.stringify(snapshot).includes('private'), false);
});

test('snapshot clamps progress, validates scalars and handles movie/audio/video metadata', () => {
    const media = { paused: true, readyState: 1, currentTime: 200, duration: 100, playbackRate: NaN };
    assert.deepEqual(watchPresenceSnapshot({ Type: 'Movie', Name: 'Movie', ProductionYear: 2020, SeriesName: 'irrelevant', IndexNumber: 8 }, {}, media),
        { kind: 'movie', title: 'Movie', year: 2020, positionMs: 100000, durationMs: 100000, paused: true, buffering: false, playbackRate: 1 });
    assert.equal(watchPresenceSnapshot({ Name: 'Song', MediaType: 'Audio' }, {}, media).kind, 'audio');
    assert.equal(watchPresenceSnapshot({ Name: 'Clip' }, {}, media).kind, 'video');
    assert.equal(watchPresenceSnapshot({ Name: '\n\u202e' }, {}, media), null);
    const invalid = watchPresenceSnapshot({ Name: 'Episode', Type: 'Episode', ParentIndexNumber: -1, IndexNumber: 1.5, IndexNumberEnd: Infinity,
        ProductionYear: 10000, RunTimeTicks: -1 }, { PlayState: { PositionTicks: Infinity } }, { ...media, duration: Infinity, currentTime: NaN });
    assert.equal(invalid.positionMs, 0); assert.equal(invalid.durationMs, 0);
    assert.equal('seasonNumber' in invalid, false); assert.equal('episodeNumber' in invalid, false);
    assert.equal('episodeEndNumber' in invalid, false); assert.equal('year' in invalid, false);
});

test('preparation never announces watching; actual playing, buffering, pause, seek and rate changes do', () => {
    const f = fixture();
    try {
        f.manager('playbackstart', f.model.player); f.emit('play'); f.poll();
        assert.equal(f.updates().length, 0);
        f.emit('playing', { paused: false, played: { length: 1 } });
        assert.equal(f.updates().at(-1).title, 'Rebirth');
        // The native manager may announce metadata after play() resolves.
        f.manager('playbackstart', f.model.player);
        assert.equal(f.calls.at(-1).method, 'update');
        f.emit('waiting'); assert.equal(f.updates().at(-1).buffering, true);
        f.emit('pause', { paused: true }); assert.equal(f.updates().at(-1).paused, true); assert.equal(f.updates().at(-1).buffering, false);
        f.emit('playing', { paused: false });
        f.emit('seeking'); assert.equal(f.updates().at(-1).buffering, true);
        f.model.positionTicks = 4730000000;
        f.emit('seeked'); assert.equal(f.updates().at(-1).positionMs, 473000); assert.equal(f.updates().at(-1).buffering, false);
        f.emit('ratechange', { playbackRate: 1.5 }); assert.equal(f.updates().at(-1).playbackRate, 1.5);
        f.model.positionTicks += 150000000; f.poll(); assert.equal(f.updates().at(-1).positionMs, 488000);
    } finally { f.close(); }
});

test('playing can precede installation of the native manager player, without trusting preparation alone', () => {
    const f = fixture();
    try {
        const player = f.model.player; f.model.player = undefined;
        f.emit('playing', { paused: false });
        assert.equal(f.updates().length, 0);
        f.model.player = player;
        f.manager('playerchange', player);
        f.manager('playbackstart', player);
        assert.equal(f.updates().at(-1).title, 'Rebirth');
    } finally { f.close(); }
});

test('observer attaches to established playback and ignores temporary or unrelated media', () => {
    const f = fixture({ alreadyPlayed: true });
    try {
        assert.equal(f.updates().length, 1);
        const probe = f.document.createElement('audio'); probe.className = 'testMediaPlayerAudio'; f.document.body.append(probe);
        f.emit('playing', {}, probe); f.emit('pause', {}, probe);
        const other = f.document.createElement('video'); f.document.body.append(other); f.emit('playing', {}, other);
        assert.equal(f.updates().length, 1);
        f.observer.clear(); f.observer.refresh(); assert.equal(f.calls.at(-1).method, 'update');
    } finally { f.close(); }
});

test('source, item and account changes discard playback proof until the new source actually plays', () => {
    const f = fixture({ alreadyPlayed: true });
    try {
        for (const change of [() => { f.model.source = { Id: 'new-source' }; }, () => { f.model.item = { ...f.model.item, Id: 'new-episode', Name: 'Confrontation' }; },
            () => { f.values.currentSrc = 'https://activity.test/jf/new/stream.mp4'; }]) {
            const count = f.updates().length; change(); f.poll(); f.manager('playbackstart', f.model.player);
            assert.equal(f.calls.at(-1).method, 'clear'); assert.equal(f.updates().length, count);
            f.emit('playing', { paused: false }); assert.equal(f.updates().length, count + 1);
        }
        f.model.valid = false; f.emit('pause'); f.poll(); f.emit('playing');
        assert.equal(f.calls.at(-1).method, 'clear');
        const count = f.updates().length; f.model.valid = true; f.poll(); assert.equal(f.updates().length, count);
        f.observer.refresh(); assert.equal(f.updates().length, count + 1);
    } finally { f.close(); }
});

test('native stop/end/error/source-empty and remote player changes clear presence', () => {
    const f = fixture({ alreadyPlayed: true });
    try {
        for (const event of ['ended', 'error', 'emptied']) {
            f.emit(event); assert.equal(f.calls.at(-1).method, 'clear'); f.poll(); assert.equal(f.calls.at(-1).method, 'clear');
            f.emit('playing', { paused: false }); assert.equal(f.calls.at(-1).method, 'update');
        }
        const count = f.calls.length; f.manager('playbackstop', { player: {} }); assert.equal(f.calls.length, count);
        f.manager('playbackstop', { player: f.model.player }); assert.equal(f.calls.at(-1).method, 'clear');
        f.emit('playing'); f.model.player = { isLocalPlayer: false }; f.manager('playerchange', f.model.player);
        assert.equal(f.calls.at(-1).method, 'clear');
    } finally { f.close(); }
});

test('native audio is observed and publisher failures cannot interrupt media events', async () => {
    const f = fixture({ audio: true });
    try {
        f.model.item = { Id: 'song', Name: 'Song', Type: 'Audio', MediaType: 'Audio' };
        f.emit('playing', { paused: false }); assert.equal(f.updates().at(-1).kind, 'audio');
        f.publisher.update = () => { throw new Error('RPC unavailable'); };
        assert.doesNotThrow(() => f.emit('pause', { paused: true }));
        f.publisher.update = async () => { throw new Error('RPC rejected'); };
        f.emit('playing', { paused: false }); await new Promise(resolve => setImmediate(resolve));
    } finally { f.close(); }
});

test('disposal removes observers and rejects late callbacks from the old account', () => {
    const f = fixture({ alreadyPlayed: true });
    try {
        const lateCallbacks = [...f.managerEvents.values()]; const latePoll = f.timers.get(1);
        f.observer.dispose(); const count = f.calls.length;
        assert.equal(f.calls.at(-1).method, 'dispose'); assert.equal(f.managerEvents.size, 0); assert.equal(f.timers.size, 0);
        f.emit('playing'); latePoll(); for (const callback of lateCallbacks) callback({}, f.model.player);
        f.observer.clear(); f.observer.refresh(); f.observer.dispose();
        assert.equal(f.calls.length, count);
    } finally { f.close(); }
});
