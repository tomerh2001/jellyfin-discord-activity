import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNEL, validLaunch, waitForParent, observePresentation } from '../src/bridge.js';

const launch = { baseUrl: '/jf/opaque-capability', accessToken: 'opaque-capability', userId: 'user', serverId: 'server', deviceId: 'device', groupId: 'group' };
function fakeHost() {
    const events = new Map();
    const sent = [];
    const parent = { postMessage: (...args) => sent.push(args) };
    return { parent, sent, location: { origin: 'https://activity.test' }, crypto: { randomUUID: () => 'unique-child-nonce' },
        setTimeout, clearTimeout, addEventListener: (name, fn) => events.set(name, fn),
        removeEventListener: name => events.delete(name), dispatch: event => events.get('message')?.(event), events };
}

test('bootstrap ignores another frame, origin and nonce before accepting its own parent', async () => {
    const host = fakeHost();
    const promise = waitForParent(host);
    const data = { channel: CHANNEL, type: 'bootstrap', nonce: 'unique-child-nonce', launch };
    const event = { source: host.parent, origin: host.location.origin, data };
    let resolved = false;
    promise.then(() => { resolved = true; });
    host.dispatch({ ...event, source: {} });
    host.dispatch({ ...event, origin: 'https://untrusted.test' });
    host.dispatch({ ...event, data: { ...data, nonce: 'old-frame-nonce' } });
    await Promise.resolve();
    assert.equal(resolved, false);
    host.dispatch(event);
    assert.equal((await promise).groupId, 'group');
    assert.equal(host.events.has('message'), false);
    assert.deepEqual(host.sent[0], [{ channel: CHANNEL, type: 'ready', nonce: 'unique-child-nonce' }, host.location.origin]);
});

test('parent cannot bootstrap a remote or escaped gateway address', async () => {
    for (const baseUrl of ['https://other.test/jf/cap', '//other.test/jf/cap', '/jf/cap/../../api', '/jf/cap?token=secret']) {
        assert.equal(validLaunch({ ...launch, baseUrl }, 'https://activity.test'), false);
    }
    const host = fakeHost();
    const promise = waitForParent(host);
    host.dispatch({ source: host.parent, origin: host.location.origin, data: { channel: CHANNEL, type: 'bootstrap', nonce: 'unique-child-nonce', launch: { ...launch, baseUrl: 'https://other.test' } } });
    await assert.rejects(promise, /Invalid Jellyfin connection/);
    assert.equal(host.events.size, 0);
});

test('a missing parent response times out and removes the listener', async () => {
    const host = fakeHost();
    await assert.rejects(waitForParent(host, 5), /timed out/);
    assert.equal(host.events.size, 0);
});

test('presentation updates require this parent, origin, nonce and a valid layout', () => {
    const host = fakeHost(); const received = [];
    const stop = observePresentation(host, 'unique-child-nonce', value => received.push(value));
    const data = { channel: CHANNEL, type: 'presentation', nonce: 'unique-child-nonce', presentation: { layout: 'pip', preview: true } };
    const event = { source: host.parent, origin: host.location.origin, data };
    host.dispatch({ ...event, source: {} }); host.dispatch({ ...event, origin: 'https://untrusted.test' });
    host.dispatch({ ...event, data: { ...data, nonce: 'old-frame-nonce' } });
    host.dispatch({ ...event, data: { ...data, presentation: { layout: 'fullscreen', preview: true } } });
    host.dispatch({ ...event, data: { ...data, presentation: { layout: 'pip', preview: 'true' } } });
    assert.deepEqual(received, []);
    host.dispatch(event); assert.deepEqual(received, [data.presentation]);
    stop(); assert.equal(host.events.size, 0);
});
