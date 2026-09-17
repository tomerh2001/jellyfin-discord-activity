import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityPlaybackClient, createActivityPlaybackTransport } from '../src/activityPlaybackClient.js';

const initial = () => ({ epoch: 'party-epoch', revision: 1, queueRevision: 1,
    queue: [{ id: 'queue-first', itemId: 'a'.repeat(32) }, { id: 'queue-second', itemId: 'b'.repeat(32) }],
    index: 0, positionTicks: 10_000_000, paused: true, serverTimeMs: 1000, repeatMode: 'RepeatNone' });
function fixture() {
    let time = 1000;
    let id = 0;
    let open = true;
    let source = initial();
    let handlers;
    const effects = [];
    const sent = [];
    const errors = [];
    const timers = new Map();
    const transport = {
        isConnected: () => open,
        subscribe: (state, error, status, resume) => { handlers = { state, error, status, resume }; return () => { handlers = undefined; }; },
        snapshot: async () => ({ snapshot: { ...source }, clientId: 'self' }),
        send: command => { if (!open) throw new Error('closed'); sent.push({ ...command }); }
    };
    const client = createActivityPlaybackClient({ transport, apply: (state, metadata) => effects.push({ state, metadata, time }),
        onError: value => errors.push(value), now: () => time, newId: () => `command-${++id}`,
        setTimer: callback => { const id = Symbol(); timers.set(id, callback); return id; }, clearTimer: id => timers.delete(id) });
    return { client, effects, sent, errors, transport, timers,
        advance: delta => { time += delta; },
        source: value => { source = { ...value }; },
        state: (snapshot, ack, sequence) => handlers.state({ snapshot, clientId: 'self', ...(ack ? { ack } : {}), ...(sequence === undefined ? {} : { sequence }) }),
        reject: data => handlers.error({ clientId: 'self', ...data }),
        status: value => { open = value; handlers.status(value); },
        resume: () => handlers.resume(),
        current: () => source,
        tick: () => new Promise(resolve => setImmediate(resolve))
    };
}

test('local play, pause and buffered seek apply before transport and without acknowledgements', async () => {
    const f = fixture();
    await f.client.start();
    const order = [];
    const send = f.transport.send;
    f.transport.send = command => { order.push(f.effects.at(-1).metadata.type); send(command); };
    const play = f.client.submit({ type: 'setPlayback', paused: false }).catch(() => {});
    assert.equal(f.client.getSnapshot().paused, false);
    assert.equal(f.effects.at(-1).time, 1000);
    f.advance(800);
    assert.equal(f.client.getSnapshot().positionTicks, 18_000_000);
    const pause = f.client.submit({ type: 'setPlayback', paused: true }).catch(() => {});
    assert.equal(f.effects.at(-1).state.paused, true);
    const seek = f.client.submit({ type: 'seek', positionTicks: 500_000_000, paused: true }).catch(() => {});
    assert.equal(f.effects.at(-1).state.positionTicks, 500_000_000);
    assert.deepEqual(order, ['setPlayback', 'setPlayback', 'seek']);
    assert.equal(f.sent.length, 3, 'sends each action without waiting for the previous acknowledgement');
    f.client.dispose(); await Promise.all([play, pause, seek]);
});

test('a delayed play echo cannot undo a newer local pause or seek', async () => {
    const f = fixture(); await f.client.start();
    const play = f.client.submit({ type: 'setPlayback', paused: false });
    f.advance(400);
    const pause = f.client.submit({ type: 'setPlayback', paused: true });
    const seek = f.client.submit({ type: 'seek', positionTicks: 90_000_000, paused: true });
    const count = f.effects.length;
    f.state({ ...initial(), revision: 2, paused: false, positionTicks: 14_000_000, serverTimeMs: 1400,
        command: { id: f.sent[0].id, clientId: 'self', sequence: 1 } });
    await play;
    assert.equal(f.client.getSnapshot().paused, true);
    assert.equal(f.client.getSnapshot().positionTicks, 90_000_000);
    assert.equal(f.effects.length, count, 'matching old echo does not repeat an effect');
    f.state({ ...initial(), revision: 3, paused: true, positionTicks: 14_000_000, serverTimeMs: 1400 }, f.sent[1].id);
    f.state({ ...initial(), revision: 4, paused: true, positionTicks: 90_000_000, serverTimeMs: 1400 }, { id: f.sent[2].id });
    await Promise.all([pause, seek]);
    assert.equal(f.effects.length, count);
    f.client.dispose();
});

