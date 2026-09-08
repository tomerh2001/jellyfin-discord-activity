import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const bootstrap = readFileSync(new URL('../src/storage.js', import.meta.url), 'utf8');
function deniedStorageFrame() {
    let reads = 0;
    const window = {};
    for (const name of ['localStorage', 'sessionStorage', 'caches']) {
        Object.defineProperty(window, name, { configurable: true, get() { reads++; throw new Error('SecurityError: storage denied'); } });
    }
    vm.runInNewContext(bootstrap, { window });
    return { window, reads: () => reads };
}

test('bootstrap replaces denied getters without reading persistent storage or opening caches', () => {
    const { window, reads } = deniedStorageFrame();
    assert.equal(reads(), 0);
    assert.equal(window.caches, undefined);
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.sessionStorage.length, 0);
});

test('native settings support Storage methods, named properties and independent document lifetimes', () => {
    const { window } = deniedStorageFrame();
    const local = window.localStorage;
    local.setItem('volume', 60);
    local.layout = 'mobile';
    assert.equal(local.getItem('volume'), '60');
    assert.equal(local.layout, 'mobile');
    assert.equal(local.length, 2);
    assert.equal(local.key(0), 'volume');
    assert.equal(local.key(100), null);
    assert.deepEqual(Object.keys(local), ['volume', 'layout']);
    assert.equal('layout' in local, true);
    delete local.layout;
    local.removeItem('volume');
    assert.equal(local.getItem('volume'), null);
    local.setItem('gateway', 'ephemeral-capability');
    assert.equal(window.sessionStorage.getItem('gateway'), null);
    assert.equal(deniedStorageFrame().window.localStorage.getItem('gateway'), null);
    local.clear();
    assert.equal(local.length, 0);
});

test('built document executes the unchanged classic storage bootstrap before native bundles', {
    skip: !existsSync(new URL('../dist/index.html', import.meta.url)) && 'Build the native client first'
}, () => {
    const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
    const firstScript = html.match(/<script\b[^>]*>/i)?.[0];
    assert.equal(firstScript, '<script src="/activity-storage.js">');
    assert.match(html, /<script src="\/activity-storage\.js"><\/script><script src="\/activity-session\.js"><\/script>/);
    assert.equal(/<iframe\b/i.test(html), false, 'The native document must not embed another app frame');
    assert.equal(readFileSync(new URL('../dist/activity-storage.js', import.meta.url), 'utf8'), bootstrap);
    const window = {};
    vm.runInNewContext(readFileSync(new URL('../dist/activity-storage.js', import.meta.url), 'utf8'), { window });
    assert.equal(window.localStorage.getItem('servers'), null);
    assert.equal(window.caches, undefined);
});
