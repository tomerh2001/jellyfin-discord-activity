/** Keep the same media element when Discord resizes or moves the Activity. */
export function applyPresentation(document, presentation) {
    document.documentElement.dataset.discordLayout = presentation.layout;
    document.documentElement.dataset.discordPreview = String(presentation.preview);
}

/** Pausing or buffering keeps the picture on screen. Only unloading/stopping it ends video mode. */
export function observeVideoPresentation(document, isVideoElement, update) {
    let current;
    const report = active => {
        document.documentElement.dataset.discordVideo = String(active);
        update(active);
    };
    const playing = event => {
        if (!isVideoElement(event.target) || event.target === current) return;
        current = event.target;
        report(true);
    };
    const emptied = event => { if (event.target === current) stop(); };
    const stop = () => {
        if (!current) return;
        current = undefined;
        report(false);
    };
    document.addEventListener('playing', playing, true);
    document.addEventListener('emptied', emptied, true);
    return {
        stop,
        dispose: () => {
            document.removeEventListener('playing', playing, true);
            document.removeEventListener('emptied', emptied, true);
        }
    };
}