test('a retry keeps its command identity and cannot advance Next twice', async () => {
    const f = fixture(); await f.client.start();
    const next = f.client.submit({ type: 'select', queueItemId: 'queue-second', positionTicks: 0, paused: false });
    assert.equal(f.client.getSnapshot().index, 1);
    const timer = [...f.timers.values()][0];
    f.timers.clear(); timer();
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.sent[0], f.sent[1]);
    assert.equal(f.effects.filter(value => value.metadata.origin === 'local').length, 1);
    f.state({ ...initial(), revision: 2, queueRevision: 2, index: 1, positionTicks: 0, paused: false }, f.sent[0].id);
    await next; f.client.dispose();
});

test('a concurrent queue replacement rejects stale Next and reconciles once', async () => {
    const f = fixture(); await f.client.start();
    const next = f.client.submit({ type: 'select', queueItemId: 'queue-second', positionTicks: 0, paused: false });
    const replacement = { ...initial(), revision: 3, queueRevision: 3,
        queue: [{ id: 'new-item', itemId: 'c'.repeat(32) }], index: 0, positionTicks: 0 };
    f.reject({ id: f.sent[0].id, code: 'activity_queue_changed', snapshot: replacement });
    await assert.rejects(next, /queue/i);
    assert.equal(f.client.getSnapshot().queue[0].id, 'new-item');
    assert.equal(f.effects.at(-1).metadata.origin, 'reconcile');
    f.client.dispose();
});

test('out-of-order old snapshots never replace a newer acknowledged timeline', async () => {
    const f = fixture(); await f.client.start();
    f.state({ ...initial(), revision: 4, positionTicks: 300_000_000 });
    const count = f.effects.length;
    f.state({ ...initial(), revision: 2, positionTicks: 20_000_000 });
    assert.equal(f.client.getSnapshot().positionTicks, 300_000_000);
    assert.equal(f.effects.length, count);
    f.client.dispose();
});

test('late acknowledgement removes pending intent even when a newer remote revision arrived first', async () => {
    const f = fixture(); await f.client.start();
    const pause = f.client.submit({ type: 'setPlayback', paused: true, positionTicks: 10_000_000 });
    f.state({ ...initial(), revision: 3, paused: false, positionTicks: 200_000_000 });
    f.state({ ...initial(), revision: 2 }, f.sent[0].id);
    await pause;
    assert.equal(f.client.getSnapshot().paused, false);
    assert.equal(f.client.getSnapshot().positionTicks, 200_000_000);
    f.client.dispose();
});

test('connection recovery fetches a fresh snapshot and never replays old clicks', async () => {
    const f = fixture(); await f.client.start();
    const pending = f.client.submit({ type: 'setPlayback', paused: false });
    f.status(false);
    await assert.rejects(pending, /interrupted/);
    const recovery = { ...initial(), revision: 4, index: 1, queueRevision: 2, positionTicks: 40_000_000 };
    f.source(recovery);
    f.status(true);
    await f.tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.client.getSnapshot().index, 1);
    assert.equal(f.client.getSnapshot().paused, true);
    assert.equal(f.timers.size, 0);
    f.client.dispose();
});

test('mobile resume follows the current episode even when the socket never reported a disconnect', async () => {
    const f = fixture(); await f.client.start();
    f.source({ ...initial(), revision: 3, queueRevision: 2, index: 1, positionTicks: 90_000_000, paused: false });
    f.resume(); await f.tick();
    assert.equal(f.client.getSnapshot().index, 1);
    assert.equal(f.effects.at(-1).state.positionTicks, 90_000_000);
    assert.equal(f.effects.at(-1).metadata.origin, 'reconcile');
    assert.equal(f.sent.length, 0);
    f.client.dispose();
});

test('reconnect supersedes an in-flight snapshot and ignores its late former-epoch reply', async () => {
    const f = fixture(); await f.client.start();
    const requests = [];
    f.transport.snapshot = () => new Promise(resolve => requests.push(resolve));
    const oldRequest = f.client.refresh();
    f.status(false); f.status(true);
    assert.equal(requests.length, 2, 'reconnection must not reuse a pre-reconnection request');
    requests[1]({ snapshot: { ...initial(), epoch: 'new-party', revision: 1, index: 1 }, clientId: 'self' });
    await f.tick();
    requests[0]({ snapshot: { ...initial(), epoch: 'former-party', revision: 10 }, clientId: 'self' });
    await oldRequest;
    assert.equal(f.client.getSnapshot().epoch, 'new-party');
    assert.equal(f.client.getSnapshot().index, 1);
    f.client.dispose();
});

