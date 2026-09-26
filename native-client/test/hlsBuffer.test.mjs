import assert from 'node:assert/strict';
import test from 'node:test';
import { hlsBufferConfig, sourceBitrate, observeHlsBuffer } from '../src/hlsBuffer.js';

const events = { FRAG_LOADED: 'loaded', DESTROYING: 'destroying' };
function fixture(rate) {
    const handlers = new Map();
    const hls = { config: hlsBufferConfig(rate),
        on: (event, handler) => handlers.set(event, handler),
        off: (event, handler) => { if (handlers.get(event) === handler) handlers.delete(event); } };
    observeHlsBuffer(hls, events);
    return { hls, handlers, load: data => handlers.get(events.FRAG_LOADED)?.(events.FRAG_LOADED, data) };
}
const fragment = rate => ({ frag: { type: 'main', duration: 4 }, payload: { byteLength: rate / 8 * 4 } });

test('moderate sources retain media across thirteen seconds without delivery', () => {
    for (const rate of [14_000_000, 18_000_000]) {
        const config = hlsBufferConfig(rate);
        let remaining = config.maxMaxBufferLength;
        for (let second = 0; second < 13; second++) remaining--;
        assert.equal(remaining, 17);
        assert.equal(config.maxBufferLength, config.maxMaxBufferLength);
    }
});
test('high-rate sources reduce duration within the encoded forward budget', () => {
    for (const rate of [40_000_000, 80_000_000, 120_000_000]) {
        const config = hlsBufferConfig(rate);
        assert.ok(config.maxBufferLength >= 6 && config.maxBufferLength < 30);
        assert.ok(config.maxBufferLength * rate / 8 <= config.maxBufferSize);
        assert.equal(config.maxMaxBufferLength, config.maxBufferLength);
        assert.equal(config.backBufferLength, config.maxBufferLength);
    }
    assert.equal(hlsBufferConfig(200_000_000).maxBufferLength, 6, 'extreme rates retain a usable fragment window');
});
test('unknown or invalid bitrate retains a bounded thirty-second default', () => {
    for (const rate of [undefined, null, NaN, Infinity, -1, 0, '18000000']) {
        assert.equal(hlsBufferConfig(rate).maxMaxBufferLength, 30);
        assert.equal(hlsBufferConfig(rate).backBufferLength, 30);
    }
});
test('selected media version metadata is preferred, with complete stream fallback', () => {
    assert.equal(sourceBitrate({ Bitrate: 18_000_000 }), 18_000_000);
    assert.equal(sourceBitrate({ MediaStreams: [
        { Type: 'Video', BitRate: 17_000_000 }, { Type: 'Audio', BitRate: 384_000 }, { Type: 'Subtitle' }
    ] }), 17_384_000);
    assert.equal(sourceBitrate({ MediaStreams: [{ Type: 'Video' }, { Type: 'Audio', BitRate: 384_000 }] }), undefined);
    assert.equal(sourceBitrate({}), undefined);
});
test('measured transcode output replaces a conservative high source estimate', () => {
    const f = fixture(120_000_000);
    assert.ok(f.hls.config.maxBufferLength < 7);
    f.load(fragment(18_000_000));
    assert.equal(f.hls.config.maxBufferLength, 30);
    assert.equal(f.hls.config.maxMaxBufferLength, 30);
});
test('recent VBR peaks keep the estimate conservative until replaced by three lower samples', () => {
    const f = fixture();
    f.load(fragment(120_000_000));
    f.load(fragment(14_000_000));
    f.load(fragment(18_000_000));
    assert.ok(f.hls.config.maxBufferLength < 7);
    f.load(fragment(16_000_000));
    assert.equal(f.hls.config.maxBufferLength, 30);
});
test('invalid or non-main fragments are ignored and destruction removes observers', () => {
    const f = fixture(120_000_000);
    const initial = { ...f.hls.config };
    for (const data of [undefined, {}, { ...fragment(1), frag: { type: 'audio', duration: 4 } },
        { ...fragment(1), frag: { type: 'main', duration: 0 } }, { ...fragment(1), payload: { byteLength: NaN } }]) f.load(data);
    assert.deepEqual(f.hls.config, initial);
    f.handlers.get(events.DESTROYING)();
    assert.equal(f.handlers.size, 0);
    f.load(fragment(14_000_000));
    assert.deepEqual(f.hls.config, initial);
});

test('completed fragment statistics survive a transferred payload and partial fragments are excluded', () => {
    const f = fixture(120_000_000);
    f.load({ ...fragment(14_000_000), part: { duration: 1 } });
    assert.ok(f.hls.config.maxBufferLength < 7);
    f.load({ frag: { type: 'main', duration: 4, stats: { loaded: 9_000_000 } }, payload: { byteLength: 0 } });
    assert.equal(f.hls.config.maxBufferLength, 30);
});

test('fragment estimates preserve HLS quota reductions for the lifetime of the player', () => {
    const f = fixture(18_000_000);
    f.hls.config.maxMaxBufferLength = 10;
    f.load(fragment(18_000_000));
    assert.equal(f.hls.config.maxMaxBufferLength, 10);
    assert.equal(f.hls.config.maxBufferLength, 10);
    // Our own high-rate limit may shrink further without erasing the engine cap.
    f.load(fragment(120_000_000));
    assert.equal(f.hls.config.maxMaxBufferLength, 6.4);
    for (let i = 0; i < 3; i++) f.load(fragment(14_000_000));
    assert.equal(f.hls.config.maxMaxBufferLength, 10);
    f.hls.config.maxMaxBufferLength = 5;
    f.load(fragment(14_000_000));
    assert.equal(f.hls.config.maxMaxBufferLength, 5);
    assert.equal(f.hls.config.backBufferLength, 5);
});
