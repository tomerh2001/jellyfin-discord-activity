import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { patchNativeIntegration } from '../integrationPatch.mjs';
import { installNativeSocket } from '../src/nativeSocket.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');

async function patchedUpstream() {
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    const files = new Map();
    await patchNativeIntegration(async (path, before, after) => {
        const content = files.get(path) ?? execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/${path}`], { encoding: 'utf8' });
        assert.equal(content.split(before).length, 2, `Exact upstream anchor: ${path}`);
        files.set(path, content.replace(before, after));
    });
    return files;
}

test('verified upstream native controls keep their UI and call the in-document broker without navigating or logging out', async () => {
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    const paths = ['src/scripts/libraryMenu.js', 'src/components/router/appRouter.js', 'src/utils/dashboard.js'];
    const originalLibrary = execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/${paths[0]}`], { encoding: 'utf8' });
    const originalHeader = originalLibrary.match(/html \+= '.*class="headerSyncButton.*';/)[0];
    const files = await patchedUpstream();
    const library = files.get(paths[0]);
    assert.ok(library.includes(originalHeader));
    assert.ok(library.includes("headerSyncButton.title = 'Watch party'"));
    assert.ok(!library.includes("${globalize.translate('ButtonSignOut')}"));
    assert.match(library, /class="navMenuOptionText">Jellyfin accounts<\/span>/);
    const called = [];
    const runtime = () => Promise.resolve({ openAccounts: () => { called.push('accounts'); return 'picker'; }, openWatchMenu: button => { called.push(button); return 'party'; } });
    const button = { role: 'native-syncplay-button' };
    const watch = library.match(/function onSyncButtonClicked\(\) \{([\s\S]*?)\n\}/)[1];
    const execute = (body, receiver) => new Function('runtime', body.replaceAll("import('discordActivity/runtime')", 'runtime()')).call(receiver, runtime);
    assert.equal(await execute(watch, button), 'party');
    const router = files.get(paths[1]);
    for (const name of ['showLocalLogin', 'showSelectServer']) {
        const body = router.match(new RegExp(`    ${name}\\(\\) \\{([\\s\\S]*?)\\n    \\}`))[1];
        assert.equal(await execute(body, { show() { assert.fail('Document/router navigation is forbidden'); } }), 'picker');
    }
    const dashboard = files.get(paths[2]);
    for (const name of ['logout', 'selectServer']) {
        const body = dashboard.match(new RegExp(`export function ${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`))[1];
        assert.equal(await execute(body), 'picker');
    }
    assert.deepEqual(called, [button, 'accounts', 'accounts', 'accounts', 'accounts']);
    assert.ok(!dashboard.includes('ServerConnections.logout()'));
    await assert.rejects(patchNativeIntegration(async (path, before) => {
        assert.equal(files.get(path).split(before).length, 2, 'Repeated patch must fail its anchor');
    }), /Repeated patch/);
});

