// Called directly by the native player's button, F shortcut and double-click.
// Keep the request synchronous: awaiting an import or SDK command first can
// consume the user gesture required by browser and native video fullscreen.
export function isVideoFullscreen(video, screenfull) {
    return Boolean(screenfull.isFullscreen || video?.webkitDisplayingFullscreen
        || video?.webkitPresentationMode === 'fullscreen');
}

export function toggleVideoFullscreen(video, screenfull, notify) {
    if (!video) return Promise.resolve(false);
    const unavailable = () => {
        notify('Fullscreen is unavailable in this Discord view. Use Discord’s fullscreen control if available.');
        return false;
    };
    const failed = () => {
        // Never include a browser error's message or a media URL in the UI.
        notify('Fullscreen could not be changed. Try again, or use Discord’s fullscreen control if available.');
        return false;
    };
    try {
        let result;
        if (video.webkitDisplayingFullscreen || video.webkitPresentationMode === 'fullscreen') {
            if (typeof video.webkitExitFullscreen === 'function') result = video.webkitExitFullscreen();
            else if (typeof video.webkitSetPresentationMode === 'function') result = video.webkitSetPresentationMode('inline');
            else return Promise.resolve(unavailable());
        } else if (screenfull.isEnabled) {
            // Fullscreen the native document so Jellyfin's OSD and subtitle
            // overlays remain visible alongside the video.
            result = screenfull.toggle(video.ownerDocument.documentElement, { navigationUI: 'hide' });
        } else if (typeof video.webkitEnterFullscreen === 'function' && video.webkitSupportsFullscreen !== false) {
            // iPhone WebKit exposes video fullscreen separately from document
            // fullscreen. The active player's video owns its state and events.
            result = video.webkitEnterFullscreen();
        } else if (typeof video.webkitSetPresentationMode === 'function'
            && video.webkitSupportsPresentationMode?.('fullscreen')) {
            result = video.webkitSetPresentationMode('fullscreen');
        } else {
            return Promise.resolve(unavailable());
        }
        // Native callers do not consume a rejection; handle both asynchronous
        // browser refusals and synchronous WebKit errors here.
        return Promise.resolve(result).then(() => true, failed);
    } catch {
        return Promise.resolve(failed());
    }
}
