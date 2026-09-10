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

test('Modern native account controls retain Sign out and delegate logout to the broker', async () => {
    const files = await patchedUpstream();
    const userMenu = files.get('src/components/toolbar/AppUserMenu.tsx');
    assert.ok(userMenu.includes("globalize.translate('ButtonSignOut')"));
    assert.ok(!userMenu.includes('Jellyfin accounts'));
    assert.ok(userMenu.includes('Dashboard.logout();'));
    assert.ok(userMenu.includes('Dashboard.selectServer();'));
    assert.ok(!userMenu.includes('QuickConnect'), 'broker account login owns Quick Connect, without a forbidden native enablement probe');
    assert.ok(!files.has('src/scripts/libraryMenu.js'), 'the Activity does not integrate the old application toolbar');
    const called = [];
    const runtime = () => Promise.resolve({
        openAccounts: () => { called.push('accounts'); return 'login'; },
        logoutJellyfin: () => { called.push('logout'); return 'signed-out'; }
    });
    const execute = (body, receiver) => new Function('runtime', body.replaceAll("import('discordActivity/runtime')", 'runtime()')).call(receiver, runtime);
    const router = files.get('src/components/router/appRouter.js');
    for (const name of ['showLocalLogin', 'showSelectServer']) {
        const body = router.match(new RegExp(`    ${name}\\(\\) \\{([\\s\\S]*?)\\n    \\}`))[1];
        assert.equal(await execute(body, { show() { assert.fail('The broker owns native login navigation'); } }), 'login');
    }
    const dashboard = files.get('src/utils/dashboard.js');
    for (const name of ['logout', 'selectServer']) {
        const body = dashboard.match(new RegExp(`export function ${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`))[1];
        assert.equal(await execute(body), name === 'logout' ? 'signed-out' : 'login');
    }
    assert.deepEqual(called, ['accounts', 'accounts', 'logout', 'accounts']);
    assert.ok(!dashboard.includes('ServerConnections.logout()'));
    await assert.rejects(patchNativeIntegration(async (path, before) => {
        assert.equal(files.get(path).split(before).length, 2, 'Repeated patch must fail its anchor');
    }), /Repeated patch/);
});

test('Modern toolbar and video OSD use their native MUI watch-party button without querying or exposing other SyncPlay groups', async () => {
    const files = await patchedUpstream();
    const source = files.get('src/apps/modern/components/AppToolbar/SyncPlayButton.tsx');
    const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022
    } }).outputText;
    const called = []; const exports = {}; let isActive = false; let access = 'CreateAndJoinGroups';
    vm.runInNewContext(compiled, { exports, require(name) {
        if (name.startsWith('@mui/')) return { default: name };
        if (name === 'react') return { default: { createElement: (type, props, ...children) => ({ type, props, children }) }, useCallback: fn => fn };
        if (name === '@jellyfin/sdk/lib/generated-client/models/sync-play-user-access-type') return { SyncPlayUserAccessType: { None: 'None' } };
        if (name === 'hooks/useApi') return { useApi: () => ({ user: { Policy: { SyncPlayAccess: access } } }) };
        if (name === 'apps/modern/features/syncPlay/hooks/useSyncPlay') return { useSyncPlay: () => ({ isActive }) };
        if (name === 'components/pluginManager') return { pluginManager: { ofType: () => ['syncPlay'] } };
        if (name === 'constants/pluginType') return { PluginType: { SyncPlay: 'SyncPlay' } };
        if (name === 'discordActivity/runtime') return { openWatchMenu: () => { called.push('participants'); return 'party'; } };
        throw new Error(`Unexpected Modern watch control import: ${name}`);
    } });
    const descendants = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(descendants)] : [];
    const render = () => descendants(exports.default());
    let nodes = render();
    const button = nodes.find(node => node.type === '@mui/material/IconButton');
    assert.equal(button.props['aria-label'], 'Watch party');
    assert.equal(button.props['aria-haspopup'], 'true');
    assert.equal(nodes.find(node => node.type === '@mui/material/Badge').props.invisible, true);
    assert.equal(called.length, 0, 'rendering a toolbar cannot launch a party action');
    const anchor = { role: 'native-mui-button' };
    assert.equal(await button.props.onClick({ currentTarget: anchor }), 'party');
    assert.deepEqual(called, ['participants']);
    isActive = true; nodes = render();
    assert.equal(nodes.find(node => node.type === '@mui/material/Badge').props.invisible, false);
    access = 'None'; assert.equal(exports.default(), null, 'native SyncPlay permission guard is preserved');
    for (const path of ['src/apps/modern/components/AppToolbar/index.tsx', 'src/apps/modern/routes/video/index.tsx']) {
        const parent = files.get(path);
        assert.ok(parent.includes('<SyncPlayButton />'));
        assert.ok(!parent.includes('RemotePlayButton'), 'unsupported remote playback cannot bypass the Activity player');
    }
    assert.ok(files.get('src/apps/modern/routes/video/index.tsx').includes("controller='playback/video/index'"),
        'Modern continues to use upstream’s shared video controller and its seek/fullscreen integration');
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

