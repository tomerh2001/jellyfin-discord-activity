const text = value => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512)
    : '';
const number = (value, max = Number.MAX_SAFE_INTEGER) => Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
const index = value => Number.isSafeInteger(value) ? number(value, 100000) : undefined;

/** Deliberately exclude identifiers, server addresses, paths, artwork and tokens. */
export function watchPresenceSnapshot(item, state, media, waiting = false) {
    const title = text(item?.Name);
    if (!title) return null;
    const kind = item.Type === 'Episode' ? 'episode' : item.Type === 'Movie' ? 'movie' : item.MediaType === 'Audio' ? 'audio' : 'video';
    const durationMs = number(state?.NowPlayingItem?.RunTimeTicks / 10000) ?? number(item.RunTimeTicks / 10000) ?? number(media.duration * 1000) ?? 0;
    const rawPosition = number(state?.PlayState?.PositionTicks / 10000) ?? number(media.currentTime * 1000) ?? 0;
    const paused = Boolean(media.paused);
    const result = { kind, title, positionMs: Math.min(rawPosition, durationMs || rawPosition), durationMs,
        paused, buffering: !paused && (waiting || media.readyState < 3),
        playbackRate: number(media.playbackRate, 16) || 1 };
    const year = index(item.ProductionYear);
    if (year !== undefined && year <= 9999) result.year = year;
    if (kind === 'episode') {
        const series = text(item.SeriesName);
        if (series) result.seriesName = series;
        for (const [field, key] of [['ParentIndexNumber', 'seasonNumber'], ['IndexNumber', 'episodeNumber'], ['IndexNumberEnd', 'episodeEndNumber']]) {
            const value = index(item[field]);
            if (value !== undefined) result[key] = value;
        }
    }
    return result;
}

/** Read the native local player only; this observer never requests server data. */
export function observeWatchPresence({ document, playbackManager, events, publisher, isCurrent,
    setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
    let active;
    let played;
    let waiting = false;
    let disposed = false;
    const mediaEvents = ['playing', 'pause', 'waiting', 'stalled', 'seeked', 'seeking', 'ratechange', 'ended', 'emptied', 'error'];

    function publish(method, value) {
        try { Promise.resolve(publisher[method](value)).catch(() => {}); }
        catch { /* Presence must never interrupt native playback. */ }
    }

    function clear() {
        if (disposed) return;
        played = undefined;
        active = undefined;
        waiting = false;
        publish('clear');
    }

    function current() {
        if (disposed) return null;
        try {
            if (!isCurrent()) return null;
            const player = playbackManager.getCurrentPlayer();
            if (!player?.isLocalPlayer) return null;
            const item = playbackManager.currentItem(player);
            if (!item?.Id) return null;
            const selector = item.MediaType === 'Audio' ? 'audio.mediaPlayerAudio' : 'video.htmlvideoplayer';
            const media = document.querySelector(selector);
            if (!media?.isConnected || media.classList.contains('testMediaPlayerAudio')) return null;
            const source = playbackManager.currentMediaSource(player);
            return { player, media, item, source: media.currentSrc || media.src, key: `${item.ServerId || ''}:${item.Id}:${source?.Id || ''}:${media.currentSrc || media.src}` };
        } catch { return null; }
    }

    function matches(left, right) {
        return left && right && left.player === right.player && left.media === right.media && left.key === right.key;
    }

    function refresh(hydrate = false) {
        if (disposed) return;
        const value = current();
        // When attaching to an already-playing local element, its played ranges
        // establish actual prior playback. Preparatory events cannot establish it.
        if (hydrate && value && !value.media.ended && value.media.played.length > 0) {
            played = { media: value.media, source: value.source, key: value.key };
        }
        if (value && played?.media === value.media && played.source === value.source
            && (!played.key || played.key === value.key)) {
            played.key = value.key;
            active = value;
        }
        if (!matches(active, value) || value.media.ended) { clear(); return; }
        try {
            const snapshot = watchPresenceSnapshot(value.item, playbackManager.getPlayerState(value.player), value.media, waiting);
            if (snapshot) publish('update', snapshot);
            else clear();
        } catch { clear(); }
    }

    function receive(event) {
        if (disposed) return;
        const value = current();
        if (event.type === 'playing' && event.target.matches?.('video.htmlvideoplayer, audio.mediaPlayerAudio')
            && !event.target.classList.contains('testMediaPlayerAudio') && isCurrent()) {
            // Native play() can resolve before playbackManager installs its player.
            // Retain this element's proof until the following metadata event.
            played = { media: event.target, source: event.target.currentSrc || event.target.src,
                key: value?.media === event.target ? value.key : undefined };
            if (!value || value.media !== event.target) {
                active = undefined; waiting = false; publish('clear'); return;
            }
        }
        if (!value) { clear(); return; }
        if (event.target !== value.media) return;
        if (['ended', 'emptied', 'error'].includes(event.type)) { clear(); return; }
        if (event.type === 'playing') { active = value; waiting = false; }
        else if (!matches(active, value)) { clear(); return; }
        else if (event.type === 'waiting' || event.type === 'stalled' || event.type === 'seeking') waiting = true;
        else if (event.type === 'pause' || event.type === 'seeked') waiting = false;
        refresh();
    }

    function preparing() { refresh(); }
    function stopped(_event, info) {
        if (!info?.player || !active || info.player === active.player) clear();
    }
    function changed() { refresh(); }
    for (const event of mediaEvents) document.addEventListener(event, receive, true);
    events.on(playbackManager, 'playbackstart', preparing);
    events.on(playbackManager, 'playbackstop', stopped);
    events.on(playbackManager, 'playerchange', changed);
    const timer = setInterval(() => refresh(), 15000);
    refresh(true);
    return {
        clear,
        refresh: () => refresh(true),
        dispose() {
            if (disposed) return;
            clear();
            disposed = true;
            clearInterval(timer);
            for (const event of mediaEvents) document.removeEventListener(event, receive, true);
            events.off(playbackManager, 'playbackstart', preparing);
            events.off(playbackManager, 'playbackstop', stopped);
            events.off(playbackManager, 'playerchange', changed);
            publish('dispose');
        }
    };
}
