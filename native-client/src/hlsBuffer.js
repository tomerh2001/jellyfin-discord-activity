// This is an encoded forward-buffer estimate, not a browser-memory limit:
// decoded frames, muxing overhead and whole HLS fragments can exceed it.
const FORWARD_BUFFER_BYTES = 96_000_000;
const MAX_BUFFER_SECONDS = 30;
const MIN_BUFFER_SECONDS = 6;

const positive = value => Number.isFinite(value) && value > 0 ? value : undefined;

/** Use the selected media version, never the viewer's quality ceiling. */
export function sourceBitrate(mediaSource) {
    if (positive(mediaSource?.Bitrate)) return mediaSource.Bitrate;
    const streams = mediaSource?.MediaStreams?.filter(stream => stream.Type === 'Video' || stream.Type === 'Audio') || [];
    const rates = streams.map(stream => positive(stream.BitRate));
    return rates.length && rates.every(Boolean) ? rates.reduce((sum, rate) => sum + rate, 0) : undefined;
}

export function hlsBufferConfig(bitrate) {
    const seconds = positive(bitrate)
        ? Math.max(MIN_BUFFER_SECONDS, Math.min(MAX_BUFFER_SECONDS, FORWARD_BUFFER_BYTES * 8 / bitrate))
        : MAX_BUFFER_SECONDS;
    return {
        maxBufferLength: seconds,
        // hls.js otherwise treats maxBufferSize as a minimum and can extend the
        // buffer beyond maxBufferLength, particularly at low output bitrates.
        maxMaxBufferLength: seconds,
        maxBufferSize: FORWARD_BUFFER_BYTES,
        // Retaining an entire movie behind playback defeats a bounded policy.
        backBufferLength: seconds
    };
}

/** Refine the source estimate using encoded output, including video transcodes. */
export function observeHlsBuffer(hls, events) {
    const samples = [];
    let lastPolicyLimit = hls.config.maxMaxBufferLength;
    let engineLimit = Infinity;
    const loaded = (_event, data) => {
        const fragment = data?.frag;
        if (data?.part || fragment?.type !== 'main' || !positive(fragment.duration)) return;
        const bytes = positive(data.payload?.byteLength) || positive(fragment.stats?.loaded);
        if (!bytes) return;
        const bitrate = bytes * 8 / fragment.duration;
        if (!positive(bitrate)) return;
        samples.push(bitrate);
        if (samples.length > 3) samples.shift();
        // Keep recent large VBR fragments in the estimate instead of oscillating
        // to a long target whenever a small fragment arrives.
        // HLS lowers its own ceiling after quota/buffer-full errors. Keep that
        // per-player safety reduction when a later fragment updates our estimate.
        const currentLimit = hls.config.maxMaxBufferLength;
        if (positive(currentLimit) && currentLimit < lastPolicyLimit) engineLimit = Math.min(engineLimit, currentLimit);
        const config = hlsBufferConfig(Math.max(...samples));
        config.maxMaxBufferLength = Math.min(config.maxMaxBufferLength, engineLimit);
        config.maxBufferLength = Math.min(config.maxBufferLength, engineLimit);
        config.backBufferLength = Math.min(config.backBufferLength, engineLimit);
        Object.assign(hls.config, config);
        lastPolicyLimit = config.maxMaxBufferLength;
    };
    const destroyed = () => {
        hls.off(events.FRAG_LOADED, loaded);
        hls.off(events.DESTROYING, destroyed);
        samples.length = 0;
    };
    hls.on(events.FRAG_LOADED, loaded);
    hls.on(events.DESTROYING, destroyed);
}
