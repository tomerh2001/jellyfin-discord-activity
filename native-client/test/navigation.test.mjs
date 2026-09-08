import assert from 'node:assert/strict';
import test from 'node:test';
import { observeNavigation, restoredNavigation } from '../src/navigation.js';

const normalize = route => typeof route === 'string' && /^#\/(home|search|details)(\?|$)/.test(route) ? route : null;
function fixture() {
    const host = new EventTarget();
    host.document = new EventTarget();
    host.location = { hash: '#/home' };
    let tick;
    host.setInterval = callback => { tick = callback; return 1; };
    host.clearInterval = () => { tick = undefined; };
    return { host, tick: () => tick?.() };
}

test('native pushState navigation checkpoints without hashchange and renews while watching', () => {
    const f = fixture();
    const saves = [];
    const navigation = observeNavigation(f.host, normalize, (...args) => saves.push(args));
    f.host.location.hash = '#/details?id=fixture';
    f.host.document.dispatchEvent(new Event('viewshow'));
    // OSD is restored by native SyncPlay, never by replaying a client command.
    f.host.location.hash = '#/videoosd';
    f.host.document.dispatchEvent(new Event('viewshow'));
    f.tick();
    navigation.flush(true);
    assert.equal(navigation.route, '#/details?id=fixture');
    assert.deepEqual(saves, [
        ['#/home', 1, false],
        ['#/details?id=fixture', 2, true],
        ['#/details?id=fixture', 3, true],
        ['#/details?id=fixture', 4, false],
        ['#/details?id=fixture', 5, true]
    ]);
    navigation.dispose();
});

test('account replacement and Leave stop old checkpoint writes, including queued callbacks', async () => {
    const f = fixture();
    let writes = 0;
    const navigation = observeNavigation(f.host, normalize, () => { writes++; return Promise.reject(new Error('Unavailable')); });
    await Promise.resolve();
    navigation.dispose();
    f.host.location.hash = '#/search';
    f.host.dispatchEvent(new Event('hashchange'));
    f.host.document.dispatchEvent(new Event('viewshow'));
    f.tick(); navigation.flush(true); navigation.dispose();
    assert.equal(writes, 1);
});

test('new documents recover browsing while explicit account changes start on that account Home', () => {
    const input = { sameAccount: false, currentRoute: '#/search', restoreRoute: '#/details?id=fixture', initialHash: '#/videoosd', ready: false };
    assert.equal(restoredNavigation(normalize, input), '#/details?id=fixture');
    assert.equal(restoredNavigation(normalize, { ...input, restoreRoute: null, initialHash: '#/search' }), '#/search');
    assert.equal(restoredNavigation(normalize, { ...input, ready: true }), '#/home');
    assert.equal(restoredNavigation(normalize, { ...input, sameAccount: true, ready: true }), '#/search');
    assert.equal(restoredNavigation(normalize, { ...input, restoreRoute: 'https://example.test', initialHash: '#/login' }), '#/home');
});
