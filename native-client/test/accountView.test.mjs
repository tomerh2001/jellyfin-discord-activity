import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import * as state from '../src/accountViewState.js';
import { patchNativeIntegration } from '../integrationPatch.mjs';
import { patchNativeStartup } from '../startupPatch.mjs';
import { patchAccountView } from '../accountPatch.mjs';

const require = createRequire(import.meta.url);
const nativeRequire = createRequire(new URL('../.build/source/package.json', import.meta.url));
const React = nativeRequire('react');
const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');
const ts = require('typescript');

test('Modern account replacement disposes cached pages and rejects late state from the old provider', async () => {
    const { window } = new JSDOM('<div id="root"></div>', { url: 'https://fixture.invalid' });
    globalThis.window = window; globalThis.document = window.document;
    const { createRoot } = nativeRequire('react-dom/client');
    const { flushSync } = nativeRequire('react-dom');
    const source = await readFile(new URL('../src/AccountView.js', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, { exports: module.exports, require: name => name === 'react' ? React : state });
    const AccountView = module.exports.default;
    let identity = 'account A'; let disposeCount = 0; let oldCompletion;
    function CachedHome() {
        const [title, setTitle] = React.useState(identity);
        React.useEffect(() => { oldCompletion = () => setTitle('late private A data'); return () => { disposeCount++; }; }, []);
        return React.createElement('div', null, title);
    }
    const root = createRoot(window.document.getElementById('root'));
    try {
        flushSync(() => root.render(React.createElement(AccountView, null, React.createElement(CachedHome))));
        assert.equal(window.document.body.textContent, 'account A');
        const late = oldCompletion;
        flushSync(state.beginAccountViewChange);
        assert.equal(window.document.body.textContent, '');
        assert.equal(disposeCount, 1, 'account-owned controllers are gone before new authentication');
        late();
        assert.equal(window.document.body.textContent, '', 'a pending/failed replacement stays empty');
        identity = 'account B';
        flushSync(state.finishAccountViewChange);
        assert.equal(window.document.body.textContent, 'account B');
        flushSync(late);
        assert.equal(window.document.body.textContent, 'account B', 'late old data cannot restore the old Home');
        flushSync(() => root.render(React.createElement(AccountView, null, React.createElement(CachedHome))));
        assert.equal(disposeCount, 1, 'ordinary rerenders preserve the current page');
    } finally {
        flushSync(() => root.unmount()); window.close();
        delete globalThis.window; delete globalThis.document;
    }
});

test('the patched native root preserves the initialized hidden header while account providers and router remount', async () => {
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    const files = new Map();
    const readUpstream = path => execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/${path}`], { encoding: 'utf8' });
    const replace = async (path, before, after) => {
        const source = files.get(path) ?? readUpstream(path);
        assert.equal(source.split(before).length, 2, `exact pinned source anchor: ${path}`);
        files.set(path, source.replace(before, after));
    };
    // Match build order so the root/header test executes the actual combined
    // startup, routing and account-lifecycle patches, not a synthetic tree.
    await patchNativeIntegration(replace);
    await patchNativeStartup(replace);
    await patchAccountView(replace);
    assert.ok(!files.get('src/RootAppRouter.tsx').includes('AppHeader'), 'the account-owned router must not own another hidden header');

    const { window } = new JSDOM('<div id="root"></div>', { url: 'https://fixture.invalid' });
    globalThis.window = window; globalThis.document = window.document;
    const { createRoot } = nativeRequire('react-dom/client');
    const { flushSync } = nativeRequire('react-dom');
    const evaluate = (source, resolver) => {
        const exports = {};
        const compiled = ts.transpileModule(source, { compilerOptions: {
            module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
            target: ts.ScriptTarget.ES2022, esModuleInterop: true
        } }).outputText;
        vm.runInNewContext(compiled, { exports, window: { Proxy: undefined }, require: resolver });
        return exports.default;
    };
    const AccountView = evaluate(await readFile(new URL('../src/AccountView.js', import.meta.url), 'utf8'), name => name === 'react' ? React : state);
    let menuImports = 0; let menuInitialized = false; let retainedTabs;
    const AppHeader = evaluate(readUpstream('src/components/AppHeader.tsx'), name => {
        if (name === 'react') return React;
        assert.equal(name, '../scripts/libraryMenu');
        menuImports++;
        // Native libraryMenu initializes and retains this DOM once per document.
        if (!menuInitialized) {
            menuInitialized = true;
            retainedTabs = window.document.createElement('div');
            retainedTabs.className = 'headerTabs';
            window.document.querySelector('.skinHeader').appendChild(retainedTabs);
        }
        return {};
    });
    let account = 'first'; let providerMounts = 0; let providerDisposals = 0; let routerMounts = 0; let routerDisposals = 0;
    const passThrough = ({ children }) => children;
    function ApiProvider({ children }) {
        React.useEffect(() => { providerMounts++; return () => { providerDisposals++; }; }, []);
        return React.createElement('section', { 'data-account': account }, children);
    }
    function Router() {
        React.useEffect(() => { routerMounts++; return () => { routerDisposals++; }; }, []);
        return React.createElement('main', null, account);
    }
    const RootApp = evaluate(files.get('src/RootApp.tsx'), name => {
        if (name === 'react') return React;
        if (name === 'discordActivity/AccountView') return AccountView;
        if (name === 'components/AppHeader') return AppHeader;
        if (name === 'RootAppRouter') return Router;
        if (name === '@tanstack/react-query') return { QueryClientProvider: passThrough };
        if (name === '@tanstack/react-query-devtools') return { ReactQueryDevtools: () => null };
        if (name === 'components/QueryClientEventHandler') return () => null;
        if (name === 'hooks/useApi') return { ApiProvider };
        if (name === 'hooks/useUserSettings') return { UserSettingsProvider: passThrough };
        if (name === 'hooks/useWebConfig') return { WebConfigProvider: passThrough };
        if (name === 'scripts/browser') return { tv: false };
        if (name === 'utils/query/queryClient') return { queryClient: {} };
        throw new Error(`Unexpected patched native root import: ${name}`);
    });
    const root = createRoot(window.document.getElementById('root'));
    const settle = () => new Promise(resolve => setImmediate(resolve));
    try {
        flushSync(() => root.render(React.createElement(RootApp)));
        await settle();
        const header = window.document.querySelector('.skinHeader');
        const firstPage = window.document.querySelector('main');
        assert.ok(header && retainedTabs?.isConnected);
        assert.equal(header.parentElement.style.display, 'none');
        assert.equal(menuImports, 1); assert.equal(providerMounts, 1); assert.equal(routerMounts, 1);
        flushSync(state.beginAccountViewChange);
        assert.equal(window.document.querySelector('main'), null);
        assert.equal(providerDisposals, 1); assert.equal(routerDisposals, 1);
        assert.equal(window.document.querySelector('.skinHeader'), header);
        assert.equal(window.document.querySelector('.headerTabs'), retainedTabs);
        assert.equal(retainedTabs.isConnected, true, 'cached native header tabs stay attached while login changes');
        account = 'second';
        flushSync(state.finishAccountViewChange);
        await settle();
        assert.notEqual(window.document.querySelector('main'), firstPage);
        assert.equal(window.document.querySelector('main').textContent, 'second');
        assert.equal(providerMounts, 2); assert.equal(routerMounts, 2);
        assert.equal(window.document.querySelector('.skinHeader'), header);
        assert.equal(window.document.querySelector('.headerTabs'), retainedTabs);
        assert.equal(window.document.querySelectorAll('.skinHeader').length, 1);
        assert.equal(menuImports, 1, 'account replacement cannot rerun the one-time native menu initialization');
    } finally {
        flushSync(() => root.unmount()); await settle(); window.close();
        delete globalThis.window; delete globalThis.document;
    }
});
