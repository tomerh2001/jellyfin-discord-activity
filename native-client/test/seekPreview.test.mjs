import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createSeekPreview, seekPreviewTile } from '../src/seekPreview.js';
import { patchNativeSeekPreview } from '../seekPreviewPatch.mjs';

const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');
const ITEM = '11111111111111111111111111111111';
const info = { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, ThumbnailCount: 138, Interval: 10000 };
const ticks = seconds => seconds * 10000000;
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
    const { window } = new JSDOM('<body><div class="sliderBubble"></div></body>', { url: 'https://activity.test' });
    const document = window.document;
    const images = [];
    const timers = new Map();
    let clock = 0;
    let timer = 0;
    let cap = 'fixture-capability';
    const options = { info, item: { Id: ITEM, Chapters: [{ Name: '<img>native chapter', StartPositionTicks: 0 }] }, mediaSourceId: 'fixture-source',
        apiClient: { getUrl: (path, query) => `https://activity.test/jf/${cap}/${path}?${new URLSearchParams(query)}` } };
    const preview = createSeekPreview({ document, origin: window.location.origin, formatTime: value => `${value / 10000000}s`, now: () => clock,
        setTimeout: callback => { const id = ++timer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
        Image: function () {
            const image = document.createElement('img');
            image.decode = async () => {};
            images.push(image);
            return image;
        } });
    const bubble = document.querySelector('.sliderBubble');
    return { window, document, images, timers, options, preview, bubble,
        advance: ms => { clock += ms; }, capability: value => { cap = value; },
        update: seconds => preview.update(bubble, options, ticks(seconds)),
        async loaded(image = images.at(-1), width = 3200, height = 1800) {
            Object.defineProperties(image, { naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height } });
            await image.onload?.();
        },
        close() { preview.clear(); window.close(); }
    };
}

test('native sprite positions clamp to the final actual thumbnail, including rounded runtime and invalid metadata', () => {
    assert.deepEqual(seekPreviewTile(info, ticks(473)), { sheet: 0, x: 2240, y: 720 });
    assert.deepEqual(seekPreviewTile(info, ticks(1380)), { sheet: 1, x: 2240, y: 540 });
    assert.deepEqual(seekPreviewTile(info, ticks(99999)), seekPreviewTile(info, ticks(1380)));
    for (const value of [-1, NaN, undefined]) assert.deepEqual(seekPreviewTile(info, value), { sheet: 0, x: 0, y: 0 });
    for (const invalid of [null, {}, { ...info, Interval: 0 }, { ...info, Width: NaN }, { ...info, ThumbnailCount: -1 }]) {
        assert.equal(seekPreviewTile(invalid, 0), null);
    }
});

test('preload and hover share one decoded image node; native timestamp remains visible until that node is ready', async () => {
    const f = fixture();
    try {
        f.preview.prepare(f.options, ticks(473));
        assert.equal(f.images.length, 1);
        const url = new URL(f.images[0].src);
        assert.equal(url.pathname, `/jf/fixture-capability/Videos/${ITEM}/Trickplay/320/0.jpg`);
        assert.deepEqual([...url.searchParams], [['MediaSourceId', 'fixture-source']]);
        assert.equal(f.update(473), true);
        assert.equal(f.images.length, 1);
        assert.equal(f.bubble.textContent, '473s');
        assert.equal(f.bubble.querySelector('.chapterThumbContainer'), null);
        await f.loaded();
        assert.equal(f.bubble.querySelector('.chapterThumbWrapper img'), f.images[0]);
        assert.equal(f.images[0].style.transform, 'translate(-2240px, -720px)');
        assert.equal(f.bubble.querySelector('div.chapterThumbText').textContent, '<img>native chapter');
        assert.equal(f.bubble.querySelectorAll('img').length, 1, 'chapter label remains text');
        assert.equal(f.timers.size, 0);
        f.update(480);
        assert.equal(f.images.length, 1);
        assert.equal(f.images[0].style.transform, 'translate(-2560px, -720px)');
    } finally { f.close(); }
});

test('failed and timed-out sheets wait for a later hover and a short backoff, then recover', async () => {
    const f = fixture();
    try {
        f.update(473);
        f.images[0].onerror();
        assert.equal(f.bubble.textContent, '473s');
        assert.equal(f.timers.size, 0, 'no automatic retry timer');
        f.update(474); f.advance(1999); f.update(475);
        assert.equal(f.images.length, 1);
        f.advance(1); f.update(476);
        assert.equal(f.images.length, 2);
        [...f.timers.values()][0]();
        assert.equal(f.bubble.textContent, '476s');
        assert.equal(f.timers.size, 0);
        f.advance(2000); f.update(477);
        assert.equal(f.images.length, 3);
        await f.loaded();
        assert.equal(f.bubble.querySelector('.chapterThumbWrapper img'), f.images[2]);
    } finally { f.close(); }
});

test('decode failure preserves the timestamp and can recover without reopening playback', async () => {
    const f = fixture();
    try {
        f.update(7);
        f.images[0].decode = async () => { throw new Error('invalid image'); };
        await f.loaded();
        assert.equal(f.bubble.textContent, '7s');
        assert.equal(f.timers.size, 0);
        f.advance(2000); f.update(8); await f.loaded();
        assert.equal(f.bubble.querySelector('.chapterThumbWrapper img'), f.images[1]);
    } finally { f.close(); }
});

