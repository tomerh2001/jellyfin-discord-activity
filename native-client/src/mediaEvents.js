/** Native playbackstart means preparation, not successful media playback. */
export function observeMediaPlaying(document, isMediaElement, onPlaying) {
    const receive = event => {
        const media = event.target;
        if (isMediaElement(media) && !media.classList.contains('testMediaPlayerAudio')) onPlaying(media);
    };
    // HTMLMediaElement.playing does not bubble; capture it from native players.
    document.addEventListener('playing', receive, true);
    return () => document.removeEventListener('playing', receive, true);
}
