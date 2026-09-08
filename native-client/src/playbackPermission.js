export const PLAYBACK_BLOCKED_EVENT = 'jellyfin-watch-playback-blocked';

/**
 * WebKit grants playback permission to the actual media element. Playing a
 * throwaway silent audio element does not unlock a video created later.
 */
export function installPlaybackPermission(host, getLastCommand, mountButton) {
    let blockedMedia;
    let generation = 0;
    // Jellyfin uses the v0 customized-built-in polyfill. Its createElement
    // overload expects a string, so v1 { is } options throw before player setup.
    const holder = host.document.createElement('div');
    holder.innerHTML = '<button is="emby-button" type="button" class="discordPlaybackPermission raised button-submit block"></button>';
    const button = holder.firstElementChild;
    let dismiss;
    const remove = () => { dismiss?.(); dismiss = undefined; button.remove(); };
    const show = () => {
        if (button.isConnected) return;
        if (mountButton) dismiss = mountButton(button);
        else host.document.body.appendChild(button);
    };
    button.textContent = 'Tap to play on this device';

    const blocked = event => {
        const media = event.target;
        if (!(media instanceof host.HTMLMediaElement) || media.classList.contains('testMediaPlayerAudio')) return;
        generation++;
        blockedMedia = media;
        button.disabled = false;
        button.textContent = 'Tap to play on this device';
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
            remove();
        }).catch(() => {
            if (attempt !== generation) return;
            if (blockedMedia && blockedMedia !== media) return;
            blockedMedia = media;
            button.disabled = false;
            button.textContent = 'Tap again to play on this device';
            if (media.isConnected) show();
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
        remove();
        blockedMedia = undefined;
    };
}
