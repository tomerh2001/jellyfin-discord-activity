import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { patchNativeIntegration } from '../integrationPatch.mjs';

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
        if (name === 'constants/appType') return { AppType: { Stable: 'stable', Dashboard: 'dashboard', Wizard: 'wizard' } };
        if (name === 'lib/globalize') return { default: { translateHtml: html => html } };
        if (name === './viewManager') return { default: { loadView: options => loads.push(options) } };
        if (name.startsWith('../../controllers/')) return { default: 'native fixture' };
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

test('replaced-client WebSocket messages cannot affect the current native party', async () => {
    const files = await patchedUpstream();
    const body = files.get('src/scripts/serverNotifications.js').match(/function onMessageReceived\(e, msg\) \{([\s\S]*?)\n\}/)[1];
    const current = { serverId: () => 'same-server' };
    const old = { serverId: () => 'same-server' };
    const received = [];
    let pluginReads = 0;
    const handler = new Function('ServerConnections', 'pluginManager', 'PluginType', `return function(e, msg) {${body}\n}`)(
        { currentApiClient: () => current },
        { firstOfType() { pluginReads++; return { instance: { Manager: {
            processCommand: (data, client) => received.push(['command', data, client]),
            processGroupUpdate: (data, client) => received.push(['group', data, client])
        } } }; } }, { SyncPlay: 'syncplay' });
    handler.call(old, {}, { MessageType: 'SyncPlayGroupUpdate', Data: 'old-join' });
    handler.call(old, {}, { MessageType: 'SyncPlayCommand', Data: 'old-play' });
    assert.equal(pluginReads, 0);
    assert.equal(received.length, 0);
    handler.call(current, {}, { MessageType: 'SyncPlayGroupUpdate', Data: 'current-join' });
    assert.deepEqual(received, [['group', 'current-join', current]]);
});

test('direct account routes use a lazy native dialog and return Home without reloading the document', async () => {
    const files = await patchedUpstream();
    const routes = files.get('src/apps/stable/routes/routes.tsx');
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
