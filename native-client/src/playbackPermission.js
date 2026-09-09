export const PLAYBACK_BLOCKED_EVENT = 'jellyfin-watch-playback-blocked';

/** WebKit authorizes the actual media element from the native MUI click. */
export function installPlaybackPermission(host, getLastCommand, mountPermission) {
    let blockedMedia;
    let generation = 0;
    let permission;
    const remove = () => { permission?.close(); permission = undefined; };
    const show = (label = 'Tap to play on this device') => {
        if (permission) permission.update({ label, disabled: false });
        else permission = mountPermission({ label, disabled: false, onActivate: click });
    };
    const blocked = event => {
        const media = event.target;
        if (!(media instanceof host.HTMLMediaElement) || media.classList.contains('testMediaPlayerAudio')) return;
        generation++;
        blockedMedia = media;
        show();
    };
    const playing = event => {
        if (event.target === blockedMedia) {
            blockedMedia = undefined;
            remove();
        }
    };
    const click = () => {
        const media = blockedMedia;
        const attempt = generation;
        if (!media?.isConnected) { remove(); blockedMedia = undefined; return; }
        // No await, render, audio probe, RPC or server request precedes play().
        // Unlocking a viewer must never unpause the watch party for everyone.
        let promise;
        try { promise = media.play(); }
        catch { show('Tap again to play on this device'); return; }
        permission?.update({ disabled: true });
        void Promise.resolve(promise).then(() => {
            if (attempt !== generation) return;
            const command = getLastCommand();
            if (command?.Command === 'Pause' || command?.Command === 'Stop') media.pause();
            if (blockedMedia === media) blockedMedia = undefined;
            remove();
        }).catch(() => {
            if (attempt !== generation) return;
            if (blockedMedia && blockedMedia !== media) return;
            blockedMedia = media;
            if (media.isConnected) show('Tap again to play on this device');
            else { remove(); blockedMedia = undefined; }
        });
    };
    host.document.addEventListener(PLAYBACK_BLOCKED_EVENT, blocked, true);
    host.document.addEventListener('playing', playing, true);
    return () => {
        generation++;
        host.document.removeEventListener(PLAYBACK_BLOCKED_EVENT, blocked, true);
        host.document.removeEventListener('playing', playing, true);
        remove();
        blockedMedia = undefined;
    };
}