test('late login imports and failed cache restores cannot render after their native route unmounts', async () => {
    const files = await patchedUpstream();
    const source = files.get('src/components/viewManager/ViewManagerPage.tsx');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const scenario of ['imports', 'restore']) {
        const loads = []; const imports = [];
        let cleanup; let pathname = '/login'; let navigationType = scenario === 'restore' ? 'POP' : 'PUSH';
        let finishController; let finishHtml; let failRestore;
        const controller = new Promise(resolve => { finishController = resolve; });
        const html = new Promise(resolve => { finishHtml = resolve; });
        const restore = new Promise((_resolve, reject) => { failRestore = reject; });
        const exports = {};
        vm.runInNewContext(compiled, { exports, console: { debug() {} }, require(name) {
            if (name === 'react') return { useEffect(effect) { cleanup = effect(); } };
            if (name === 'react-router-dom') return { useLocation: () => ({ pathname, search: '', state: null }), useNavigationType: () => navigationType };
            if (name === 'hooks/useApi') return { useApi: () => ({}) };
            if (name === 'history') return { Action: { Pop: 'POP' } };
            if (name === 'constants/appType') return { AppType: { Legacy: 'legacy', Dashboard: 'dashboard', Wizard: 'wizard' } };
            if (name === 'lib/globalize') return { default: { translateHtml: value => value } };
            if (name === './viewManager') return { default: {
                loadView: options => loads.push(options), tryRestoreView: () => restore
            } };
            if (name.startsWith('../../apps/legacy/controllers/')) {
                imports.push(name);
                if (name.endsWith('session/login/index.html')) return html;
                if (name.endsWith('session/login/index')) return controller;
                return { default: 'current home fixture' };
            }
            throw new Error(`Unexpected route cancellation dependency: ${name}`);
        } });
        exports.default({ controller: 'session/login/index', view: 'session/login/index.html' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(typeof cleanup, 'function');
        cleanup();
        pathname = '/home'; navigationType = 'PUSH';
        exports.default({ controller: 'home', view: 'home.html' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(loads.length, 1);
        assert.equal(loads[0].url, '/home');
        if (scenario === 'imports') { finishController({ default: 'old login controller' }); finishHtml({ default: 'old login HTML' }); }
        else failRestore({ cancelled: false });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(loads.length, 1, `${scenario}: an old login must not replace the current Home`);
        if (scenario === 'restore') assert.equal(imports.some(name => name.includes('session/login')), false,
            'an unmounted restore failure cannot start importing the old controller');
        cleanup();
    }
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

test('direct account routes render the actual native login page before an account exists', async () => {
    const files = await patchedUpstream();
    const root = files.get('src/RootAppRouter.tsx');
    assert.ok(root.includes('...MODERN_APP_ROUTES,'));
    assert.ok(!root.includes('LEGACY_APP_ROUTES'), 'the unused old application route tree is neither imported nor selectable');
    assert.ok(root.includes('<AppHeader isHidden={layoutManager.modern || isNewLayoutPath} />'),
        'upstream shared controllers retain their required hidden header DOM');
    const routes = files.get('src/apps/modern/routes/routes.tsx');
    assert.ok(!files.has('src/apps/legacy/routes/routes.tsx'));
    assert.ok(routes.indexOf('...ACCOUNT_ROUTE_PATHS.map') < routes.indexOf('/* User routes */'), 'broker account routes must bypass ConnectionRequired bounce');
    for (const collection of ['ASYNC_PUBLIC_ROUTES', 'LEGACY_PUBLIC_ROUTES']) {
        assert.ok(routes.includes(`${collection}.filter(route => !ACCOUNT_ROUTE_PATHS.includes(route.path))`));
    }
    const source = await readFile(new URL('../src/accountsRoute.js', import.meta.url), 'utf8');
    const routePaths = source.match(/ACCOUNT_ROUTE_PATHS = (\[[^\n]+\])/)[1];
    assert.deepEqual(new Function(`return ${routePaths}`)(), ['login', 'selectserver', 'addserver', 'forgotpassword', 'forgotpasswordpin']);
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, require(name) {
        if (name === 'react') return { default: { createElement: (type, props) => ({ type, props }) } };
        if (name === 'components/viewManager/ViewManagerPage') return { default: 'native-view-manager' };
        throw new Error(`A login route cannot start broker authentication or navigation during render: ${name}`);
    } });
    const rendered = exports.default();
    assert.equal(rendered.type, 'native-view-manager');
    assert.equal(rendered.props.controller, 'session/login/index');
    assert.equal(rendered.props.view, 'session/login/index.html');
    assert.equal(rendered.props.isNowPlayingBarEnabled, false);
});
