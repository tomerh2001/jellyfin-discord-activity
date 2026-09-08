import assert from 'node:assert/strict';
import test from 'node:test';
import { observeMediaPlaying } from '../src/mediaEvents.js';

test('playback preparation and permission-test audio never hide the media unlock control', () => {
    const listeners = new Map();
    const document = {
        addEventListener: (event, callback, capture) => { assert.equal(capture, true); listeners.set(event, callback); },
        removeEventListener: (event, callback, capture) => { assert.equal(capture, true); assert.equal(listeners.get(event), callback); listeners.delete(event); }
    };
    let playing = 0;
    const stop = observeMediaPlaying(document, value => value?.media === true, () => playing++);
    const realMedia = { media: true, classList: { contains: () => false } };
    listeners.get('playbackstart')?.({ target: realMedia });
    listeners.get('play')?.({ target: realMedia });
    listeners.get('playing')({ target: { media: false } });
    listeners.get('playing')({ target: { media: true, classList: { contains: name => name === 'testMediaPlayerAudio' } } });
    assert.equal(playing, 0);
    listeners.get('playing')({ target: realMedia });
    assert.equal(playing, 1);
    stop();
    assert.equal(listeners.size, 0);
});
