import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { onDocumentExit } from '../src/lifecycle.js';
import { observeMediaPlaying } from '../src/mediaEvents.js';
import { observeVideoPresentation } from '../src/presentation.js';
import { installPlaybackPermission, PLAYBACK_BLOCKED_EVENT } from '../src/playbackPermission.js';

// Use the workspace's existing DOM test dependency, with no browser/network calls.
const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');

test('SPA viewhide/pagehide preserves playback listeners and bfcache; real document exit disposes once', () => {
    const { window } = new JSDOM('<body><div class="page"></div><video></video></body>');
    try {
        const document = window.document;
        const view = document.querySelector('.page');
        const video = document.querySelector('video');
        const states = [];
        let playing = 0;
        let cleanups = 0;
        const mediaCleanup = observeMediaPlaying(document, value => value instanceof window.HTMLMediaElement, () => playing++);
        const presentation = observeVideoPresentation(document, value => value instanceof window.HTMLVideoElement, state => states.push(state));
        let permission;
        const permissionCleanup = installPlaybackPermission(window, () => ({ Command: 'Unpause' }), options => {
            permission = { ...options };
            return { update: patch => Object.assign(permission, patch), close: () => { permission = undefined; } };
        });
        for (const cleanup of [mediaCleanup, presentation.dispose, permissionCleanup]) {
            onDocumentExit(window, () => { cleanups++; cleanup(); });
        }
        // viewManager dispatches viewhide and its mapped, bubbling pagehide from
        // the outgoing DIV on ordinary Home -> details -> playback navigation.
        for (let navigation = 0; navigation < 3; navigation++) {
            view.dispatchEvent(new window.CustomEvent('viewhide', { bubbles: true }));
            view.dispatchEvent(new window.CustomEvent('pagehide', { bubbles: true }));
        }
        window.dispatchEvent(new window.CustomEvent('pagehide'));
        window.dispatchEvent(new window.Event('pagehide'));
        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(cleanups, 0);
        video.dispatchEvent(new window.Event(PLAYBACK_BLOCKED_EVENT, { bubbles: true }));
        assert.equal(permission?.label, 'Tap to play on this device');
        video.dispatchEvent(new window.Event('playing'));
        assert.equal(playing, 1);
        assert.deepEqual(states, [true]);
        assert.equal(permission, undefined);

        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false }));
        assert.equal(cleanups, 3);
        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false }));
        video.dispatchEvent(new window.Event(PLAYBACK_BLOCKED_EVENT, { bubbles: true }));
        video.dispatchEvent(new window.Event('playing'));
        assert.equal(cleanups, 3);
        assert.equal(playing, 1);
        assert.equal(permission, undefined);
    } finally { window.close(); }
});
