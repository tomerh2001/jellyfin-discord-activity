import assert from 'node:assert/strict';
import test from 'node:test';
import { installPlaybackPermission, PLAYBACK_BLOCKED_EVENT } from '../src/playbackPermission.js';

function fixture(command) {
    const listeners = new Map();
    let click;
    const button = { isConnected: false, disabled: false, textContent: '',
        addEventListener: (_event, handler) => { click = handler; }, removeEventListener: () => {},
        remove() { this.isConnected = false; } };
    class Media {
        isConnected = true;
        classList = { contains: () => false };
        plays = 0;
        pauses = 0;
        play() { this.plays++; return Promise.resolve(); }
        pause() { this.pauses++; }
    }
    const document = { createElement: () => button, body: { appendChild: element => { element.isConnected = true; } },
        addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener: type => listeners.delete(type) };
    const dispose = installPlaybackPermission({ document, HTMLMediaElement: Media }, () => command);
    return { Media, button, listeners, dispose, click: () => click(), block: media => listeners.get(PLAYBACK_BLOCKED_EVENT)({ target: media }) };
}

test('an autoplay rejection offers a direct gesture on the actual video, without an audio probe', async () => {
    const f = fixture({ Command: 'Unpause' });
    const video = new f.Media();
    assert.equal(f.button.isConnected, false);
    f.block(video);
    assert.equal(f.button.isConnected, true);
    f.click();
    assert.equal(video.plays, 1, 'play must run in the click call stack, before any promise');
    await Promise.resolve();
    assert.equal(video.pauses, 0);
    assert.equal(f.button.isConnected, false);
    f.dispose();
    assert.equal(f.listeners.size, 0);
});

test('unlocking a paused group preserves its local pause and never calls a group command', async () => {
    const f = fixture({ Command: 'Pause' });
    const video = new f.Media();
    f.block(video); f.click();
    await Promise.resolve();
    assert.equal(video.pauses, 1);
});

test('another rejected play stays actionable and a new episode can request its own gesture', async () => {
    const f = fixture({ Command: 'Unpause' });
    const video = new f.Media();
    video.play = () => Promise.reject(new Error('NotAllowedError'));
    f.block(video); f.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.button.disabled, false);
    assert.equal(f.button.isConnected, true);
    const nextVideo = new f.Media();
    f.block(nextVideo); f.click();
    assert.equal(nextVideo.plays, 1);
    await Promise.resolve();
    assert.equal(f.button.isConnected, false);
});

test('detached media and permission-probe audio never leave a dead playback button', () => {
    const f = fixture();
    const audio = new f.Media();
    audio.classList.contains = () => true;
    f.block(audio);
    assert.equal(f.button.isConnected, false);
    const video = new f.Media();
    f.block(video); video.isConnected = false; f.click();
    assert.equal(video.plays, 0);
    assert.equal(f.button.isConnected, false);
});