test('snapshot recovery reapplies unchanged state to a suspended player without issuing a party command', async () => {
    const f = fixture(); await f.client.start();
    const previous = f.effects.length;
    f.resume(); await f.tick();
    assert.equal(f.effects.length, previous + 1);
    assert.deepEqual(f.effects.at(-1).metadata, { origin: 'reconcile', resumed: true });
    await f.client.refresh();
    assert.deepEqual(f.effects.at(-1).metadata, { origin: 'reconcile' }, 'ordinary snapshots cannot repeatedly force catch-up');
    assert.equal(f.sent.length, 0);
    f.client.dispose();
});

test('a transient mobile resume failure retries within a bound and disposal cancels recovery', async () => {
    const f = fixture(); await f.client.start();
    let requests = 0;
    f.transport.snapshot = async () => { requests++; throw new TypeError('network unavailable'); };
    f.resume(); await f.tick();
    assert.equal(requests, 1);
    for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal(f.timers.size, 1);
        const callback = [...f.timers.values()][0]; f.timers.clear(); callback(); await f.tick();
    }
    assert.equal(requests, 3);
    assert.equal(f.timers.size, 0, 'failed recovery must not poll forever');
    f.resume(); await f.tick();
    assert.equal(f.timers.size, 1);
    f.client.dispose();
    assert.equal(f.timers.size, 0);
});

test('authorization failures do not start mobile recovery retries', async () => {
    const f = fixture(); await f.client.start();
    f.transport.snapshot = async () => { throw Object.assign(new Error('expired'), { code: 'native_session_expired' }); };
    f.resume(); await f.tick();
    assert.equal(f.timers.size, 0);
    f.client.dispose();
});

test('a new remote seek reaches the player once and repeated snapshots do not replay it', async () => {
    const f = fixture(); await f.client.start();
    const remote = { ...initial(), revision: 2, positionTicks: 400_000_000,
        command: { id: 'remote-seek', clientId: 'other', sequence: 1, type: 'seek' } };
    f.state(remote);
    assert.deepEqual(f.effects.at(-1).metadata, { origin: 'remote', type: 'seek' });
    const applied = f.effects.length;
    f.state(remote);
    assert.equal(f.effects.length, applied);
    f.source(remote);
    await f.client.refresh();
    assert.deepEqual(f.effects.at(-1).metadata, { origin: 'reconcile' });
    f.client.dispose();
});

test('an explicit remote seek is honored even inside the normal drift tolerance', async () => {
    const f = fixture(); await f.client.start();
    const applied = f.effects.length;
    f.state({ ...initial(), revision: 2, positionTicks: 10_100_000,
        command: { id: 'remote-short-seek', clientId: 'other', sequence: 1, type: 'seek' } });
    assert.equal(f.effects.length, applied + 1);
    assert.deepEqual(f.effects.at(-1).metadata, { origin: 'remote', type: 'seek' });
    f.client.dispose();
});

test('a remote seek cannot replace the effect type of a newer pending local intent', async () => {
    const f = fixture(); await f.client.start();
    const seek = f.client.submit({ type: 'seek', positionTicks: 90_000_000, paused: true }).catch(() => {});
    const applied = f.effects.length;
    f.state({ ...initial(), revision: 2, positionTicks: 500_000_000,
        command: { id: 'remote-seek', clientId: 'other', sequence: 1, type: 'seek' } });
    assert.equal(f.effects.length, applied);
    assert.equal(f.client.getSnapshot().positionTicks, 90_000_000);
    f.client.dispose(); await seek;
});

test('an epoch replacement invalidates pending controls and old timers', async () => {
    const f = fixture(); await f.client.start();
    const pending = f.client.submit({ type: 'seek', positionTicks: 90_000_000, paused: false });
    f.state({ ...initial(), epoch: 'replacement-epoch', revision: 0, queueRevision: 0, queue: [], index: -1, positionTicks: 0 });
    await assert.rejects(pending, /changed/);
    assert.equal(f.client.getSnapshot().epoch, 'replacement-epoch');
    assert.equal(f.client.getSnapshot().queue.length, 0);
    assert.equal(f.timers.size, 0);
    f.client.dispose();
});

test('a newer socket state wins over a delayed initial snapshot', async () => {
    const f = fixture();
    let resolve;
    f.transport.snapshot = () => new Promise(yes => { resolve = yes; });
    const started = f.client.start();
    f.state({ ...initial(), revision: 5, positionTicks: 500_000_000 });
    resolve({ snapshot: initial(), clientId: 'self' });
    await started;
    assert.equal(f.client.getSnapshot().revision, 5);
    assert.equal(f.client.getSnapshot().positionTicks, 500_000_000);
    f.client.dispose();
});

