import { createHash } from 'node:crypto';

/** Replace only the checksum-verified pinned player's seek-preview renderer. */
export function patchNativeSeekPreview(source) {
    const replace = (before, after) => {
        if (source.split(before).length !== 2) throw new Error('Native seek-preview patch anchor changed');
        source = source.replace(before, after);
    };
    const renderer = source.match(/    function updateTrickplayBubbleHtml\([\s\S]*?(?=\n    function getImgUrl\()/)?.[0];
    if (!renderer || createHash('sha256').update(renderer).digest('hex') !== 'c546c5a01c8f934eeccd9bd6043fd0cc8907e10bd48f421c9a55236f8a2044b6') {
        throw new Error('Pinned native trickplay renderer changed');
    }
    replace(renderer, `    function updateTrickplayBubbleHtml(apiClient, trickplayInfo, item, mediaSourceId, bubble, positionTicks) {
        return seekPreview.update(bubble, { apiClient, info: trickplayInfo, item, mediaSourceId }, positionTicks);
    }
`);
    replace("import escapeHtml from 'escape-html';", "import escapeHtml from 'escape-html';\nimport { createSeekPreview } from 'discordActivity/seekPreview';");
    replace('export default function (view) {', `export default function (view) {
    const seekPreview = createSeekPreview({ document: view.ownerDocument, formatTime: datetime.getDisplayRunningTime });`);
    replace('            if (bestWidth) trickplayResolution = trickplayResolutions[bestWidth];\n        }', `            if (bestWidth) trickplayResolution = trickplayResolutions[bestWidth];
        }
        seekPreview.prepare({ apiClient: ServerConnections.getApiClient(item.ServerId),
            info: trickplayResolution, item, mediaSourceId }, playbackManager.currentTime(currentPlayer) * 10000);`);
    replace('    function releaseCurrentPlayer() {', '    function releaseCurrentPlayer() {\n        seekPreview.clear();');
    replace('    function onPlaybackStopped(e, state) {', '    function onPlaybackStopped(e, state) {\n        seekPreview.clear();');
    replace("    view.addEventListener('viewdestroy', function () {", "    view.addEventListener('viewdestroy', function () {\n        seekPreview.clear();");
    return source;
}
