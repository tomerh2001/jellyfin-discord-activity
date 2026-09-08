export const PLAYBACK_BLOCKED_EVENT = 'jellyfin-watch-playback-blocked';

/**
 * WebKit grants playback permission to the actual media element. Playing a
 * throwaway silent audio element does not unlock a video created later.
 */
export function installPlaybackPermission(host, getLastCommand) {
    let blockedMedia;
    let generation = 0;
    const button = host.document.createElement('button');
    button.type = 'button';
    button.className = 'discordPlaybackPermission';
    button.textContent = 'Tap to play on this device';

    const blocked = event => {
        const media = event.target;
        if (!(media instanceof host.HTMLMediaElement) || media.classList.contains('testMediaPlayerAudio')) return;
        generation++;
        blockedMedia = media;
        button.disabled = false;
        button.textContent = 'Tap to play on this device';
        if (!button.isConnected) host.document.body.appendChild(button);
    };
    const playing = event => {
        if (event.target === blockedMedia) {
            blockedMedia = undefined;
            button.remove();
        }
    };
    const click = () => {
        const media = blockedMedia;
        const attempt = generation;
        if (!media?.isConnected) { button.remove(); blockedMedia = undefined; return; }
        // No await, audio probe, RPC or server request may precede this call.
        // Keep the native SyncPlay clock in charge; unlocking a paused viewer
        // must never send an Unpause command to everyone else.
        let promise;
        try { promise = media.play(); }
        catch { button.textContent = 'Tap again to play on this device'; return; }
        button.disabled = true;
        void Promise.resolve(promise).then(() => {
            if (attempt !== generation) return;
            const command = getLastCommand();
            if (command?.Command === 'Pause' || command?.Command === 'Stop') media.pause();
            if (blockedMedia === media) blockedMedia = undefined;
            button.remove();
        }).catch(() => {
            if (attempt !== generation) return;
            if (blockedMedia && blockedMedia !== media) return;
            blockedMedia = media;
            button.disabled = false;
            button.textContent = 'Tap again to play on this device';
            if (media.isConnected && !button.isConnected) host.document.body.appendChild(button);
        });
    };
    button.addEventListener('click', click);
    host.document.addEventListener(PLAYBACK_BLOCKED_EVENT, blocked, true);
    host.document.addEventListener('playing', playing, true);
    return () => {
        generation++;
        host.document.removeEventListener(PLAYBACK_BLOCKED_EVENT, blocked, true);
        host.document.removeEventListener('playing', playing, true);
        button.removeEventListener('click', click);
        button.remove();
        blockedMedia = undefined;
    };
}
