import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { patchBackNavigation } from '../backNavigationPatch.mjs';
import { patchNativeIntegration } from '../integrationPatch.mjs';
import { patchNativeViewLifecycle } from '../viewLifecyclePatch.mjs';

const ts = createRequire(import.meta.url)('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
let patched;
async function sources() {
    if (patched) return patched;
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    const files = new Map();
    const replace = async (path, before, after) => {
        const source = files.get(path) ?? execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/${path}`], { encoding: 'utf8' });
        assert.equal(source.split(before).length, 2, `Exact upstream patch anchor: ${path}\n${before}`);
        files.set(path, source.replace(before, after));
    };
    await patchNativeIntegration(replace);
    await patchNativeViewLifecycle(replace);
    await patchBackNavigation(replace);
    patched = files;
    return files;
}

async function fixture({ path = '/video', index = 1, historyLength = 2, synchronousBack = false, backError } = {}) {
    const files = await sources();
    const timers = new Map(); const pushes = []; const listeners = new Set(); const documentListeners = new Map();
    let timerId = 0; let backCalls = 0;
    const browserHistory = { state: index === undefined ? null : { idx: index }, length: historyLength };
    const history = {
        location: { pathname: path, search: '' },
        listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        back() {
            backCalls++;
            if (backError) throw backError;
            if (synchronousBack) this.pop('/details', 0);
        },
        push(next) {
            pushes.push(next); browserHistory.state = { idx: (browserHistory.state?.idx || 0) + 1 };
            this.location = { pathname: next, search: '' };
            this.emit('PUSH');
        },
        pop(next, nextIndex = Math.max(0, (browserHistory.state?.idx || 0) - 1)) {
            this.location = { pathname: next, search: '' }; browserHistory.state = { idx: nextIndex };
            this.emit('POP');
        },
        emit(action = 'POP') {
            for (const listener of [...listeners]) listener({ action, location: this.location });
        }
    };
    const document = {
        addEventListener: (event, callback) => documentListeners.set(event, callback),
        querySelector: () => null
    };
    const window = { location: { href: `https://fixture.invalid/index.html#${path}`, pathname: '/index.html' }, history: browserHistory };
    const dependencies = {
        '@jellyfin/sdk/lib/generated-client/models/collection-type': {}, '../backdrop/backdrop': {}, '../../lib/globalize': {},
        '../itemHelper': {}, '../loading/loading': { default: { hide() {} } }, '../alert': {}, 'components/layoutManager': {},
        'hooks/useItem': {}, 'lib/jellyfin-apiclient': {}, 'utils/query/queryClient': {}, RootAppRouter: { history }
    };
    const compile = (source, imports) => {
        const exports = {};
        vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
            module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React
        } }).outputText, {
            exports, document, window,
            setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
            clearTimeout(id) { timers.delete(id); }, console: { debug() {} },
            require(name) { assert.ok(name in imports, `Unexpected native dependency: ${name}`); return imports[name]; }
        });
        return exports;
    };
    const { appRouter: router } = compile(files.get('src/components/router/appRouter.js'), dependencies);
    return { files, router, history, browserHistory, document, window, pushes, timers, listeners, compile,
        get backCalls() { return backCalls; },
        show: () => documentListeners.get('viewshow')(),
        flush: () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } }
    };
}

test('a first-entry video returns to Home despite the enclosing Discord history and then permits navigation', async () => {
    const f = await fixture({ index: 0, historyLength: 9 });
    assert.equal(f.router.canGoBack(), true);
    const back = f.router.back();
    assert.equal(f.backCalls, 0, 'Back must not traverse Discord entries outside this Activity');
    f.flush(); assert.deepEqual(f.pushes, ['/home']);
    f.show(); await back;
    assert.equal(f.router.promiseShow, null);
    assert.equal(f.router.canGoBack(), false);
    const next = f.router.show('/details'); f.flush(); f.show(); await next;
    assert.deepEqual(f.pushes, ['/home', '/details']);
});

test('missing or invalid router indexes use Home instead of traversing external browser history', async () => {
    for (const state of [null, {}, { idx: -1 }, { idx: 0.5 }, { idx: '3' }]) {
        const f = await fixture({ path: '/details', historyLength: 7 });
        f.browserHistory.state = state;
        const back = f.router.back(); f.flush(); f.show(); await back;
        assert.equal(f.backCalls, 0);
        assert.deepEqual(f.pushes, ['/home']);
        assert.equal(f.router.promiseShow, null);
    }
});