test('same-route native view reloads for a replacement ApiClient, including another account on the same server', async () => {
    const files = await patchedUpstream();
    const source = files.get('src/components/viewManager/ViewManagerPage.tsx');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    let client = { serverId: 'same-server', userId: 'first-user' };
    let dependencies;
    const loads = [];
    const exports = {};
    vm.runInNewContext(compiled, { exports, console: { debug() {} }, require(name) {
        if (name === 'react') return { useEffect(effect, next) {
            if (!dependencies || next.some((value, index) => value !== dependencies[index])) { dependencies = next; effect(); }
        } };
        if (name === 'react-router-dom') return { useLocation: () => ({ pathname: '/home', search: '', state: null }), useNavigationType: () => 'PUSH' };
        if (name === 'hooks/useApi') return { useApi: () => ({ __legacyApiClient__: client }) };
        if (name === 'history') return { Action: { Pop: 'POP' } };
        if (name === 'constants/appType') return { AppType: { Legacy: 'legacy', Dashboard: 'dashboard', Wizard: 'wizard' } };
        if (name === 'lib/globalize') return { default: { translateHtml: html => html } };
        if (name === './viewManager') return { default: { loadView: options => loads.push(options) } };
        if (name.startsWith('../../apps/legacy/controllers/')) return { default: 'native fixture' };
        throw new Error(`Unexpected test import: ${name}`);
    } });
    const render = () => exports.default({ controller: 'home', view: 'home.html' });
    render(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(loads.length, 1);
    render(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(loads.length, 1, 'unchanged client and URL must not reload on every render');
    client = { serverId: 'same-server', userId: 'second-user' };
    render(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(loads.length, 2, 'same Home URL and server still reload after account replacement');
    assert.equal(loads[1].url, '/home');
});

test('Jellyfin 12 notification subscriptions ignore replaced clients and clean up their actual handlers', async () => {
    const files = await patchedUpstream();
    const connection = files.get('src/lib/jellyfin-apiclient/ServerConnections.js');
    assert.ok(connection.includes('installNativeSocket(apiClient, Events, () => this.currentApiClient() === apiClient)'));
    const source = files.get('src/scripts/serverNotifications.js');
    const body = source.match(/function subscribeToApiClient\(apiClient\) \{([\s\S]*?)\n\}/)[1];
    const received = []; const handlers = new Map(); let current = true;
    const socket = { onStatusChange: () => () => {}, disconnect() {} };
    const client = { _sdk: { webSocket: socket, update() {}, subscribe(types, callback) {
        for (const type of types) handlers.set(type, callback);
        return () => { for (const type of types) handlers.delete(type); };
    } } };
    installNativeSocket(client, { trigger() {} }, () => current);
    const types = Object.fromEntries(['Play', 'Playstate', 'GeneralCommand', 'SyncPlayCommand', 'SyncPlayGroupUpdate'].map(value => [value, value]));
    const invoke = new Function('apiClient', 'OutboundWebSocketMessageType', 'pluginManager', 'PluginType', 'Events', 'serverNotifications', 'onPlay', 'onPlaystate', 'processGeneralCommand', body);
    const cleanup = invoke(client, types, { firstOfType: () => ({ instance: { Manager: {
        processCommand: value => received.push(value), processGroupUpdate: value => received.push(value)
    } } }) }, { SyncPlay: 'syncplay' }, { trigger() {} }, {}, assert.fail, assert.fail, assert.fail);
    const oldCallback = handlers.get('SyncPlayCommand');
    oldCallback({ Data: 'current-play' }); assert.deepEqual(received, ['current-play']);
    current = false; oldCallback({ Data: 'old-play' }); assert.deepEqual(received, ['current-play']);
    cleanup(); assert.equal(handlers.size, 0);
    current = true; oldCallback({ Data: 'unsubscribed-play' }); assert.deepEqual(received, ['current-play']);
    client.closeWebSocket();
});

test('direct account routes use a lazy native dialog and return Home without reloading the document', async () => {
    const files = await patchedUpstream();
    const routes = files.get('src/apps/legacy/routes/routes.tsx');
    assert.ok(routes.indexOf('...ACCOUNT_ROUTE_PATHS.map') < routes.indexOf('/* User routes */'), 'broker account routes must bypass ConnectionRequired bounce');
    for (const collection of ['ASYNC_PUBLIC_ROUTES', 'LEGACY_PUBLIC_ROUTES']) {
        assert.ok(routes.includes(`${collection}.filter(route => !ACCOUNT_ROUTE_PATHS.includes(route.path))`));
    }
    const source = await readFile(new URL('../src/accountsRoute.js', import.meta.url), 'utf8');
    const routePaths = source.match(/ACCOUNT_ROUTE_PATHS = (\[[^\n]+\])/)[1];
    assert.deepEqual(new Function(`return ${routePaths}`)(), ['login', 'selectserver', 'addserver', 'forgotpassword', 'forgotpasswordpin']);
    const body = source.match(/export default function NativeAccountsRoute\(\) \{([\s\S]*)\n\}/)[1];
    let effect;
    let resolveDialog;
    let opens = 0;
    const navigations = [];
    const route = new Function('useEffect', 'useNavigate', 'loadRuntime', body.replace("import('./runtime')", 'loadRuntime()'));
    const render = () => route(fn => { effect = fn; }, () => (...args) => navigations.push(args),
        () => Promise.resolve({ openAccounts() { opens++; return new Promise(resolve => { resolveDialog = resolve; }); } }));
    render(); assert.equal(opens, 0, 'import and account action wait for native route mount');
    const cleanup = effect(); await Promise.resolve(); assert.equal(opens, 1); assert.equal(navigations.length, 0);
    resolveDialog(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(navigations, [['/home', { replace: true }]]);
    cleanup();
    render(); const leaveRoute = effect(); await Promise.resolve(); leaveRoute(); resolveDialog(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(navigations.length, 1, 'late account completion cannot navigate a route that unmounted');
});