test('joining an already-playing party projects its position without changing party state', async () => {
    const f = fixture();
    f.source({ ...initial(), paused: false, positionTicks: 700_000_000 });
    await f.client.start();
    f.advance(800);
    assert.equal(f.client.getSnapshot().positionTicks, 708_000_000);
    assert.equal(f.sent.length, 0);
    f.client.dispose();
});

test('disposing suppresses late snapshots and asynchronous player errors', async () => {
    let resolve;
    let state;
    const effects = [];
    const errors = [];
    const client = createActivityPlaybackClient({ transport: {
        isConnected: () => true, subscribe: callback => { state = callback; return () => {}; },
        snapshot: () => new Promise(yes => { resolve = yes; })
    }, apply: value => effects.push(value), onError: error => errors.push(error) });
    const started = client.start();
    client.dispose();
    resolve({ snapshot: initial(), clientId: 'self' });
    state({ snapshot: initial(), clientId: 'self' });
    await started;
    assert.equal(effects.length, 0);
    assert.equal(errors.length, 0);
});

test('transport uses the existing authenticated native socket and capability-scoped snapshot route', async () => {
    const sent = [];
    const requests = [];
    let onMessage;
    let onStatus;
    let unsubscribed = false;
    const apiClient = { isWebSocketOpen: () => true,
        subscribe: (types, callback) => { assert.deepEqual(types, ['ActivityPlaybackState', 'ActivityPlaybackError']); onMessage = callback; return () => { unsubscribed = true; }; },
        _sdk: { webSocket: { onStatusChange: callback => { onStatus = callback; return () => {}; }, sendMessage: value => sent.push(value) } } };
    const transport = createActivityPlaybackTransport({ apiClient, baseUrl: '/jf/test-capability/',
        fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ snapshot: initial(), clientId: 'self' }) }; } });
    const states = [], errors = [], statuses = [];
    const stop = transport.subscribe(value => states.push(value), value => errors.push(value), value => statuses.push(value));
    transport.send({ id: 'one', type: 'stop' });
    assert.deepEqual(sent[0], { MessageType: 'ActivityPlaybackCommand', Data: { id: 'one', type: 'stop' } });
    onMessage({ MessageType: 'ActivityPlaybackState', Data: 'snapshot' });
    onMessage({ MessageType: 'ActivityPlaybackError', Data: 'error' });
    onStatus(1); onStatus('disconnected');
    await transport.snapshot();
    assert.equal(requests[0].url, '/jf/test-capability/Activity/Playback');
    assert.equal(requests[0].options.credentials, 'omit');
    assert.equal(requests[0].options.cache, 'no-store');
    assert.deepEqual(states, ['snapshot']); assert.deepEqual(errors, ['error']); assert.deepEqual(statuses, [true, false]);
    stop(); transport.dispose(); assert.equal(unsubscribed, true);
});

test('transport refreshes on visible, pageshow and online without reconnecting a healthy socket', () => {
    const host = new EventTarget();
    host.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    let resumes = 0;
    let unsubscribed = 0;
    const apiClient = { isWebSocketOpen: () => true, subscribe: () => () => { unsubscribed++; },
        _sdk: { webSocket: { onStatusChange: () => () => { unsubscribed++; } } } };
    const transport = createActivityPlaybackTransport({ apiClient, baseUrl: '/jf/test-capability', host });
    const stop = transport.subscribe(() => {}, () => {}, () => {}, () => { resumes++; });
    host.document.dispatchEvent(new Event('visibilitychange'));
    host.dispatchEvent(new Event('online'));
    assert.equal(resumes, 0, 'hidden documents wait until foregrounded');
    host.document.visibilityState = 'visible';
    host.document.dispatchEvent(new Event('visibilitychange'));
    host.dispatchEvent(new Event('pageshow'));
    host.dispatchEvent(new Event('online'));
    assert.equal(resumes, 3);
    stop(); transport.dispose();
    host.document.dispatchEvent(new Event('visibilitychange'));
    host.dispatchEvent(new Event('pageshow'));
    host.dispatchEvent(new Event('online'));
    assert.equal(resumes, 3, 'disposed clients must not respond to document events');
    assert.equal(unsubscribed, 2);
});


