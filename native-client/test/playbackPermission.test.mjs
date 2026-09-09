import assert from 'node:assert/strict';
import test from 'node:test';
import { installPlaybackPermission, PLAYBACK_BLOCKED_EVENT } from '../src/playbackPermission.js';

function fixture(command) {
    const listeners = new Map();
    const state = { visible: false };
    class Media {
        isConnected = true;
        classList = { contains: () => false };
        plays = 0;
        pauses = 0;
        play() { this.plays++; return Promise.resolve(); }
        pause() { this.pauses++; }
    }
    const document = { addEventListener: (type, handler) => listeners.set(type, handler),
        removeEventListener: type => listeners.delete(type) };
    const mount = options => {
        Object.assign(state, options, { visible: true });
        return { update: patch => Object.assign(state, patch), close: () => { state.visible = false; } };
    };
    const dispose = installPlaybackPermission({ document, HTMLMediaElement: Media }, () => command, mount);
    return { Media, state, listeners, dispose, click: () => state.onActivate(),
        block: media => listeners.get(PLAYBACK_BLOCKED_EVENT)({ target: media }),
        playing: media => listeners.get('playing')({ target: media }),
        emptied: media => listeners.get('emptied')({ target: media }) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('autoplay rejection offers a direct gesture on the actual video before rendering pending state', async () => {
    const f = fixture({ Command: 'Unpause' }); const video = new f.Media();
    assert.equal(f.state.visible, false); f.block(video); assert.equal(f.state.visible, true);
    video.play = () => { assert.equal(f.state.disabled, false); video.plays++; return Promise.resolve(); };
    f.click(); assert.equal(video.plays, 1); assert.equal(f.state.disabled, true);
    await flush(); assert.equal(video.pauses, 0); assert.equal(f.state.visible, false);
    f.dispose(); assert.equal(f.listeners.size, 0);
});

for (const Command of ['Pause', 'Stop']) test(`unlocking a ${Command} group preserves the local pause without a group command`, async () => {
    const f = fixture({ Command }); const video = new f.Media();
    f.block(video); f.click(); await flush(); assert.equal(video.pauses, 1); f.dispose();
});

test('rejected and thrown play failures stay actionable and a new episode can request its own gesture', async () => {
    const f = fixture({ Command: 'Unpause' }); const video = new f.Media();
    video.play = () => Promise.reject(new Error('NotAllowedError'));
    f.block(video); f.click(); await flush();
    assert.equal(f.state.disabled, false); assert.equal(f.state.visible, true); assert.match(f.state.label, /again/);
    video.play = () => { throw new Error('NotAllowedError'); }; f.click();
    assert.equal(f.state.disabled, false); assert.equal(f.state.visible, true);
    const nextVideo = new f.Media(); f.block(nextVideo); f.click(); assert.equal(nextVideo.plays, 1);
    await flush(); assert.equal(f.state.visible, false); f.dispose();
});

test('detached media and permission-probe audio never leave an unusable playback button', async () => {
    const f = fixture(); const audio = new f.Media(); audio.classList.contains = () => true;
    f.block(audio); assert.equal(f.state.visible, false);
    const video = new f.Media(); f.block(video); video.isConnected = false; f.click();
    assert.equal(video.plays, 0); assert.equal(f.state.visible, false);
    let rejectPlay; video.isConnected = true;
    video.play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
    f.block(video); f.click(); video.isConnected = false; rejectPlay(new Error('Detached')); await flush();
    assert.equal(f.state.visible, false); f.dispose();
});

test('late success and rejection from an older episode do not close or alter the current episode prompt', async () => {
    for (const reject of [false, true]) {
        const f = fixture({ Command: 'Pause' }); const first = new f.Media(); let settle;
        first.play = () => new Promise((resolve, fail) => { settle = reject ? () => fail(new Error('old')) : resolve; });
        f.block(first); f.click();
        const next = new f.Media(); f.block(next); settle(); await flush();
        assert.equal(f.state.visible, true); assert.equal(f.state.disabled, false); assert.equal(first.pauses, 0);
        f.click(); assert.equal(next.plays, 1); await flush(); assert.equal(next.pauses, 1); f.dispose();
    }
});

test('playing events dismiss only the matching media and disposal invalidates pending promises', async () => {
    const f = fixture(); const video = new f.Media(); let resolvePlay;
    video.play = () => new Promise(resolve => { resolvePlay = resolve; });
    f.block(video); f.playing(new f.Media()); assert.equal(f.state.visible, true);
    f.click(); f.dispose(); resolvePlay(); await flush();
    assert.equal(f.state.visible, false); assert.equal(video.pauses, 0); assert.equal(f.listeners.size, 0);
    const next = fixture(); const playing = new next.Media(); next.block(playing); next.playing(playing);
    assert.equal(next.state.visible, false); next.dispose();
});


test('unloading a still-connected blocked video closes the modal and invalidates late play completion', async () => {
    for (const reject of [false, true]) {
        const f = fixture({ Command: 'Pause' }); const video = new f.Media(); let settle;
        video.play = () => new Promise((resolve, fail) => { settle = reject ? () => fail(new Error('source unloaded')) : resolve; });
        f.block(video); f.click();
        f.emptied(new f.Media()); assert.equal(f.state.visible, true);
        f.emptied(video); assert.equal(video.isConnected, true); assert.equal(f.state.visible, false);
        settle(); await flush();
        assert.equal(f.state.visible, false); assert.equal(video.pauses, 0); f.dispose();
    }
});


test('explicit Stop reset invalidates a detached video request but keeps listeners for the next title', async () => {
    const f = fixture({ Command: 'Unpause' }); const video = new f.Media(); let rejectPlay;
    video.play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
    f.block(video); f.click(); video.isConnected = false;
    f.dispose.reset(); assert.equal(f.state.visible, false); assert.equal(f.listeners.size, 4);
    rejectPlay(new Error('stopped')); await flush(); assert.equal(f.state.visible, false);
    const next = new f.Media(); f.block(next); f.click(); assert.equal(next.plays, 1);
    await flush(); assert.equal(f.state.visible, false); f.dispose(); assert.equal(f.listeners.size, 0);
});
