import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { patchHlsBuffer, patchHlsRecovery } from '../hlsBufferPatch.mjs';
import { hlsBufferConfig, sourceBitrate, observeHlsBuffer } from '../src/hlsBuffer.js';

async function upstreamFile(file) {
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    return execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/${file}`], { encoding: 'utf8' });
}

test('patched native player uses actual source buffering independently of a high quality ceiling', async () => {
    const original = await upstreamFile('src/plugins/htmlVideoPlayer/plugin.js');
    const source = patchHlsBuffer(original);
    const start = source.indexOf('    setSrcWithHlsJs(elem, options, url) {');
    const end = source.indexOf('\n    /**', start);
    const handlers = new Map();
    let instance;
    class Hls {
        static Events = { FRAG_LOADED: 'loaded', DESTROYING: 'destroying' };
        constructor(config) { this.config = config; instance = this; }
        on(event, handler) { handlers.set(event, handler); }
        off(event) { handlers.delete(event); }
        loadSource(url) { assert.equal(url, '/fixture.m3u8'); assert.ok(handlers.has('loaded')); }
        attachMedia() {}
    }
    const dependencies = { Hls, hlsBufferConfig, sourceBitrate, observeHlsBuffer,
        requireHlsPlayer: callback => callback(), getIncludeCorsCredentials: async () => false,
        bindEventsToHlsPlayer: (_player, _hls, _elem, _onError, resolve) => resolve(),
        playbackManager: { getMaxStreamingBitrate: () => 140_000_000 }, browser: { chrome: true } };
    const Player = new Function(...Object.keys(dependencies),
        `return class Player { #currentSrc; ${source.slice(start, end)} };`)(...Object.values(dependencies));
    await new Player().setSrcWithHlsJs({}, { mediaSource: { Bitrate: 18_000_000 }, playerStartPositionTicks: 0 }, '/fixture.m3u8');
    assert.equal(instance.config.maxBufferLength, 30);
    assert.equal(instance.config.maxMaxBufferLength, 30);
    assert.equal(instance.config.maxBufferSize, 96_000_000);
    handlers.get('loaded')('loaded', { frag: { type: 'main', duration: 4 }, payload: { byteLength: 60_000_000 } });
    assert.equal(instance.config.maxBufferLength, 6.4, 'actual high-rate output tightens the target');
    assert.throws(() => patchHlsBuffer(source), /patch anchor changed/);
    assert.throws(() => patchHlsBuffer(original.replace('let maxBufferLength = 30;', 'let maxBufferLength = 40;')), /patch anchor changed/);
});

test('transient segment server failures keep bounded HLS retries; terminal failures still destroy playback', async () => {
    const original = await upstreamFile('src/components/htmlMediaHelper.js');
    const source = patchHlsRecovery(original);
    const start = source.indexOf('export function bindEventsToHlsPlayer(');
    const end = source.indexOf('\nexport function ', start + 1);
    const Hls = { Events: { MANIFEST_PARSED: 'manifest', ERROR: 'error' },
        ErrorTypes: { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' },
        ErrorDetails: { FRAG_LOAD_ERROR: 'fragLoadError' } };
    const bind = new Function('Hls', 'MediaError', 'console', 'playWithPromise', 'onErrorInternal', 'handleHlsJsMediaError',
        source.slice(start, end).replace('export function ', 'function ') + '\nreturn bindEventsToHlsPlayer;')(
        Hls, { SERVER_ERROR: 'server' }, { debug() {}, error() {} }, async () => {}, assert.fail, assert.fail);
    for (const [code, details, fatal, shouldDestroy] of [
        [502, 'fragLoadError', false, false], [503, 'fragLoadError', false, false],
        [502, 'fragLoadError', true, true], [401, 'fragLoadError', false, true],
        [403, 'fragLoadError', false, true], [404, 'fragLoadError', false, true],
        [502, 'manifestLoadError', false, true]
    ]) {
        const handlers = new Map(); let destroyed = 0; let rejected = 0;
        const hls = { on: (event, fn) => handlers.set(event, fn), destroy: () => destroyed++,
            startLoad: () => assert.fail('must not add a manual retry loop') };
        bind({}, hls, {}, () => {}, () => {}, () => rejected++);
        handlers.get('error')('error', { type: 'network', details, fatal, response: { code } });
        assert.equal(destroyed, Number(shouldDestroy), `${code}/${details}/fatal=${fatal}`);
        assert.equal(rejected, Number(shouldDestroy));
    }
    assert.throws(() => patchHlsRecovery(source), /patch anchor changed/);
});
