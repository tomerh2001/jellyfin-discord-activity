import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const asset = new URL('../dist/libraries/hls.worker.js', import.meta.url);

test('shipped HLS worker initializes without webpack module globals', {
    skip: !existsSync(new URL('../dist/index.html', import.meta.url)) && 'Build the native client first'
}, () => {
    const listeners = new Map();
    const messages = [];
    const self = {
        addEventListener: (name, callback) => listeners.set(name, callback),
        postMessage: value => messages.push(value)
    };
    // The former blob factory referenced an outer webpack variable immediately.
    // Execute the shipped worker in an isolated worker-like global to catch that
    // failure, then require the native HLS initialization acknowledgement.
    vm.runInNewContext(readFileSync(asset, 'utf8'), {
        self, console, performance, setTimeout, clearTimeout, TextDecoder, TextEncoder
    }, { timeout: 1000 });
    assert.equal(typeof listeners.get('message'), 'function');
    listeners.get('message')({ data: {
        cmd: 'init', instanceNo: 0, id: 'main', typeSupported: { mpeg: true, mp3: true },
        config: JSON.stringify({ debug: false, enableSoftwareAES: true })
    } });
    assert.deepEqual(messages.map(message => message.event), ['init']);
    assert.ok(readFileSync(new URL('../dist/HLS-LICENSE.txt', import.meta.url), 'utf8').includes('Apache License'));
});
