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
