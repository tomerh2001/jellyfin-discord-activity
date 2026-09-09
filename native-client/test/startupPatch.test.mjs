import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { patchNativeStartup } from '../startupPatch.mjs';

async function patchedSources() {
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    const files = new Map();
    await patchNativeStartup(async (path, before, after) => {
        const source = files.get(path) ?? execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/${path}`], { encoding: 'utf8' });
        assert.equal(source.split(before).length, 2, 'patch requires the exact verified upstream source');
        files.set(path, source.replace(before, after));
    });
    return files;
}

test('native settings use the configuration compiled in the same release without a startup network round trip', async () => {
    const source = (await patchedSources()).get('src/scripts/settings/webSettings.js');
    const config = { plugins: ['htmlVideoPlayer/plugin', 'syncPlay/plugin'], multiserver: true,
        servers: [], themes: [{ name: 'Dark', id: 'dark', default: true }], menuLinks: [], includeCorsCredentials: false };
    const names = ['getPlugins', 'getMultiServer', 'getServers', 'getThemes', 'getMenuLinks', 'getIncludeCorsCredentials'];
    const getters = new Function('DefaultConfig', '__WEBPACK_SERVE__', 'fetch',
        source.replace(/^import .*;$/gm, '').replaceAll('export ', '') + `\nreturn {${names.join(',')}};`)(config, false, assert.fail);
    const actual = await Promise.all(names.map(name => getters[name]()));
    assert.deepEqual(actual, [config.plugins, true, [], config.themes, [], false]);
    assert.equal(actual[0], config.plugins);
    assert.equal(actual[3], config.themes);
    assert.ok(!source.includes('fetchLocal'));
});

test('native React consumers receive the same packaged config without a fetch or configuration rerender', async () => {
    const source = (await patchedSources()).get('src/hooks/useWebConfig.tsx');
    const ts = createRequire(import.meta.url)('typescript');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
    const config = { multiserver: true, plugins: ['syncPlay/plugin'], themes: [{ id: 'dark' }] };
    const exports = {};
    vm.runInNewContext(compiled, { exports, require(name) {
        if (name === '../config.json') return { default: config };
        if (name === 'react') return {
            default: { createElement: (type, props, children) => ({ type, props, children }) },
            createContext: value => ({ Provider: 'native-config', value }),
            useContext: context => context.value
        };
        throw new Error(`Unexpected config import: ${name}`);
    } });
    assert.equal(exports.useWebConfig(), config);
    const result = exports.WebConfigProvider({ children: 'native child' });
    assert.equal(result.type, 'native-config');
    assert.equal(result.props.value, config);
    assert.equal(result.children, 'native child');
});

test('Jellyfin 12 layout selection retains native legacy controls on desktop, mobile and automatic layouts', async () => {
    const source = (await patchedSources()).get('src/components/layoutManager.js');
    const modes = { Auto: 'auto', Desktop: 'desktop', DesktopLegacy: 'desktop-legacy', Modern: 'modern',
        Mobile: 'mobile', MobileLegacy: 'mobile-legacy', Tv: 'tv' };
    const browser = { mobile: false, tv: false };
    const saved = new Map(); const classes = new Set();
    const code = source.replace(/^import .*;$/gm, '').replace('export const SETTING_KEY', 'const SETTING_KEY')
        .replace('export default layoutManager;', 'return layoutManager;');
    const manager = new Function('LayoutMode', 'browser', 'appHost', 'appSettings', 'Events', 'document', 'console', code)(
        modes, browser, { getDefaultLayout: () => modes.Desktop }, { get: key => saved.get(key), set: (key, value) => saved.set(key, value) },
        { trigger() {} }, { documentElement: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } } }, { debug() {} });
    assert.equal(manager.modern, false); assert.equal(manager.desktop, true);
    manager.setLayout(modes.Modern); assert.equal(manager.modern, false); assert.equal(saved.get('layout'), modes.DesktopLegacy);
    browser.mobile = true; manager.setLayout(modes.Modern); assert.equal(manager.mobile, true); assert.equal(saved.get('layout'), modes.MobileLegacy);
    manager.setLayout(modes.Mobile); assert.equal(manager.modern, false); assert.equal(saved.get('layout'), modes.MobileLegacy);
    manager.setLayout(modes.Auto); assert.equal(manager.modern, false); assert.equal(manager.desktop, true);
    manager.setLayout(modes.Tv); assert.equal(manager.modern, false); assert.equal(manager.tv, true);
    assert.equal(classes.has('layout-tv'), true);
});

test('native query data uses an in-memory provider and never initializes IndexedDB persistence', async () => {
    const files = await patchedSources();
    const ts = createRequire(import.meta.url)('typescript');
    const querySource = files.get('src/utils/query/queryClient.ts');
    const queryExports = {};
    const cache = new Map();
    class QueryClient { clear() { cache.clear(); } }
    vm.runInNewContext(ts.transpileModule(querySource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
        { exports: queryExports, console, require(name) {
            assert.equal(name, '@tanstack/react-query', 'native query construction cannot import an IndexedDB persister');
            return { QueryClient, QueryCache: class {} };
        } });
    cache.set('old-account', { capability: 'private' }); queryExports.queryClient.clear(); assert.equal(cache.size, 0);
    const exports = {};
    const compiled = ts.transpileModule(files.get('src/RootApp.tsx'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
    vm.runInNewContext(compiled, { exports, window: {}, require(name) {
        assert.ok(!/persist|idb/i.test(name), 'native root cannot load a persistent query provider');
        if (name === '@tanstack/react-query') return { QueryClientProvider: 'memory-query-provider' };
        if (name === '@tanstack/react-query-devtools') return { ReactQueryDevtools: 'devtools' };
        if (name === 'utils/query/queryClient') return queryExports;
        if (name === 'scripts/browser') return { default: { tv: false } };
        if (name === 'react') return { default: { createElement: (type, props, ...children) => ({ type, props, children }) } };
        return { default: name, ApiProvider: 'api', UserSettingsProvider: 'settings', WebConfigProvider: 'web-config' };
    } });
    const rendered = exports.default();
    assert.equal(rendered.type, 'memory-query-provider');
    assert.equal(rendered.props.client, queryExports.queryClient);
    assert.equal('persistOptions' in rendered.props, false);
});