test('a chapter-only native bubble can be replaced by a decoded trickplay preview', async () => {
    const f = fixture();
    try {
        f.preview.prepare(f.options, 0);
        await f.loaded();
        f.bubble.innerHTML = '<div class="chapterThumbContainer"><img class="chapterThumb"><div class="chapterThumbTextContainer"><h2 class="chapterThumbText">old chapter</h2></div></div>';
        f.update(473);
        assert.equal(f.bubble.querySelector('.chapterThumbWrapper img'), f.images[0]);
        assert.equal(f.bubble.querySelector('img.chapterThumb'), null);
        assert.equal(f.bubble.querySelector('h2').textContent, '473s');
    } finally { f.close(); }
});

test('a resized sprite cannot show an empty crop at native pixel coordinates', async () => {
    const f = fixture();
    try {
        f.update(473);
        await f.loaded(f.images[0], 320, 180);
        assert.equal(f.bubble.textContent, '473s');
        assert.equal(f.bubble.querySelector('.chapterThumbContainer'), null);
    } finally { f.close(); }
});

test('a stationary hover is reclamped to the native track after the decoded image widens its timestamp', async () => {
    for (const [left, expected] of [[22, 160], [980, 840]]) {
        const f = fixture();
        try {
            const track = f.document.createElement('div');
            track.className = 'sliderBubbleTrack';
            f.document.body.append(track); track.append(f.bubble);
            track.getBoundingClientRect = () => ({ width: 1000 });
            f.bubble.getBoundingClientRect = () => ({ width: f.bubble.querySelector('img') ? 320 : 44 });
            f.bubble.style.left = `${left}px`;
            f.update(7);
            assert.equal(f.bubble.style.left, `${left}px`);
            await f.loaded();
            assert.equal(f.bubble.style.left, `${expected}px`);
        } finally { f.close(); }
    }
});

test('late image decoding cannot overwrite a new item, media source, capability, or released player', async () => {
    for (const change of ['item', 'source', 'capability', 'client', 'release']) {
        const f = fixture();
        try {
            f.update(473);
            let finish;
            f.images[0].decode = () => new Promise(resolve => { finish = resolve; });
            const pending = f.loaded(f.images[0]);
            if (change === 'item') f.options.item = { ...f.options.item, Id: '22222222222222222222222222222222' };
            if (change === 'source') f.options.mediaSourceId = 'new-source';
            if (change === 'capability') f.capability('new-capability');
            if (change === 'client') f.options.apiClient = { ...f.options.apiClient };
            if (change === 'release') f.preview.clear();
            else f.update(7);
            finish(); await pending; await flush();
            assert.equal(f.bubble.querySelector('.chapterThumbContainer'), null, change);
            assert.equal(f.images[0].hasAttribute('src'), false, change);
            if (change !== 'release') {
                assert.equal(f.bubble.textContent, '7s');
                await f.loaded();
                assert.equal(f.bubble.querySelector('img'), f.images[1]);
            }
        } finally { f.close(); }
    }
});

test('the cache retains at most two sheets and displays the latest hover when loading completes', async () => {
    const f = fixture();
    try {
        f.options.info = { ...info, ThumbnailCount: 350 };
        f.update(7); f.update(473); await f.loaded();
        assert.equal(f.bubble.querySelector('h2').textContent, '473s');
        f.update(1050); await f.loaded();
        f.update(7);
        assert.equal(f.images.length, 2, 'returning to decoded sheet does not refetch');
        f.update(2050); await f.loaded();
        assert.equal(f.images[1].hasAttribute('src'), false, 'least recently used sheet was released');
        assert.equal(f.images.filter(image => image.hasAttribute('src')).length, 2);
        f.update(1050);
        assert.equal(f.images.length, 4);
        f.preview.clear();
        assert.equal(f.images.filter(image => image.hasAttribute('src')).length, 0);
        assert.equal(f.timers.size, 0);
    } finally { f.close(); }
});

test('missing trickplay falls through to native chapter previews and image requests stay on the capability gateway', async () => {
    const f = fixture();
    try {
        f.options.info = null;
        assert.equal(f.update(7), false);
        assert.equal(f.images.length, 0);
        f.options.info = info;
        for (const url of ['https://other.test/jf/cap/Videos/'+ITEM+'/Trickplay/320/0.jpg', 'https://activity.test/not-a-gateway']) {
            f.options.apiClient = { getUrl: () => url };
            assert.equal(f.update(7), false);
        }
        assert.equal(f.images.length, 0);
    } finally { f.close(); }
});

test('pinned source uses the helper, prepares and clears it with playback, and preserves native chapter fallback', async () => {
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    const original = execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/src/controllers/playback/video/index.js`], { encoding: 'utf8' });
    const patched = patchNativeSeekPreview(original);
    assert.ok(patched.includes('seekPreview.update(bubble'));
    assert.ok(patched.includes('seekPreview.prepare('));
    assert.equal(patched.match(/seekPreview.clear\(\)/g).length, 3);
    const fallback = value => value.match(/    function getImgUrl\([\s\S]*?(?=\n    let playPauseClickTimeout)/)[0];
    assert.equal(fallback(patched), fallback(original));
    assert.throws(() => patchNativeSeekPreview(patched), /renderer changed/);
    assert.throws(() => patchNativeSeekPreview(original.replace('        const tileSize =', '        const changedTileSize =')), /renderer changed/);
});