test('normal and synchronous Back resolve at the previous route and remove their temporary listener', async () => {
    for (const synchronousBack of [false, true]) {
        const f = await fixture({ synchronousBack });
        const baseline = f.listeners.size;
        const back = f.router.back();
        assert.equal(f.backCalls, 1);
        if (!synchronousBack) {
            assert.equal(f.listeners.size, baseline + 1);
            f.history.pop('/details');
        }
        await back;
        assert.equal(f.history.location.pathname, '/details');
        assert.equal(f.listeners.size, baseline);
        assert.equal(f.router.promiseShow, null);
        assert.deepEqual(f.pushes, []);
    }
});

test('Back releases a page awaiting viewshow and blocks navigation queued behind the cancelled page', async () => {
    const f = await fixture({ path: '/details' });
    const loading = f.router.show('/video'); f.flush();
    const obsolete = f.router.show('/obsolete');
    await tick(); assert.deepEqual(f.pushes, ['/video']);
    const back = f.router.back();
    await loading; await obsolete;
    assert.equal(f.backCalls, 1, 'Back proceeds without waiting for missing viewshow');
    f.history.pop('/details'); await back;
    f.flush(); assert.deepEqual(f.pushes, ['/video']);
    assert.equal(f.router.promiseShow, null);
});

test('Back invalidates a scheduled forward push, including its already queued timer callback', async () => {
    const f = await fixture({ path: '/details' });
    const old = f.router.show('/obsolete');
    const staleTimer = [...f.timers.values()][0];
    const back = f.router.back();
    await old;
    assert.equal(f.timers.size, 0);
    staleTimer();
    assert.deepEqual(f.pushes, []);
    f.history.pop('/home'); await back;
    assert.equal(f.router.promiseShow, null);
});

test('account cancellation releases pending Back and queued routes without letting its late listener cancel new work', async () => {
    const f = await fixture();
    const baseline = new Set(f.listeners);
    const back = f.router.back();
    const staleListener = [...f.listeners].find(listener => !baseline.has(listener));
    const oldRoute = f.router.show('/old-account-settings');
    f.router.cancelPendingNavigation();
    await back; await oldRoute;
    assert.equal(f.listeners.size, baseline.size);
    assert.equal(f.router.promiseShow, null);
    assert.equal(f.timers.size, 0);
    const login = f.router.show('/login');
    const currentPromise = f.router.promiseShow;
    staleListener({ action: 'POP', location: { pathname: '/details', search: '' } });
    assert.equal(f.router.promiseShow, currentPromise, 'a queued listener from the previous account cannot settle its replacement');
    f.flush(); assert.deepEqual(f.pushes, ['/login']);
    f.show(); await login;
});

test('a thrown browser Back releases its listener and pending state', async () => {
    const error = new Error('history traversal denied');
    const f = await fixture({ backError: error });
    const baseline = f.listeners.size;
    await assert.rejects(f.router.back(), failure => failure === error);
    assert.equal(f.listeners.size, baseline);
    assert.equal(f.router.promiseShow, null);
});

test('the Modern toolbar exposes Back without NativeShell and hides it on root pages', async () => {
    const f = await fixture({ path: '/details', index: 0, historyLength: 1 });
    const { default: Toolbar } = f.compile(f.files.get('src/apps/modern/components/AppToolbar/index.tsx'), {
        '@mui/material/Stack': {},
        react: { default: { createElement: (type, props, ...children) => ({ type, props, children }), Fragment: 'fragment' } },
        'react-router-dom': { useLocation: () => f.history.location },
        'components/router/appRouter': { appRouter: f.router, PUBLIC_PATHS: ['/login', '/selectserver'] },
        'components/toolbar/AppToolbar': { default: 'toolbar' }, 'components/toolbar/ServerButton': {},
        './SyncPlayButton': {}, './SearchButton': {}, './userViews/UserViewNav': {}
    });
    assert.equal(f.window.NativeShell, undefined);
    const props = { isDrawerAvailable: true, isDrawerOpen: false, onDrawerButtonClick() {} };
    assert.equal(Toolbar(props).props.isBackButtonAvailable, true);
    for (const path of ['/home', '/login', '/selectserver']) {
        f.history.location.pathname = path;
        assert.equal(Toolbar(props).props.isBackButtonAvailable, false);
        await f.router.back();
    }
    assert.equal(f.backCalls, 0);
    f.history.location.pathname = '/video';
    assert.equal(Toolbar(props), null, 'video retains its own native OSD toolbar');
});
