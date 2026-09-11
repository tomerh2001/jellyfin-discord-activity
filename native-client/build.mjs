import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { precompress } from './precompress.mjs';
import { patchVideoUnpause } from './videoPlaybackPatch.mjs';
import { patchNativeIntegration } from './integrationPatch.mjs';
import { patchNativeStartup } from './startupPatch.mjs';
import { patchNativeSeekPreview } from './seekPreviewPatch.mjs';
import { patchModernPresentation } from './presentationPatch.mjs';
import { patchAccountView } from './accountPatch.mjs';
import { patchLoginPage } from './loginPatch.mjs';
import { patchAuthenticatedClient } from './authenticatedClientPatch.mjs';
import { patchNativeViewLifecycle } from './viewLifecyclePatch.mjs';
import { patchActivityPlayback } from './activityPlaybackPatch.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const upstream = JSON.parse(await readFile(path.join(root, 'upstream.json'), 'utf8'));
const work = path.join(root, '.build');
const source = path.join(work, 'source');
const archive = path.join(work, `${upstream.commit}.tar.gz`);
await mkdir(source, { recursive: true });

function run(command, args, cwd = source, extraEnv = {}) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

if (!existsSync(archive)) {
    const response = await fetch(`https://codeload.github.com/jellyfin/jellyfin-web/tar.gz/${upstream.commit}`);
    if (!response.ok) throw new Error(`Upstream download failed (${response.status})`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
}
const actualHash = createHash('sha256').update(await readFile(archive)).digest('hex');
if (actualHash !== upstream.archiveSha256) throw new Error('Pinned Jellyfin source archive checksum mismatch');
// Re-extract the clean, verified upstream files; reuse only the npm download cache.
await rm(path.join(source, 'src'), { recursive: true, force: true });
run('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);

async function replace(relative, before, after) {
    const file = path.join(source, relative);
    const content = await readFile(file, 'utf8');
    if (content.split(before).length !== 2) throw new Error(`Upstream patch anchor changed: ${relative}`);
    await writeFile(file, content.replace(before, after));
}

await cp(path.join(root, 'src'), path.join(source, 'src/discordActivity'), { recursive: true });
await patchNativeIntegration(replace);
await patchNativeViewLifecycle(replace);
await patchNativeStartup(replace);
await patchModernPresentation(replace);
await patchAccountView(replace);
await patchLoginPage(replace);
await patchAuthenticatedClient(replace);
await patchActivityPlayback(replace);
await writeFile(path.join(source, 'src/apps/legacy/controllers/session/login/index.js'), `import 'elements/emby-input/emby-input';
import 'elements/emby-button/emby-button';
import './login.scss';
export { default } from 'discordActivity/loginPage';
`);
const seekController = path.join(source, 'src/apps/legacy/controllers/playback/video/index.js');
await writeFile(seekController, patchNativeSeekPreview(await readFile(seekController, 'utf8')));
await replace('webpack.common.js', "const NODE_MODULES_REGEX =", `// Pin build metadata to Jellyfin's source, not a containing checkout.\nCOMMIT_SHA = '${upstream.commit}';\nconst NODE_MODULES_REGEX =`);
await replace('src/index.jsx', "import RootApp from './RootApp';", "import RootApp from './RootApp';\nimport { bootstrapDiscord, finishDiscordBootstrap, failDiscordBootstrap } from './discordActivity/runtime';");
await replace('src/index.jsx', `    // Find the correct server URL
    const lastServer = ServerConnections.getLastUsedServer();
    let serverUrl;
    if (lastServer) {
        serverUrl = getServerAddress(lastServer);
    } else {
        serverUrl = await serverAddress();
    }
    // Initialize the api client
    if (serverUrl) ServerConnections.initApiClient(serverUrl);`, '    // Keep Discord and Jellyfin in one native document.\n    await bootstrapDiscord();');
await replace('src/index.jsx', "import getServerAddress from 'lib/jellyfin-apiclient/utils/getServerAddress';\n", '');
await replace('src/index.jsx', "import { pageClassOn, serverAddress } from './utils/dashboard';", "import { pageClassOn } from './utils/dashboard';");
await replace('src/index.jsx', '    // Load the translation dictionary\n    await loadCoreDictionary();', '    // The dictionary was loaded before the native account dialogs.');
await replace('src/index.jsx', '    await bootstrapDiscord();', '    await loadCoreDictionary();\n    await bootstrapDiscord();');
await replace('src/index.jsx', '    await renderApp();', '    await renderApp();\n    await finishDiscordBootstrap();');
await replace('src/index.jsx', '        registerServiceWorker();', '        // Activity sessions and gateway capabilities must never enter a service-worker cache.');
await replace('src/index.jsx', '\ninit();', '\ninit().catch(failDiscordBootstrap);');
await replace('src/components/htmlMediaHelper.js',
    '                    // swallow this error because the user can still click the play button on the video element',
    `                    // Embedded mobile players need a gesture on this exact video,
                    // not the SyncPlay UI's temporary silent audio element.
                    elem.dispatchEvent(new Event('jellyfin-watch-playback-blocked', { bubbles: true }));
                    // Keep upstream recovery behavior; our adapter offers the gesture.`);
const videoPlugin = path.join(source, 'src/plugins/htmlVideoPlayer/plugin.js');
await writeFile(videoPlugin, patchVideoUnpause(await readFile(videoPlugin, 'utf8')));
await replace('src/plugins/syncPlay/core/Helper.js',
    `                    episodesResult.TotalRecordCount = episodesResult.Items.length;
                    resolve(episodesResult);`,
    `                    episodesResult.TotalRecordCount = episodesResult.Items.length;
                    // A playable selected episode may be absent from the expanded
                    // series list. Keep that selection rather than sending an empty queue.
                    resolve(episodesResult.Items.length ? episodesResult : null);`);
await replace('src/apps/legacy/features/playback/utils/mediaSegmentSettings.ts', '    return action ? action as MediaSegmentAction : defaultAction;', `    // An individual's automatic skip preference must not seek the whole party.
    if (action === MediaSegmentAction.Skip) return MediaSegmentAction.AskToSkip;
    return action ? action as MediaSegmentAction : defaultAction;`);
for (const player of ['htmlVideoPlayer', 'htmlAudioPlayer']) {
    await replace(`src/plugins/${player}/plugin.js`, '        hls.DefaultConfig.lowLatencyMode = false;', `        // The production bundle's stringified worker factory closes over webpack
        // variables. Load the lockfile-pinned standalone worker without rebundling.
        hls.DefaultConfig.workerPath = new URL('libraries/hls.worker.js', document.baseURI).href;
        hls.DefaultConfig.lowLatencyMode = false;`);
}
const configPath = path.join(source, 'src/config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.multiserver = true;
config.plugins = config.plugins.filter(plugin => !['sessionPlayer/plugin', 'chromecastPlayer/plugin', 'youtubePlayer/plugin'].includes(plugin));
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

if (!process.argv.includes('--prepare-only')) {
    const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout?.trim();
    if (!npmVersion || Number(npmVersion.split('.')[0]) < 11 || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Native Jellyfin 12 build requires Node24 and npm11 or newer, as specified by upstream.');
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    run('npm', ['run', 'build:production'], source, { JELLYFIN_VERSION: upstream.version, NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=6144' });
    await rm(path.join(root, 'dist'), { recursive: true, force: true });
    await cp(path.join(source, 'dist'), path.join(root, 'dist'), { recursive: true });
    // A classic blocking script must run before every upstream module. Imports
    // inside runtime.js are too late: their dependency constructors read storage.
    await cp(path.join(root, 'src/storage.js'), path.join(root, 'dist/activity-storage.js'));
    const nativeIndex = path.join(root, 'dist/index.html');
    const nativeHtml = await readFile(nativeIndex, 'utf8');
    if (nativeHtml.split('<head>').length !== 2) throw new Error('Native HTML bootstrap anchor changed');
    await writeFile(nativeIndex, nativeHtml.replace('<head>', '<head><script src="/activity-storage.js"></script><script src="/activity-session.js"></script>'));

    await cp(path.join(source, 'node_modules/hls.js/dist/hls.worker.js'), path.join(root, 'dist/libraries/hls.worker.js'));
    await cp(path.join(source, 'node_modules/hls.js/LICENSE'), path.join(root, 'dist/HLS-LICENSE.txt'));
    const licenseFile = ['LICENSE', 'LICENSE.txt', 'COPYING'].find(name => existsSync(path.join(source, name)));
    if (!licenseFile) throw new Error('Upstream license is missing');
    await cp(path.join(source, licenseFile), path.join(root, 'dist/JELLYFIN-LICENSE.txt'));
    await writeFile(path.join(root, 'dist/JELLYFIN-SOURCE.json'), JSON.stringify(upstream, null, 2) + '\n');
    await precompress(path.join(root, 'dist'));
    console.info(`Built Jellyfin Web ${upstream.version} at ${upstream.commit}`);
}
