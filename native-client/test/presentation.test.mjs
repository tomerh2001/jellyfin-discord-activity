import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPresentation, observeVideoPresentation } from '../src/presentation.js';

test('actual video playback enters presentation; pause/buffering/layout changes retain it; unload/stop resets it', () => {
    const listeners = new Map();
    const document = {
        documentElement: { dataset: {} },
        addEventListener: (name, listener, capture) => { assert.equal(capture, true); listeners.set(name, listener); },
        removeEventListener: (name, listener) => { assert.equal(listeners.get(name), listener); listeners.delete(name); }
    };
    const states = [];
    const observer = observeVideoPresentation(document, value => value?.tagName === 'VIDEO', value => states.push(value));
    const video = { tagName: 'VIDEO' };
    const dispatch = (name, target) => listeners.get(name)?.({ target });
    dispatch('playing', { tagName: 'AUDIO' }); dispatch('play', video);
    assert.deepEqual(states, []);
    dispatch('playing', video); dispatch('playing', video);
    dispatch('pause', video); dispatch('waiting', video); dispatch('stalled', video);
    applyPresentation(document, { layout: 'pip', preview: true });
    assert.deepEqual(states, [true]);
    assert.deepEqual(document.documentElement.dataset, { discordVideo: 'true', discordLayout: 'pip', discordPreview: 'true' });
    dispatch('emptied', { tagName: 'VIDEO' });
    assert.deepEqual(states, [true]);
    dispatch('emptied', video);
    assert.deepEqual(states, [true, false]);
    dispatch('playing', video); observer.stop(); observer.stop();
    assert.deepEqual(states, [true, false, true, false]);
    observer.dispose(); assert.equal(listeners.size, 0);
});
