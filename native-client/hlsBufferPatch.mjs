const bufferAnchor = `                let maxBufferLength = 30;

                // Some browsers cannot handle huge fragments in high bitrate.
                // This issue usually happens when using HWA encoders with a high bitrate setting.
                // Limit the BufferLength to 6s, it works fine when playing 4k 120Mbps over HLS on chrome.
                // https://github.com/video-dev/hls.js/issues/876
                if ((browser.chrome || browser.edgeChromium || browser.firefox) && playbackManager.getMaxStreamingBitrate(this) >= 25000000) {
                    maxBufferLength = 6;
                }`;

function replace(source, before, after, label) {
    if (source.split(before).length !== 2) throw new Error(`Upstream HLS ${label} patch anchor changed`);
    return source.replace(before, after);
}

export function patchHlsBuffer(source) {
    source = replace(source, "import Screenfull from 'screenfull';", `import Screenfull from 'screenfull';
import { hlsBufferConfig, sourceBitrate, observeHlsBuffer } from '../../discordActivity/hlsBuffer';`, 'import');
    source = replace(source, bufferAnchor,
        '                const bufferConfig = hlsBufferConfig(sourceBitrate(options.mediaSource));', 'policy');
    source = replace(source, `                    maxBufferLength: maxBufferLength,
                    maxMaxBufferLength: maxBufferLength,`, '                    ...bufferConfig,', 'configuration');
    return replace(source, '                hls.loadSource(url);',
        '                observeHlsBuffer(hls, Hls.Events);\n                hls.loadSource(url);', 'observer');
}

export function patchHlsRecovery(source) {
    if (source.includes('// hls.js retries transient segment responses within its bounded error')) {
        throw new Error('Upstream HLS fragment recovery patch anchor changed');
    }
    source = replace(source, 'playWithPromise(elem, onErrorFn).then(resolve, function () {', `playWithPromise(elem, onErrorFn).then(() => {
            // After playback starts, later fatal errors must reach the player
            // event handler rather than rejecting an already-settled promise.
            reject = null;
            resolve();
        }, function () {`, 'started playback error routing');
    source = replace(source, 'export function bindEventsToHlsPlayer(instance, hls, elem, onErrorFn, resolve, reject) {', `export function bindEventsToHlsPlayer(instance, hls, elem, onErrorFn, resolve, reject) {
    // Fatal errors already exhausted hls.js's own retries. Bound explicit restarts.
    let fatalNetworkRestarts = 0;
    let healthyPlaybackSeconds = 0;
    let lastPlaybackPosition = elem.currentTime || 0;
    const resetProgress = () => {
        healthyPlaybackSeconds = 0;
        lastPlaybackPosition = elem.currentTime || 0;
    };
    const observeProgress = () => {
        const position = elem.currentTime || 0;
        const delta = position - lastPlaybackPosition;
        lastPlaybackPosition = position;
        if (elem.paused || elem.seeking || elem.readyState < 3 || delta <= 0 || delta > 2) {
            healthyPlaybackSeconds = 0;
            return;
        }
        healthyPlaybackSeconds += delta;
        if (healthyPlaybackSeconds >= 30) {
            fatalNetworkRestarts = 0;
            healthyPlaybackSeconds = 0;
        }
    };
    elem.addEventListener('timeupdate', observeProgress);
    for (const event of ['waiting', 'seeking', 'pause']) elem.addEventListener(event, resetProgress);
    hls.on(Hls.Events.DESTROYING, () => {
        elem.removeEventListener('timeupdate', observeProgress);
        for (const event of ['waiting', 'seeking', 'pause']) elem.removeEventListener(event, resetProgress);
    });`, 'network retry budget');
    source = replace(source, `                        console.debug('fatal network error encountered, try to recover');
                        hls.startLoad();`, `                        resetProgress();
                        if (fatalNetworkRestarts++ < 2) {
                            console.debug('fatal network error encountered, try bounded recovery');
                            hls.startLoad();
                        } else {
                            hls.destroy();
                            if (reject) {
                                reject(MediaError.NETWORK_ERROR);
                                reject = null;
                            } else {
                                onErrorInternal(instance, MediaError.NETWORK_ERROR);
                            }
                        }`, 'fatal network recovery');
    const anchor = `        // try to recover network error
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR`;
    return replace(source, anchor, `        // hls.js retries transient segment responses within its bounded error
        // policy. Destroying it here would cancel those nonfatal retries.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR
                && data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR
                && data.response?.code >= 500 && data.response.code <= 599
                && !data.fatal) {
            return;
        }

${anchor}`, 'fragment recovery');
}