test('newer own acknowledgement does not replay an earlier queue whose acknowledgement is delayed', async () => {
    const f = fixture(); await f.client.start();
    const queue = [{ id: 'replacement-first', itemId: 'c'.repeat(32) }, { id: 'replacement-next', itemId: 'd'.repeat(32) }];
    const first = f.client.submit({ type: 'setQueue', queue, index: 0, positionTicks: 0, paused: false });
    const next = f.client.submit({ type: 'select', queueItemId: 'replacement-next', positionTicks: 0, paused: false });
    f.state({ ...initial(), queue, index: 1, revision: 3, queueRevision: 3, positionTicks: 0, paused: false }, f.sent[1].id, 2);
    await next;
    assert.equal(f.client.getSnapshot().index, 1);
    assert.equal(f.client.getSnapshot().queueRevision, 3);
    f.state({ ...initial(), queue, index: 0, revision: 2, queueRevision: 2, positionTicks: 0, paused: false }, f.sent[0].id, 1);
    await first;
    assert.equal(f.client.getSnapshot().index, 1);
    assert.equal(f.client.getSnapshot().queueRevision, 3);
    f.client.dispose();
});

test('a recreated engine resumes the server command sequence without replaying history', async () => {
    const f = fixture();
    f.transport.snapshot = async () => ({ snapshot: initial(), clientId: 'self', sequence: 25 });
    await f.client.start();
    const pending = f.client.submit({ type: 'setPlayback', paused: false }).catch(() => {});
    assert.equal(f.sent[0].sequence, 26);
    f.client.dispose(); await pending;
});

test('a pending seek for the previous queue cannot seek a newly selected movie', async () => {
    const f = fixture(); await f.client.start();
    const seek = f.client.submit({ type: 'seek', positionTicks: 800_000_000, paused: true });
    const replacement = { ...initial(), revision: 3, queueRevision: 2,
        queue: [{ id: 'new-movie', itemId: 'c'.repeat(32) }], index: 0, positionTicks: 0 };
    f.state(replacement, undefined, 0);
    assert.equal(f.client.getSnapshot().queue[0].id, 'new-movie');
    assert.equal(f.client.getSnapshot().positionTicks, 0);
    f.reject({ id: f.sent[0].id, code: 'activity_queue_changed', snapshot: replacement });
    await assert.rejects(seek);
    f.client.dispose();
});

test('repeat mode changes immediately and invalidates an earlier automatic-end generation', async () => {
    const f = fixture(); await f.client.start();
    const mode = f.client.submit({ type: 'setRepeatMode', repeatMode: 'RepeatOne' });
    assert.equal(f.client.getSnapshot().repeatMode, 'RepeatOne');
    assert.equal(f.client.getSnapshot().queueRevision, 2);
    assert.equal(f.effects.at(-1).metadata.type, 'setRepeatMode');
    f.state({ ...initial(), revision: 2, queueRevision: 2, repeatMode: 'RepeatOne' }, f.sent[0].id, 1);
    await mode;
    const repeat = f.client.submit({ type: 'select', queueItemId: 'queue-first', positionTicks: 0, paused: false }).catch(() => {});
    assert.equal(f.sent[1].expectedQueueRevision, 2);
    assert.equal(f.client.getSnapshot().queueRevision, 3);
    f.client.dispose(); await repeat;
});

test('simultaneous automatic episode endings quietly follow the one accepted advancement', async () => {
    const f = fixture(); await f.client.start();
    const ended = f.client.submit({ type: 'select', queueItemId: 'queue-second', positionTicks: 0, paused: false }, { automatic: true });
    const accepted = { ...initial(), index: 1, revision: 2, queueRevision: 2, positionTicks: 0, paused: false };
    f.reject({ id: f.sent[0].id, code: 'activity_queue_changed', snapshot: accepted });
    await ended;
    assert.equal(f.client.getSnapshot().index, 1);
    assert.equal(f.errors.length, 0);
    assert.equal('automatic' in f.sent[0], false, 'presentation policy does not widen the wire protocol');
    f.client.dispose();
});


test('a pending repeat choice does not count elapsed playback twice after an earlier acknowledgement', async () => {
    const f = fixture();
    f.source({ ...initial(), paused: false });
    await f.client.start();
    const first = f.client.submit({ type: 'setRepeatMode', repeatMode: 'RepeatOne' });
    f.advance(100);
    const second = f.client.submit({ type: 'setRepeatMode', repeatMode: 'RepeatAll' });
    f.advance(700);
    f.state({ ...initial(), revision: 2, queueRevision: 2, repeatMode: 'RepeatOne',
        paused: false, positionTicks: 18_000_000, serverTimeMs: 1800 }, f.sent[0].id, 1);
    await first;
    assert.equal(f.client.getSnapshot().repeatMode, 'RepeatAll');
    assert.equal(f.client.getSnapshot().positionTicks, 18_000_000);
    f.state({ ...initial(), revision: 3, queueRevision: 3, repeatMode: 'RepeatAll',
        paused: false, positionTicks: 18_000_000, serverTimeMs: 1800 }, f.sent[1].id, 2);
    await second;
    f.client.dispose();
});
