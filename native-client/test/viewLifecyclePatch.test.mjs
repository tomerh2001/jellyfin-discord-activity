import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
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
    patched = files;
    return files;
}

// Model just the native container DOM operations; execute its actual patched
// source and real Promise continuations, with controlled CustomElement timers.
async function fixture() {
    const files = await sources();
    const events = []; const controllers = []; const timers = []; const imports = [];
    let main;
    class Element {
        constructor(attributes = {}) {
            this.attributes = attributes; this.children = []; this.listeners = new Map();
            const classes = new Set();
            this.classList = { add: (...names) => names.forEach(name => classes.add(name)),
                remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) };
        }
        get isConnected() { return this === main || Boolean(this.parentNode?.isConnected); }
        getAttribute(name) { return this.attributes[name] ?? null; }
        setAttribute(name, value) { this.attributes[name] = value; }
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = undefined; }
        replaceChild(child, previous) {
            const index = this.children.indexOf(previous); assert.ok(index >= 0);
            child.remove(); this.children[index] = child; previous.parentNode = undefined; child.parentNode = this;
        }
        remove() { this.parentNode?.removeChild(this); }
        contains(child) { return this === child || this.children.some(node => node.contains(child)); }
        set innerHTML(html) {
            for (const child of this.children) child.parentNode = undefined;
            this.children = [];
            if (html) this.appendChild(new Element(Object.fromEntries([...html.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]))));
        }
        querySelector(selector) { return selector === 'div[data-role="page"]' ? this.children[0] : null; }
        addEventListener(name, listener) { this.listeners.set(name, [...this.listeners.get(name) || [], listener]); }
        dispatchEvent(event) {
            events.push([this.attributes.id, event.type]);
            for (const listener of this.listeners.get(event.type) || []) listener(event);
            return true;
        }
    }
    main = new Element();
    const document = { body: main, activeElement: null, querySelector: () => main,
        createElement: () => new Element(), addEventListener() {} };
    const globals = { document, window: {}, console: { debug() {}, warn() {} }, URLSearchParams,
        CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
        setTimeout: callback => timers.push(callback), ApiClient: { getUrl: value => value } };
    const compile = (path, dependencies) => {
        const exports = {};
        vm.runInNewContext(ts.transpileModule(files.get(path), { compilerOptions: {
            module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
        } }).outputText, { ...globals, exports, require(name) {
            assert.ok(name in dependencies, `Unexpected native view dependency: ${name}`);
            return dependencies[name];
        } });
        return exports.default;
    };
    const container = compile('src/components/viewContainer.js', {
        '@uupaa/dynamic-import-polyfill': { importModule: () => new Promise((resolve, reject) => imports.push({ resolve, reject })) },
        './viewManager/viewContainer.scss': {}, '../utils/dashboard': { default: { getPluginUrl: value => value } }
    });
    const manager = compile('src/components/viewManager/viewManager.js', {
        '../viewContainer': { default: container }, '../focusManager': { default: { autoFocus() {}, focus() {}, isCurrentlyFocusable: () => true } },
        '../layoutManager': { default: { mobile: false } }
    });
    const options = (name, isCurrent = () => true) => ({ url: `/${name}`, view: `<div data-role="page" id="${name}"></div>`,
        get cancel() { return !isCurrent(); }, autoFocus: false,
        controllerFactory: function () { controllers.push(name); } });
    const flush = async () => { await tick(); while (timers.length) { timers.shift()(); await tick(); } };
    const load = async (name, isCurrent) => { const pending = manager.loadView(options(name, isCurrent)); await flush(); await pending; return manager.currentView(); };
    return { files, main, events, controllers, timers, imports, container, manager, options, load, flush, compile };
}

test('cancelled pending native loads stay hidden, settle and cannot initialize or show their old route', async () => {
    const f = await fixture(); let active = true;
    const pending = f.manager.loadView(f.options('login', () => active));
    const old = f.main.children[0];
    assert.ok(old.classList.contains('hide'), 'pending content cannot flash over the current route');
    active = false;
    await f.flush(); await pending;
    assert.equal(old.isConnected, false);
    assert.deepEqual(f.controllers, []);
    assert.deepEqual(f.events, []);
    const home = await f.load('home');
    assert.equal(home.getAttribute('id'), 'home');
    assert.equal(home.classList.contains('hide'), false);
    assert.deepEqual(f.controllers, ['home']);
    assert.equal(f.events.filter(([name, event]) => name === 'home' && event === 'pageshow').length, 1);
});

test('account cache reset invalidates a late load without changing the replacement view or emitting stale events', async () => {
    const f = await fixture();
    const old = f.manager.loadView(f.options('login'));
    const detached = f.main.children[0];
    await tick(); assert.equal(f.timers.length, 1);
    f.container.reset();
    const replacement = f.manager.loadView(f.options('home'));
    await f.flush(); await old; await replacement;
    assert.equal(detached.isConnected, false);
    assert.deepEqual(f.controllers, ['home']);
    assert.equal(f.main.children.length, 1);
    assert.equal(f.manager.currentView().getAttribute('id'), 'home');
    assert.equal(f.events.some(([name]) => name === 'login'), false);
});

