import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { patchAccountView } from '../accountPatch.mjs';

const require = createRequire(import.meta.url);
const nativeRequire = createRequire(new URL('../.build/source/package.json', import.meta.url));
const React = nativeRequire('react');
const ts = require('typescript');
const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function patchedHome() {
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    const files = new Map();
    await patchAccountView(async (path, before, after) => {
        const content = files.get(path) ?? execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/${path}`], { encoding: 'utf8' });
        assert.equal(content.split(before).length, 2, `Exact upstream anchor: ${path}`);
        files.set(path, content.replace(before, after));
    });
    return files.get('src/apps/modern/routes/home.tsx');
}

async function homeFixture({ deferControllers = false } = {}) {
    const source = await patchedHome();
    const { window } = new JSDOM('<div id="root"></div>', { url: 'https://fixture.invalid' });
    globalThis.window = window; globalThis.document = window.document;
    const { createRoot } = nativeRequire('react-dom/client');
    const { flushSync } = nativeRequire('react-dom');
    const errors = []; const controllers = []; const imports = []; const listeners = new Set();
    class Controller {
        constructor(page) {
            assert.ok(page?.isConnected, 'native controllers may only initialize the connected account page');
            this.page = page; this.resumes = 0; this.pauses = 0;
            controllers.push(this);
        }
        onResume() { this.resumes++; }
        onPause() { this.pauses++; }
    }
    const tabs = {
        setTabs(page, _index, _getTabs, _getContainers, _unused, onChange) {
            assert.ok(page?.isConnected);
            onChange({ detail: { selectedTabIndex: '0', previousIndex: null } });
        },
        selectedTabIndex() {}
    };
    const module = { exports: {} };
    // Mock module loading while executing the actual upstream component and all
    // of its hooks, cleanup callbacks, DOM queries, and promise continuations.
    const compiled = ts.transpileModule(source.replace(/\bimport\s*\(/g, 'loadModule('), { compilerOptions: {
        module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true
    } }).outputText;
    vm.runInNewContext(compiled, {
        exports: module.exports, document: window.document,
        console: { error: (...args) => errors.push(args) },
        loadModule(name) {
            if (name.endsWith('/scripts/libraryMenu')) return Promise.resolve({ default: { setTitle() {} } });
            if (name.endsWith('/components/maintabsmanager')) return Promise.resolve(tabs);
            if (name.endsWith('/controllers/hometab')) {
                if (!deferControllers) return Promise.resolve({ default: Controller });
                return new Promise(resolve => imports.push(() => resolve({ default: Controller })));
            }
            throw new Error(`Unexpected native Home dynamic import: ${name}`);
        },
        require(name) {
            if (name === 'react') return React;
            if (name === 'react-router-dom') return { useSearchParams: () => [new URLSearchParams()] };
            if (name.endsWith('/models/base-item-kind')) return { BaseItemKind: { Movie: 'Movie', Series: 'Series', Book: 'Book' } };
            if (name.endsWith('/lib/globalize')) return { translate: value => value };
            if (name.endsWith('/components/backdrop/backdrop')) return { clearBackdrop() {} };
            if (name.endsWith('/components/layoutManager')) return { tv: false };
            if (name.endsWith('/components/Page')) return ({ children, id, className }) => React.createElement('main', { id, className }, children);
            if (name === 'constants/eventType') return { EventType: { HEADER_RENDERED: 'header-rendered' } };
            if (name === 'utils/events') return { on: (_doc, _event, callback) => listeners.add(callback), off: (_doc, _event, callback) => listeners.delete(callback) };
            if (name.includes('/elements/')) return {};
            throw new Error(`Unexpected native Home import: ${name}`);
        }
    });
    const Home = module.exports.default;
    const root = createRoot(window.document.getElementById('root'), { onUncaughtError: error => errors.push(error) });
    const render = () => flushSync(() => root.render(React.createElement(React.Fragment, null,
        React.createElement('header', { className: 'skinHeader' }, React.createElement('div', { className: 'headerTabs' })),
        React.createElement(Home))));
    const remove = () => flushSync(() => root.render(null));
    return {
        window, errors, controllers, imports, listeners, render, remove,
        async dispose() {
            flushSync(() => root.unmount());
            await settle();
            window.close(); delete globalThis.window; delete globalThis.document;
        }
    };
}

test('actual Modern Home cleanup tolerates removal of the account header and pauses its native controller', async () => {
    const fixture = await homeFixture();
    try {
        fixture.render(); await settle();
        assert.equal(fixture.controllers.length, 1);
        assert.equal(fixture.controllers[0].resumes, 1);
        assert.ok(fixture.window.document.querySelector('.skinHeader').classList.contains('noHomeButtonHeader'));
        assert.equal(fixture.listeners.size, 1);
        assert.doesNotThrow(fixture.remove);
        await settle();
        assert.equal(fixture.window.document.querySelector('.skinHeader'), null);
        assert.equal(fixture.controllers[0].pauses, 1);
        assert.equal(fixture.controllers[0].page.isConnected, false);
        assert.equal(fixture.listeners.size, 0);
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.dispose(); }
});

test('actual Modern Home ignores a late controller import for a removed account and initializes only its replacement', async () => {
    const fixture = await homeFixture({ deferControllers: true });
    try {
        fixture.render(); await settle();
        assert.equal(fixture.imports.length, 1);
        assert.equal(fixture.controllers.length, 0);
        fixture.remove(); await settle();
        fixture.render(); await settle();
        assert.equal(fixture.imports.length, 2);
        fixture.imports[0](); await settle();
        assert.equal(fixture.controllers.length, 0, 'the removed account cannot create or resume a controller on the new page');
        fixture.imports[1](); await settle();
        assert.equal(fixture.controllers.length, 1);
        assert.equal(fixture.controllers[0].resumes, 1);
        assert.ok(fixture.controllers[0].page.isConnected);
        assert.equal(fixture.listeners.size, 1, 'only the replacement account retains its header listener');
        assert.deepEqual(fixture.errors, []);
    } finally { await fixture.dispose(); }
});
