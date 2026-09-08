import assert from 'node:assert/strict';
import test from 'node:test';
import { isVideoFullscreen, toggleVideoFullscreen } from '../src/videoFullscreen.js';

test('native controls synchronously fullscreen the document containing video, OSD and subtitles', async () => {
    const root = {};
    const video = { ownerDocument: { documentElement: root } };
    let calls = 0;
    const screenfull = { isEnabled: true, isFullscreen: false, toggle(element, options) {
        calls++;
        assert.equal(element, root);
        assert.deepEqual(options, { navigationUI: 'hide' });
        this.isFullscreen = !this.isFullscreen;
        return Promise.resolve();
    } };
    const result = toggleVideoFullscreen(video, screenfull, assert.fail);
    assert.equal(calls, 1, 'request must run before yielding the click gesture');
    assert.equal(await result, true);
    assert.equal(isVideoFullscreen(video, screenfull), true);
    assert.equal(await toggleVideoFullscreen(video, screenfull, assert.fail), true);
    assert.equal(isVideoFullscreen(video, screenfull), false);
});

test('policy-disabled fullscreen gives feedback without changing playback or claiming fullscreen', async () => {
    const messages = [];
    const video = { paused: false, currentTime: 42 };
    const screenfull = { isEnabled: false, isFullscreen: false, toggle: assert.fail };
    assert.equal(await toggleVideoFullscreen(video, screenfull, value => messages.push(value)), false);
    assert.match(messages[0], /unavailable in this Discord view/);
    assert.equal(messages.length, 1);
    assert.equal(isVideoFullscreen(video, screenfull), false);
    assert.deepEqual(video, { paused: false, currentTime: 42 });
});

test('browser and WebKit synchronous throws and asynchronous rejections settle safely with fixed feedback', async () => {
    for (const synchronous of [false, true]) {
        for (const nativeVideo of [false, true]) {
            const error = new DOMException('secret media URL must never appear', 'NotAllowedError');
            const reject = () => { if (synchronous) throw error; return Promise.reject(error); };
            const messages = [];
            const video = { ownerDocument: { documentElement: {} }, ...(nativeVideo && { webkitEnterFullscreen: reject }) };
            const screenfull = { isEnabled: !nativeVideo, toggle: reject };
            assert.equal(await toggleVideoFullscreen(video, screenfull, value => messages.push(value)), false);
            assert.equal(messages.length, 1);
            assert.match(messages[0], /Fullscreen could not be changed/);
            assert.ok(!messages[0].includes(error.message));
            assert.equal(isVideoFullscreen(video, screenfull), false);
        }
    }
});

test('iPhone native fullscreen enters and exits on the exact active video and reads its actual state', async () => {
    const video = { webkitDisplayingFullscreen: false, webkitEnterFullscreen() { this.webkitDisplayingFullscreen = true; },
        webkitExitFullscreen() { this.webkitDisplayingFullscreen = false; } };
    const screenfull = { isEnabled: false, isFullscreen: false };
    const result = toggleVideoFullscreen(video, screenfull, assert.fail);
    assert.equal(video.webkitDisplayingFullscreen, true, 'video call retains the click gesture');
    assert.equal(await result, true);
    assert.equal(isVideoFullscreen(video, screenfull), true);
    assert.equal(await toggleVideoFullscreen(video, screenfull, assert.fail), true);
    assert.equal(isVideoFullscreen(video, screenfull), false);
});

test('Safari presentation-mode fallback handles native exit and never mistakes PiP for fullscreen', async () => {
    const modes = [];
    const video = { webkitPresentationMode: 'inline', webkitSupportsPresentationMode: mode => mode === 'fullscreen',
        webkitSetPresentationMode(mode) { modes.push(mode); this.webkitPresentationMode = mode; } };
    const screenfull = { isEnabled: false };
    assert.equal(await toggleVideoFullscreen(video, screenfull, assert.fail), true);
    assert.equal(isVideoFullscreen(video, screenfull), true);
    assert.equal(await toggleVideoFullscreen(video, screenfull, assert.fail), true);
    assert.deepEqual(modes, ['fullscreen', 'inline']);
    video.webkitPresentationMode = 'picture-in-picture';
    assert.equal(isVideoFullscreen(video, screenfull), false);
});

test('an unavailable native-video API and a missing active video cannot claim success', async () => {
    let notices = 0;
    const video = { webkitSupportsFullscreen: false, webkitEnterFullscreen: assert.fail,
        webkitSupportsPresentationMode: () => false, webkitSetPresentationMode: assert.fail };
    assert.equal(await toggleVideoFullscreen(video, {}, () => { notices++; }), false);
    assert.equal(await toggleVideoFullscreen(null, {}, assert.fail), false);
    assert.equal(notices, 1);
});
