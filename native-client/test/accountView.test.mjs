import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as state from '../src/accountViewState.js';

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
