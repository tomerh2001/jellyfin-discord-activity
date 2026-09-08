const MAX_SHEETS = 2;
const RETRY_DELAY = 2000;
const LOAD_TIMEOUT = 15000;

export function seekPreviewTile(info, ticks) {
    const fields = ['Width', 'Height', 'TileWidth', 'TileHeight', 'ThumbnailCount', 'Interval'];
    if (!info || fields.some(key => !Number.isSafeInteger(info[key]) || info[key] <= 0)) return null;
    const tile = Math.min(info.ThumbnailCount - 1, Math.max(0, Math.floor((Number.isFinite(ticks) ? ticks : 0) / 10000 / info.Interval)));
    const perSheet = info.TileWidth * info.TileHeight;
    const local = tile % perSheet;
    return { sheet: Math.floor(tile / perSheet), x: local % info.TileWidth * info.Width, y: Math.floor(local / info.TileWidth) * info.Height };
}

/** One native player owns at most two decoded sheets, never persistent storage. */
export function createSeekPreview({ document, formatTime, Image = globalThis.Image,
    origin = globalThis.location.origin, now = Date.now,
    setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
    const sheets = new Map();
    let source;
    let latest;
    let generation = 0;

    function release(entry) {
        entry.cancelled = true;
        clearTimeout(entry.timer);
        entry.image.onload = null;
        entry.image.onerror = null;
        entry.image.removeAttribute('src');
        entry.image.remove();
    }

    function clear() {
        generation++;
        if (latest) latest.bubble.replaceChildren();
        latest = undefined;
        source = undefined;
        for (const entry of sheets.values()) release(entry);
        sheets.clear();
    }

    function select(options, ticks) {
        const tile = seekPreviewTile(options.info, ticks);
        let base;
        try {
            base = new URL(options.apiClient.getUrl(`Videos/${options.item.Id}/Trickplay/${options.info.Width}/0.jpg`, {
                MediaSourceId: options.mediaSourceId
            }), origin);
        } catch { clear(); return null; }
        if (!tile || base.origin !== origin || !/^\/jf\/[A-Za-z0-9_-]+\/Videos\/[a-f0-9-]{32,36}\/Trickplay\/\d+\/0\.jpg$/i.test(base.pathname)) {
            clear();
            return null;
        }
        const key = `${base.href}|${JSON.stringify(options.info)}`;
        if (source?.key !== key || source?.apiClient !== options.apiClient) {
            clear();
            source = { ...options, key, base };
        }
        return tile;
    }

    function timestamp(bubble, ticks) {
        let text = bubble.querySelector('h1.sliderBubbleText');
        if (!text) {
            text = document.createElement('h1');
            text.className = 'sliderBubbleText';
            bubble.replaceChildren(text);
        }
        text.textContent = formatTime(ticks);
    }

    function render(entry) {
        if (!latest || !source || entry.cancelled || entry.state !== 'ready' || latest.tile.sheet !== entry.index) return;
        const { bubble, ticks, tile, item } = latest;
        const info = source.info;
        // A resized or incomplete sprite cannot safely use native pixel offsets.
        if (tile.x + info.Width > entry.image.naturalWidth || tile.y + info.Height > entry.image.naturalHeight) {
            timestamp(bubble, ticks);
            return;
        }
        let container = bubble.querySelector('.chapterThumbContainer');
        if (!container?.querySelector('.chapterThumbWrapper') || !container.querySelector('h2.chapterThumbText') || !container.querySelector('div.chapterThumbText')) {
            container = document.createElement('div');
            container.className = 'chapterThumbContainer';
            const wrapper = document.createElement('div');
            wrapper.className = 'chapterThumbWrapper';
            wrapper.style.overflow = 'hidden';
            wrapper.style.width = `${info.Width}px`;
            wrapper.style.height = `${info.Height}px`;
            const labels = document.createElement('div');
            labels.className = 'chapterThumbTextContainer';
            const name = document.createElement('div');
            name.className = 'chapterThumbText chapterThumbText-dim';
            const time = document.createElement('h2');
            time.className = 'chapterThumbText';
            labels.append(name, time);
            container.append(wrapper, labels);
            bubble.replaceChildren(container);
        }
        const wrapper = container.querySelector('.chapterThumbWrapper');
        const image = entry.image;
        image.alt = '';
        image.draggable = false;
        image.style.display = 'block';
        image.style.maxWidth = 'none';
        image.style.width = `${image.naturalWidth}px`;
        image.style.height = `${image.naturalHeight}px`;
        image.style.transform = `translate(${-tile.x}px, ${-tile.y}px)`;
        if (image.parentNode !== wrapper) wrapper.replaceChildren(image);
        let chapter;
        for (const current of item.Chapters || []) {
            if (ticks < current.StartPositionTicks) break;
            chapter = current;
        }
        container.querySelector('div.chapterThumbText').textContent = chapter?.Name || '';
        container.querySelector('h2.chapterThumbText').textContent = formatTime(ticks);
        // Native slider positioning ran while this was only a timestamp. A
        // stationary pointer needs the same edge clamp after asynchronous decode.
        const track = bubble.parentElement;
        const left = parseFloat(bubble.style.left);
        if (track?.classList.contains('sliderBubbleTrack') && Number.isFinite(left)) {
            const width = track.getBoundingClientRect().width;
            const half = Math.min(bubble.getBoundingClientRect().width, width) / 2;
            if (width) bubble.style.left = `${Math.min(Math.max(left, half), width - half)}px`;
        }
    }

    function load(index) {
        let entry = sheets.get(index);
        if (entry) {
            sheets.delete(index);
            sheets.set(index, entry);
            if (entry.state !== 'failed' || now() < entry.retryAt) return entry;
            release(entry);
            sheets.delete(index);
        }
        while (sheets.size >= MAX_SHEETS) {
            const oldest = sheets.keys().next().value;
            release(sheets.get(oldest));
            sheets.delete(oldest);
        }
        const image = new Image();
        entry = { image, index, state: 'loading', cancelled: false, retryAt: 0 };
        sheets.set(index, entry);
        const expected = generation;
        const current = () => expected === generation && !entry.cancelled && sheets.get(index) === entry;
        const failed = () => {
            if (!current() || entry.state !== 'loading') return;
            clearTimeout(entry.timer);
            image.onload = null;
            image.onerror = null;
            entry.state = 'failed';
            entry.retryAt = now() + RETRY_DELAY;
            image.removeAttribute('src');
            if (latest?.tile.sheet === index) timestamp(latest.bubble, latest.ticks);
        };
        image.onerror = failed;
        image.onload = async () => {
            try {
                if (typeof image.decode === 'function') await image.decode();
                if (!current() || entry.state !== 'loading') return;
                if (!image.naturalWidth || !image.naturalHeight) { failed(); return; }
                clearTimeout(entry.timer);
                image.onload = null;
                image.onerror = null;
                entry.state = 'ready';
                render(entry);
            } catch { failed(); }
        };
        entry.timer = setTimeout(failed, LOAD_TIMEOUT);
        const url = new URL(source.base.href);
        url.pathname = url.pathname.replace(/0\.jpg$/, `${index}.jpg`);
        image.src = url.href;
        return entry;
    }

    return {
        prepare(options, ticks = 0) {
            const tile = select(options, ticks);
            if (tile) load(tile.sheet);
        },
        update(bubble, options, ticks) {
            const tile = select(options, ticks);
            if (!tile) return false;
            latest = { bubble, ticks, tile, item: options.item };
            const entry = load(tile.sheet);
            if (entry.state === 'ready') render(entry);
            else timestamp(bubble, ticks);
            return true;
        },
        clear
    };
}