test('an already cancelled route cannot append a view and reset inside controller initialization cannot emit old events', async () => {
    const f = await fixture();
    await f.manager.loadView(f.options('cancelled', () => false));
    assert.equal(f.main.children.length, 0);
    const options = f.options('login');
    options.controllerFactory = function () {
        assert.equal(f.main.children[0].classList.contains('hide'), false,
            'current controllers retain native visible layout during initialization');
        f.container.reset();
    };
    const pending = f.manager.loadView(options);
    await f.flush(); await pending;
    assert.equal(f.main.children.length, 0);
    assert.deepEqual(f.events, [['login', 'viewdestroy']], 'an initialized cancelled controller is cleaned up exactly once');
    assert.equal(f.manager.currentView(), undefined);
});

test('cancelled cached restores do not hide the current view and valid restores reuse their existing controller', async () => {
    const f = await fixture();
    const library = await f.load('library');
    const home = await f.load('home');
    let active = true; f.events.length = 0;
    const cancelled = f.manager.tryRestoreView(f.options('library', () => active));
    const rejected = assert.rejects(cancelled, error => error?.cancelled === true);
    active = false; await rejected;
    assert.equal(f.manager.currentView(), home);
    assert.deepEqual(f.events, []);
    assert.equal(home.classList.contains('hide'), false);
    assert.equal(library.classList.contains('hide'), true);
    await f.manager.tryRestoreView(f.options('library'));
    assert.equal(f.manager.currentView(), library);
    assert.equal(library.classList.contains('hide'), false);
    assert.equal(home.classList.contains('hide'), true);
    assert.deepEqual(f.controllers, ['library', 'home'], 'restoration keeps the native cached controller');
    assert.equal(f.events.filter(([name, event]) => name === 'library' && event === 'viewshow').length, 1);
});

test('cache reset during restore and cancellation during the final manager continuation suppress old lifecycle events', async () => {
    for (const phase of ['restore', 'manager']) {
        const f = await fixture();
        if (phase === 'restore') {
            await f.load('library'); await f.load('home'); f.events.length = 0;
            const old = f.manager.tryRestoreView(f.options('library'));
            const rejected = assert.rejects(old, error => error?.cancelled === true);
            f.container.reset(); await rejected;
            assert.deepEqual(f.events, [['library', 'viewdestroy'], ['home', 'viewdestroy']]);
        } else {
            const load = f.container.loadView;
            f.container.loadView = options => load(options).then(view => { f.container.reset(); return view; });
            const pending = f.manager.loadView(f.options('login'));
            await f.flush(); await pending;
            assert.equal(f.manager.currentView(), undefined);
            assert.equal(f.events.some(([, event]) => event === 'viewshow' || event === 'pageshow'), false);
        }
    }
});

test('late native controller import rejection after unmount settles without an obsolete error or view', async () => {
    const f = await fixture(); let active = true;
    const options = f.options('plugin', () => active);
    delete options.controllerFactory;
    options.view = '<div data-role="page" id="plugin" data-controller="__plugin/fixture"></div>';
    const pending = f.manager.loadView(options);
    assert.equal(f.imports.length, 1);
    active = false;
    f.imports[0].reject(new Error('old plugin download failed'));
    await pending;
    assert.deepEqual(f.events, []);
    assert.equal(f.main.children.length, 0);
});

test('the native route keeps live cancellation through object spread into an already started container load', async () => {
    const f = await fixture(); let cleanup;
    const Page = f.compile('src/components/viewManager/ViewManagerPage.tsx', {
        history: { Action: { Pop: 'POP' } }, react: { useEffect: effect => { cleanup = effect(); } },
        'react-router-dom': { useLocation: () => ({ pathname: '/login', search: '' }), useNavigationType: () => 'PUSH' },
        'lib/globalize': { default: { translateHtml: html => html.default } },
        'hooks/useApi': { useApi: () => ({}) }, './viewManager': { default: f.manager },
        'constants/appType': { AppType: { Legacy: 'legacy', Dashboard: 'dashboard', Wizard: 'wizard' } },
        '../../apps/legacy/controllers/login': { default: function () { assert.fail('unmounted login controller'); } },
        '../../apps/legacy/controllers/login.html': { default: '<div data-role="page" id="login"></div>' }
    });
    Page({ controller: 'login', view: 'login.html' });
    await tick(); assert.equal(f.main.children.length, 1);
    cleanup();
    await f.flush();
    assert.deepEqual(f.events, []);
    assert.equal(f.main.children.length, 0);
});

test('native view lifecycle patch rejects applying the adaptation twice', async () => {
    const files = await sources();
    await assert.rejects(patchNativeViewLifecycle(async (path, before) => {
        assert.equal(files.get(path).split(before).length, 2, 'fresh upstream anchor required');
    }), /fresh upstream anchor/);
});
