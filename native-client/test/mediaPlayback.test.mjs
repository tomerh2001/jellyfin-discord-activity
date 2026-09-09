import assert from 'node:assert/strict';
import test from 'node:test';
import { patchVideoUnpause } from '../videoPlaybackPatch.mjs';
import { playWithGestureRecovery } from '../src/mediaPlayback.js';
import { PLAYBACK_BLOCKED_EVENT } from '../src/playbackPermission.js';

// The unmodified method from pinned Jellyfin Web 12.0.0. The release build
// requires this exact method/import anchor in the verified upstream archive.
const upstreamMethod = `import Screenfull from 'screenfull';
class Player {
    #mediaElement;
    constructor(media) { this.#mediaElement = media; }
    unpause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.play();
        }
    }
}`;

function createPlayer(media) {
    const prepared = patchVideoUnpause(upstreamMethod).replace(/^import .*;$/gm, '');
    const Player = new Function('playWithGestureRecovery', `${prepared}\nreturn Player;`)(playWithGestureRecovery);
    return new Player(media);
}

function fakeMedia(play) {
    const events = [];
    return { play, events, ownerDocument: { defaultView: { Event } }, dispatchEvent: event => { events.push(event); } };
}

test('patched native unpause calls actual media synchronously and preserves successful playback', async () => {
    let calls = 0;
    const media = fakeMedia(() => { calls++; return Promise.resolve(); });
    const result = createPlayer(media).unpause();
    assert.equal(calls, 1);
    await result;
    assert.deepEqual(media.events, []);
});

test('patched native unpause reports asynchronous and synchronous gesture blocks on that exact media', async () => {
    for (const name of ['NotAllowedError', 'AbortError']) {
        for (const synchronous of [false, true]) {
            const error = new DOMException('Playback blocked', name);
            const media = fakeMedia(() => { if (synchronous) throw error; return Promise.reject(error); });
            await createPlayer(media).unpause();
            assert.equal(media.events.length, 1);
            assert.equal(media.events[0].type, PLAYBACK_BLOCKED_EVENT);
            assert.equal(media.events[0].bubbles, true);
        }
    }
});

test('unrelated playback errors retain their original rejection and do not show a permission prompt', async () => {
    const error = new DOMException('Codec unavailable', 'NotSupportedError');
    const media = fakeMedia(() => Promise.reject(error));
    await assert.rejects(createPlayer(media).unpause(), value => value === error);
    assert.deepEqual(media.events, []);
});

test('release patch refuses a changed, duplicated or already-patched upstream method', () => {
    assert.throws(() => patchVideoUnpause(upstreamMethod.replace('mediaElement.play();', 'return mediaElement.play();')), /anchor changed/);
    assert.throws(() => patchVideoUnpause(upstreamMethod + upstreamMethod), /anchor changed/);
    assert.throws(() => patchVideoUnpause(patchVideoUnpause(upstreamMethod)), /anchor changed/);
});
