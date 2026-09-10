import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { patchLoginPage } from '../loginPatch.mjs';
import { mountLoginPage } from '../src/loginPageCore.js';

const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const defaults = { defaultServerUrl: 'https://media.example', partyServerUrl: null, communityAvailable: true };

async function patchedSources() {
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    const files = new Map();
    await patchLoginPage(async (path, before, after) => {
        const source = files.get(path) ?? execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/${path}`], { encoding: 'utf8' });
        assert.equal(source.split(before).length, 2, `exact pinned upstream anchor: ${path}`);
        files.set(path, source.replace(before, after));
    });
    return files;
}
const sources = await patchedSources();
const markup = sources.get('src/apps/legacy/controllers/session/login/index.html');

function fixture(overrides = {}, getRuntime) {
    const { window } = new JSDOM(markup, { url: 'https://activity.example/#/login' });
    const document = window.document;
    const view = document.querySelector('#loginPage');
    const logins = [];
    let optionsCalls = 0;
    const runtime = {
        getLoginOptions: async () => { optionsCalls++; return defaults; },
        loginJellyfin: async (input, current) => logins.push({ input, snapshot: input && { ...input }, current }),
        ...overrides
    };
    const field = selector => view.querySelector(selector);
    const f = { window, view, runtime, logins, field, get optionsCalls() { return optionsCalls; },
        form: field('.manualLoginForm'), server: field('#txtActivityServer'), username: field('#txtManualName'),
        password: field('#txtManualPassword'), community: field('.btnCommunity'), status: field('.activityLoginStatus'),
        retry: field('.btnLoginRetry'),
        event: name => view.dispatchEvent(new window.Event(name)),
        submit: () => {
            const event = new window.Event('submit', { bubbles: true, cancelable: true });
            f.form.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
        },
        close: () => { f.event('viewdestroy'); window.close(); }
    };
    mountLoginPage(view, getRuntime || (() => Promise.resolve(runtime)));
    return f;
}

test('login patch retains the upstream form and native components with only explicit personal or community login', () => {
    const { window } = new JSDOM(markup);
    try {
        const document = window.document;
        assert.equal(document.querySelectorAll('form').length, 1);
        assert.equal(document.querySelector('.manualLoginForm').classList.contains('hide'), false);
        for (const name of ['txtActivityServer', 'txtManualName', 'txtManualPassword']) {
            assert.equal(document.getElementById(name).getAttribute('is'), 'emby-input');
        }
        assert.equal(document.getElementById('txtActivityServer').type, 'url');
        assert.equal(document.getElementById('txtManualPassword').type, 'password');
        assert.equal(document.getElementById('txtManualPassword').autocomplete, 'current-password');
        assert.equal(document.querySelector('[type=submit]').getAttribute('is'), 'emby-button');
        assert.equal(document.querySelector('.btnCommunity').type, 'button');
        assert.equal(document.querySelectorAll('iframe,.visualLoginForm,.chkRememberLogin,.btnCancel,.btnQuick,.btnSelectServer').length, 0);
        assert.equal(document.querySelector('.activityLoginStatus').getAttribute('aria-live'), 'polite');
    } finally { window.close(); }
});

test('the native login controller hides the router spinner on viewshow while options are still loading', async () => {
    const ts = createRequire(import.meta.url)('typescript');
    const source = await readFile(new URL('../src/loginPage.js', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const { window } = new JSDOM(markup);
    const view = window.document.querySelector('#loginPage');
    const options = deferred();
    let visible = true; let hides = 0;
    const exports = {};
    vm.runInNewContext(compiled, { exports, require(name) {
        if (name === 'components/loading/loading') return { default: { hide() { visible = false; hides++; } } };
        if (name === './loginPageCore') return { mountLoginPage };
        if (name === './runtime') return { getLoginOptions: () => options.promise, loginJellyfin: assert.fail };
        throw new Error(`Unexpected login import: ${name}`);
    } });
    try {
        exports.default(view);
        assert.equal(visible, true, 'the router owns its loading indicator until its view is shown');
        view.dispatchEvent(new window.Event('viewshow'));
        assert.equal(visible, false); assert.equal(hides, 1);
        await flush();
        assert.equal(view.querySelector('#txtManualName').disabled, true, 'pending options remain represented by the form');
        assert.equal(view.querySelector('.activityLoginStatus').textContent, 'Connecting…');
        options.resolve(defaults); await flush();
        assert.equal(view.querySelector('#txtManualName').disabled, false);
        visible = true;
        view.dispatchEvent(new window.Event('viewbeforehide'));
        view.dispatchEvent(new window.Event('viewshow'));
        assert.equal(visible, false); assert.equal(hides, 2, 'reopening the cached native login also hides the router spinner');
    } finally { options.resolve(defaults); view.dispatchEvent(new window.Event('viewdestroy')); window.close(); }
});

test('native splash branding skips unauthenticated login and rejects a late response from a replaced API', async () => {
    const source = sources.get('src/scripts/autoBackdrops.js');
    const body = source.match(/async function showSplashScreen\(\) \{([\s\S]*?)\n\}/)[1];
    let api;
    let clears = 0;
    const images = [];
    const queries = [];
    const delayed = deferred();
    const queryClient = { fetchQuery(query) { queries.push(query); return delayed.promise; } };
    const show = new Function('ServerConnections', 'queryClient', 'getBrandingOptionsQuery', 'clearBackdrop', 'setBackdropImages', 'SPLASHSCREEN_URL',
        `return async function () {${body}\n};`)(
        { getApi: () => api }, queryClient, value => { assert.ok(value, 'branding queries require an authenticated API'); return { api: value }; },
        () => { clears++; }, value => images.push(value), '/Branding/Splashscreen');
    await assert.doesNotReject(show());
    assert.equal(clears, 1); assert.equal(queries.length, 0, 'first login must not issue a branding request without an API');
    const oldApi = { getUri: assert.fail };
    api = oldApi;
    const stale = show();
    assert.equal(queries[0].api, oldApi);
    api = undefined;
    delayed.resolve({ SplashscreenEnabled: true });
    await assert.doesNotReject(stale);
    assert.equal(images.length, 0); assert.equal(clears, 1, 'late branding must not alter the new login backdrop');
    api = { getUri: path => `https://current.example${path}` };
    await show();
    assert.deepEqual(images, [['https://current.example/Branding/Splashscreen']], 'the current authenticated API still renders native branding');
});

test('first opening only loads login options; explicit submit preserves password whitespace and clears it afterwards', async () => {
    const waiting = deferred();
    const options = deferred();
    let captured;
    let attempts = 0;
    const f = fixture({ getLoginOptions: () => options.promise,
        loginJellyfin: async (input, current) => { attempts++; captured = { input, snapshot: { ...input }, current }; await waiting.promise; } });
    try {
        f.submit(); assert.equal(captured, undefined);
        assert.equal(f.server.disabled, true);
        options.resolve(defaults); await flush();
        assert.equal(f.server.value, defaults.defaultServerUrl);
        assert.equal(f.server.readOnly, false);
        assert.equal(f.server.disabled, false);
        assert.equal(captured, undefined, 'saved metadata cannot silently authenticate a first visit');
        f.server.value = ' https://other.example/library ';
        f.username.value = ' viewer ';
        f.password.value = '  private password  ';
        f.submit(); f.submit();
        assert.equal(f.password.value, '', 'clear the password field synchronously');
        await flush();
        assert.equal(attempts, 1, 'repeated clicks cannot send duplicate password requests');
        assert.deepEqual(captured.snapshot, { serverUrl: 'https://other.example/library', username: 'viewer', password: '  private password  ' });
        assert.equal(captured.current(), true);
        assert.equal(f.username.disabled, true);
        waiting.resolve(); await flush();
        assert.equal(captured.input.password, '', 'release the captured password once the broker finishes');
        assert.equal(f.username.disabled, false);
    } finally { waiting.resolve(); f.close(); }
});

test('community login needs its own explicit click and never sends typed personal credentials', async () => {
    const f = fixture();
    try {
        await flush(); assert.equal(f.logins.length, 0);
        assert.equal(f.community.classList.contains('hide'), false);
        f.username.value = 'personal user'; f.password.value = 'personal password';
        f.community.click(); await flush();
        assert.equal(f.logins.length, 1);
        assert.equal(f.logins[0].input, null);
        assert.equal(f.password.value, '');
        assert.equal(f.logins[0].current(), true);
    } finally { f.close(); }
    const unavailable = fixture({ getLoginOptions: async () => ({ ...defaults, communityAvailable: false }) });
    try {
        await flush(); assert.equal(unavailable.community.classList.contains('hide'), true);
        unavailable.community.click(); await flush();
        assert.equal(unavailable.logins.length, 0, 'a hidden/unavailable community action cannot be invoked programmatically');
    } finally { unavailable.close(); }
});

test('a party locks the actual submitted server while leaving credentials editable', async () => {
    const partyServerUrl = 'https://party.example/jellyfin';
    const f = fixture({ getLoginOptions: async () => ({ ...defaults, partyServerUrl }) });
    try {
        await flush();
        assert.equal(f.server.value, partyServerUrl); assert.equal(f.server.readOnly, true);
        assert.equal(f.username.disabled, false); assert.match(f.status.textContent, /join this watch party/);
        f.server.value = 'https://another.example'; f.username.value = 'viewer'; f.submit(); await flush();
        assert.equal(f.logins[0].snapshot.serverUrl, partyServerUrl);
    } finally { f.close(); }
});

test('options failure exposes one native retry and a successful retry enables the same form', async () => {
    let attempts = 0;
    const f = fixture({ getLoginOptions: async () => { if (++attempts === 1) throw new Error('offline'); return defaults; } });
    try {
        await flush(); assert.match(f.status.textContent, /Could not connect/);
        assert.equal(f.retry.classList.contains('hide'), false); assert.equal(f.username.disabled, true);
        f.retry.click(); await flush();
        assert.equal(attempts, 2); assert.equal(f.retry.classList.contains('hide'), true);
        assert.equal(f.username.disabled, false); assert.equal(f.logins.length, 0);
    } finally { f.close(); }
});

test('failed authentication clears the attempted password and permits an explicit retry', async () => {
    const inputs = [];
    const f = fixture({ loginJellyfin: async input => {
        inputs.push(input); if (inputs.length === 1) throw new Error('Check your Jellyfin password.');
    } });
    try {
        await flush(); f.username.value = 'viewer'; f.password.value = 'wrong'; f.submit(); await flush();
        assert.equal(f.status.textContent, 'Check your Jellyfin password.');
        assert.equal(f.password.value, ''); assert.equal(inputs[0].password, ''); assert.equal(f.username.disabled, false);
        f.password.value = 'replacement'; f.submit(); await flush();
        assert.equal(inputs.length, 2); assert.equal(inputs[1].password, '');
    } finally { f.close(); }
});

test('login rejection refreshes the party server once and preserves the error and username', async () => {
    const partyServerUrl = 'https://new-party.example';
    let optionsCalls = 0;
    const inputs = [];
    const message = 'This party is using another Jellyfin server.';
    const f = fixture({
        getLoginOptions: async () => ++optionsCalls === 1 ? defaults : { ...defaults, partyServerUrl, communityAvailable: false },
        loginJellyfin: async input => { inputs.push({ ...input }); if (inputs.length === 1) throw new Error(message); }
    });
    try {
        await flush(); f.username.value = 'viewer'; f.password.value = 'private'; f.submit(); await flush();
        assert.equal(optionsCalls, 2); assert.equal(inputs.length, 1, 'refreshing options cannot retry credentials automatically');
        assert.equal(f.status.textContent, message); assert.equal(f.username.value, 'viewer'); assert.equal(f.password.value, '');
        assert.equal(f.server.value, partyServerUrl); assert.equal(f.server.readOnly, true);
        assert.equal(f.community.classList.contains('hide'), true); assert.equal(f.username.disabled, false);
        f.password.value = 'replacement'; f.submit(); await flush();
        assert.equal(inputs[1].serverUrl, partyServerUrl); assert.equal(optionsCalls, 2);
    } finally { f.close(); }
});

test('a failed post-login options refresh stops and offers manual Retry without resending credentials', async () => {
    let optionsCalls = 0; let attempts = 0;
    const f = fixture({
        getLoginOptions: async () => { if (++optionsCalls === 2) throw new Error('offline'); return defaults; },
        loginJellyfin: async () => { attempts++; throw new Error('Check your Jellyfin password.'); }
    });
    try {
        await flush(); f.username.value = 'viewer'; f.password.value = 'private'; f.submit(); await flush(); await flush();
        assert.equal(optionsCalls, 2); assert.equal(attempts, 1);
        assert.match(f.status.textContent, /Check your Jellyfin password/); assert.match(f.status.textContent, /Could not refresh/);
        assert.equal(f.password.value, ''); assert.equal(f.username.value, 'viewer');
        assert.equal(f.username.disabled, true); assert.equal(f.retry.classList.contains('hide'), false);
        f.submit(); await flush(); assert.equal(optionsCalls, 2); assert.equal(attempts, 1);
        f.retry.click(); await flush();
        assert.equal(optionsCalls, 3); assert.equal(attempts, 1); assert.equal(f.username.disabled, false);
        assert.equal(f.retry.classList.contains('hide'), true);
    } finally { f.close(); }
});

test('hiding the native page before the runtime arrives cancels credential submission', async () => {
    const pending = deferred();
    let imports = 0;
    const f = fixture({}, () => ++imports === 1 ? Promise.resolve().then(() => f.runtime) : pending.promise);
    try {
        await flush(); f.username.value = 'viewer'; f.password.value = 'private'; f.submit();
        f.event('viewbeforehide'); assert.equal(f.password.value, '');
        pending.resolve(f.runtime); await flush(); assert.equal(f.logins.length, 0);
    } finally { pending.resolve(f.runtime); f.close(); }
});

test('hide and reopen cancels old login state without disabling or clearing a newer attempt', async () => {
    const oldCompletion = deferred(); const newCompletion = deferred(); const attempts = [];
    const f = fixture({ loginJellyfin: async (input, current) => {
        const index = attempts.length; attempts.push({ input, current });
        await (index === 0 ? oldCompletion.promise : newCompletion.promise);
    } });
    try {
        await flush(); f.username.value = 'viewer'; f.password.value = 'old'; f.submit(); await flush();
        f.event('viewbeforehide'); assert.equal(attempts[0].current(), false); assert.equal(attempts[0].input.password, '');
        f.event('viewshow'); await flush(); assert.equal(f.username.disabled, false);
        f.password.value = 'new'; f.submit(); await flush(); assert.equal(attempts.length, 2);
        oldCompletion.resolve(); await flush();
        assert.equal(f.username.disabled, true, 'old completion must not release the new attempt controls');
        assert.equal(attempts[1].current(), true);
        newCompletion.resolve(); await flush(); assert.equal(f.username.disabled, false);
        assert.equal(attempts[1].input.password, '');
        f.event('viewdestroy'); assert.equal(attempts[1].current(), false);
    } finally { oldCompletion.resolve(); newCompletion.resolve(); f.close(); }
});

test('a stale options response cannot replace the server of a reopened native page', async () => {
    const oldOptions = deferred(); let calls = 0;
    const f = fixture({ getLoginOptions: () => ++calls === 1 ? oldOptions.promise : Promise.resolve({ ...defaults, defaultServerUrl: 'https://new.example' }) });
    try {
        await flush(); f.event('viewbeforehide'); f.event('viewshow'); await flush();
        assert.equal(f.server.value, 'https://new.example');
        oldOptions.resolve(defaults); await flush(); assert.equal(f.server.value, 'https://new.example');
        assert.equal(f.username.disabled, false);
    } finally { oldOptions.resolve(defaults); f.close(); }
});
