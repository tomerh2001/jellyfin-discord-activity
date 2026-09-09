import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createNativeUi } from '../src/uiCore.js';
import { createModernComponents } from '../src/uiComponents.js';

const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');
// CI prepares the pinned native source and its exact React/MUI dependencies
// before running these tests. Exercise those real components, not a mock UI.
const nativeRequire = createRequire(new URL('../.build/source/package.json', import.meta.url));
const { window } = new JSDOM('<body></body>', { url: 'https://activity.example.com' });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver']) {
    Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true });
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = nativeRequire('react');
const { createRoot } = nativeRequire('react-dom/client');
const mui = nativeRequire('@mui/material');
const { ThemeProvider, createTheme } = nativeRequire('@mui/material/styles');
const Components = createModernComponents(React, mui);
const theme = createTheme({ palette: { mode: 'dark' } });
const connection = { id: 'saved-1', serverId: 'server-1', serverUrl: 'https://jellyfin.example.com',
    serverName: 'My Jellyfin', jellyfinUsername: 'Viewer', kind: 'personal' };
const data = { connections: [connection], defaultServerUrl: connection.serverUrl, communityAvailable: true };
const flush = () => React.act(async () => { await new Promise(resolve => setImmediate(resolve)); });

function fixture() {
    const timers = new Map();
    const toasts = [];
    let timerId = 0;
    const controller = createNativeUi({ toast: value => toasts.push(value), now: () => 1000,
        setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id) });
    window.addEventListener('command', controller.handleCommand, true);
    const ui = Object.fromEntries(Object.entries(controller).map(([name, method]) => [name, (...args) => {
        let result; React.act(() => { result = method(...args); }); return result;
    }]));
    const element = document.createElement('div'); document.body.appendChild(element);
    const root = createRoot(element);
    React.act(() => root.render(React.createElement(ThemeProvider, { theme }, React.createElement(Components, { controller }))));
    const f = { ui, controller, window, document, timers, toasts,
        button: text => [...document.querySelectorAll('button')].find(button => button.textContent === text),
        click: node => React.act(() => node.click()),
        dialog: () => document.querySelector('[role="dialog"]'),
        tick() { React.act(() => { const entry = timers.entries().next().value; if (entry) { timers.delete(entry[0]); entry[1](); } }); },
        close() { window.removeEventListener('command', controller.handleCommand, true); React.act(() => root.unmount()); element.remove(); document.body.replaceChildren(); } };
    return f;
}

test('Modern MUI account dialog escapes labels and prevents unrelated server selection', async () => {
    const f = fixture();
    try {
        const dangerous = { ...connection, serverName: '<img src=x onerror=alert(1)>', jellyfinUsername: '<script>bad()</script>' };
        const result = f.ui.chooseAccount({ data: { ...data, connections: [dangerous, { ...connection, id: 'other', serverUrl: 'https://elsewhere.example.com' }] },
            party: { serverId: connection.serverId, serverUrl: connection.serverUrl } });
        assert.equal(f.document.querySelector('script, img'), null);
        assert.match(f.document.body.textContent, /<img src=x onerror=alert\(1\)>/);
        assert.equal(f.document.querySelector('[name="serverUrl"]').readOnly, true);
        assert.equal(f.document.querySelectorAll('.discordModernAccount')[1].getAttribute('aria-disabled'), 'true');
        assert.equal(f.document.querySelectorAll('.MuiTextField-root').length, 3);
        assert.equal(f.document.querySelectorAll('[is="emby-input"], [is="emby-button"] ').length, 0);
        f.click(f.document.querySelector('.discordModernAccount'));
        assert.equal(await result, dangerous);
    } finally { f.close(); }
});

test('login preserves password bytes, prevents duplicate submit and clears credentials on close', async () => {
    const f = fixture();
    try {
        let resolveLogin;
        const requests = [];
        const result = f.ui.chooseAccount({ data, onConnect: input => {
            requests.push(input); return new Promise(resolve => { resolveLogin = resolve; });
        } });
        const form = f.document.querySelector('form');
        const password = form.elements.namedItem('password');
        form.elements.namedItem('username').value = ' Viewer ';
        password.value = '  password stays verbatim  ';
        React.act(() => {
            form.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
            form.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
        });
        assert.equal(requests.length, 1);
        assert.equal(requests[0].password, '  password stays verbatim  ');
        assert.equal(requests[0].username, 'Viewer');
        assert.equal(f.dialog().getAttribute('aria-busy'), 'true');
        await React.act(async () => resolveLogin(connection));
        assert.equal(await result, connection);
        assert.equal(password.value, '');
    } finally { f.close(); }
});

test('community access requires an explicit click and is absent for a different party server', async () => {
    const f = fixture();
    try {
        let calls = 0;
        const result = f.ui.chooseAccount({ data, onCommunity: async () => { calls++; return connection; } });
        assert.equal(calls, 0);
        f.click(f.button('Use community account')); await flush();
        assert.equal(await result, connection); assert.equal(calls, 1);
        const next = f.ui.chooseAccount({ data, party: { serverId: 'other', serverUrl: 'https://other.example.com' }, onCommunity: async () => connection });
        assert.equal(f.button('Use community account'), undefined);
        f.click(f.button('Back to watching')); assert.equal(await next, null);
    } finally { f.close(); }
});

test('refresh failures can retry; remove refreshes accounts without selecting one', async () => {
    const f = fixture();
    try {
        const deleted = []; let fail = true;
        const result = f.ui.chooseAccount({ data, onDelete: async id => deleted.push(id), onRefresh: async () => {
            if (fail) throw new Error('The server is temporarily unavailable.');
            return { ...data, connections: [] };
        } });
        f.click(f.button('Refresh saved accounts')); await flush();
        assert.equal(f.dialog().getAttribute('aria-busy'), 'false');
        assert.equal(f.document.querySelector('[role="status"]'), null);
        assert.match(f.document.querySelector('[role="alert"]').textContent, /The server is temporarily unavailable\./);
        fail = false; f.click(f.button('Remove')); await flush();
        assert.deepEqual(deleted, ['saved-1']);
        assert.equal(f.document.querySelector('.discordModernAccount'), null);
        assert.ok(f.dialog());
        f.click(f.button('Back to watching')); assert.equal(await result, null);
    } finally { f.close(); }
});

test('Quick Connect validates URL before starting and polls sequentially; close aborts stale polls', async () => {
    const f = fixture();
    try {
        let pollSignal; let resolvePoll; let polls = 0; let starts = 0;
        const result = f.ui.chooseAccount({ data,
            onQuickStart: async serverUrl => { starts++; assert.equal(serverUrl, connection.serverUrl); return { id: 'quick-1', code: '123456', expiresAt: new Date(10_000).toISOString() }; },
            onQuickPoll: (_id, signal) => { polls++; pollSignal = signal; return new Promise(resolve => { resolvePoll = resolve; }); } });
        const url = f.document.querySelector('[name="serverUrl"]');
        url.value = 'not a URL'; f.click(f.button('Use Quick Connect')); assert.equal(starts, 0);
        url.value = connection.serverUrl; f.click(f.button('Use Quick Connect')); await flush();
        assert.equal(f.document.querySelector('.discordModernQuickCode').textContent, '123456');
        assert.equal(f.button('Sign in').disabled, true);
        f.tick(); f.tick(); assert.equal(polls, 1); assert.equal(f.timers.size, 0);
        f.click(f.button('Back to watching')); assert.equal(await result, null); assert.equal(pollSignal.aborted, true);
        await React.act(async () => resolvePoll({ status: 'connected', connection }));
        assert.equal(f.dialog(), null); assert.equal(f.timers.size, 0);
    } finally { f.close(); }
});

test('Quick Connect pending then success chooses the account; expired codes allow retry', async () => {
    const f = fixture();
    try {
        let polls = 0;
        const result = f.ui.chooseAccount({ data,
            onQuickStart: async () => ({ id: 'quick-2', code: '654321', expiresAt: new Date(10_000).toISOString() }),
            onQuickPoll: async () => ++polls === 1 ? { status: 'pending' } : { status: 'connected', connection } });
        f.click(f.button('Use Quick Connect')); await flush();
        f.tick(); await flush(); assert.equal(f.timers.size, 1);
        f.tick(); await flush(); assert.equal(await result, connection);
        const expired = f.ui.chooseAccount({ data,
            onQuickStart: async () => ({ id: 'quick-old', code: '000000', expiresAt: new Date(100).toISOString() }),
            onQuickPoll: async () => { throw new Error('Expired codes must not be polled'); } });
        f.click(f.button('Use Quick Connect')); await flush(); f.tick(); await flush();
        assert.match(f.document.querySelector('[role="alert"]').textContent, /expired/);
        assert.equal(f.button('Use Quick Connect').disabled, false);
        f.click(f.button('Back to watching')); await expired;
    } finally { f.close(); }
});

test('Quick Connect cancel aborts the request and late completion cannot replace a new attempt', async () => {
    const f = fixture();
    try {
        let resolvePoll; let signal; let starts = 0;
        const result = f.ui.chooseAccount({ data,
            onQuickStart: async () => ({ id: `quick-${++starts}`, code: String(starts), expiresAt: new Date(10_000).toISOString() }),
            onQuickPoll: (_id, pollSignal) => { signal = pollSignal; return new Promise(resolve => { resolvePoll = resolve; }); } });
        f.click(f.button('Use Quick Connect')); await flush(); f.tick();
        f.click(f.button('Cancel Quick Connect')); assert.equal(signal.aborted, true);
        f.click(f.button('Use Quick Connect')); await flush();
        await React.act(async () => resolvePoll({ status: 'connected', connection }));
        assert.equal(f.document.querySelector('.discordModernQuickCode').textContent, '2');
        assert.ok(f.dialog());
        f.click(f.button('Back to watching')); await result;
    } finally { f.close(); }
});

test('server change requires confirmation; native MUI menu invokes only the selected action in the click stack', async () => {
    const f = fixture();
    try {
        const cancelled = f.ui.confirmServerChange(connection);
        f.click(f.button('Keep current server')); assert.equal(await cancelled, false);
        const confirmed = f.ui.confirmServerChange(connection);
        f.click(f.button('Change server')); assert.equal(await confirmed, true);
        let calls = 0;
        const menu = f.ui.showWatchMenu({ status: 'Watching together', onInvite: () => { calls++; }, onAccounts: () => { throw new Error('Must not select accounts'); }, onSyncSettings() {} });
        assert.equal(calls, 0);
        const items = [...f.document.querySelectorAll('[role="menuitem"]')];
        assert.equal(items.some(item => /fullscreen/i.test(item.textContent)), false);
        assert.ok(items.some(item => /SyncPlay settings/.test(item.textContent)));
        f.click(items.find(item => /Invite friends/.test(item.textContent)));
        assert.equal(calls, 1); await menu;
    } finally { f.close(); }
});

test('startup retry serializes clicks and shows retryable failures; loading has no header', async () => {
    const f = fixture();
    try {
        let calls = 0;
        const dialog = f.ui.showStartupError({ message: 'Could not load your accounts.', onRetry: async () => {
            if (++calls === 1) throw new Error('Still unavailable.');
        } });
        f.click(f.button('Try again')); await flush();
        assert.match(f.document.querySelector('[role="alert"]').textContent, /Still unavailable\./);
        assert.equal(f.dialog().getAttribute('aria-busy'), 'false');
        f.click(f.button('Try again')); await flush(); await dialog;
        assert.equal(calls, 2); assert.equal(f.dialog(), null);
        const loading = f.ui.showLoading('Loading your accounts…');
        assert.equal(f.dialog().getAttribute('aria-busy'), 'true');
        assert.equal(f.dialog().querySelector('.MuiDialogTitle-root'), null);
        React.act(() => { loading.close(); loading.close(); }); assert.equal(f.dialog(), null);
        f.ui.showStartupError({ message: 'Close this Activity and open it again.' });
        assert.equal(f.button('Try again'), undefined);
    } finally { f.close(); }
});

test('required chooser blocks escape and external abort still clears credentials during pending sign-in', async () => {
    const f = fixture();
    try {
        const controller = new AbortController(); let resolveLogin;
        const result = f.ui.chooseAccount({ data, canCancel: false, signal: controller.signal,
            onConnect: () => new Promise(resolve => { resolveLogin = resolve; }) });
        assert.equal(f.button('Back to watching'), undefined);
        React.act(() => f.dialog().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        assert.ok(f.dialog());
        const back = new window.CustomEvent('command', { detail: { command: 'back' }, bubbles: true, cancelable: true });
        React.act(() => f.dialog().dispatchEvent(back));
        assert.equal(back.defaultPrevented, true); assert.ok(f.dialog());
        const form = f.document.querySelector('form'); const password = form.elements.namedItem('password');
        form.elements.namedItem('username').value = 'Viewer'; password.value = 'secret';
        React.act(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
        React.act(() => controller.abort()); assert.equal(await result, null);
        assert.equal(password.value, ''); assert.equal(f.dialog(), null);
        await React.act(async () => resolveLogin(connection)); assert.equal(f.dialog(), null);
    } finally { f.close(); }
});

test('permission uses an actual MUI button and preserves direct gesture plus update and cleanup', () => {
    const f = fixture();
    try {
        let played = false;
        const handle = f.ui.mountPlaybackPermission({ label: 'Tap to play on this device', onActivate: () => { played = true; } });
        const button = f.button('Tap to play on this device');
        assert.ok(button.classList.contains('MuiButton-root'));
        assert.equal(f.dialog().querySelector('.MuiDialogTitle-root').textContent, 'Join playback');
        f.click(button); assert.equal(played, true);
        React.act(() => handle.update({ disabled: true })); assert.equal(button.disabled, true);
        React.act(() => handle.update({ disabled: false, label: 'Try playing again' }));
        assert.equal(button.textContent, 'Try playing again'); assert.equal(button.disabled, false);
        React.act(() => { handle.close(); handle.close(); }); assert.equal(f.dialog(), null);
    } finally { f.close(); }
});


test('native Back dismisses only the top cancellable dialog and never reaches the underlying page', async () => {
    const f = fixture();
    try {
        let underlyingBacks = 0;
        const underlying = () => { underlyingBacks++; };
        document.addEventListener('command', underlying);
        const chooser = f.ui.chooseAccount({ data });
        const confirmation = f.ui.confirmServerChange(connection);
        const back = () => new window.CustomEvent('command', { detail: { command: 'back' }, bubbles: true, cancelable: true });
        React.act(() => f.document.querySelectorAll('[role="dialog"]')[1].dispatchEvent(back()));
        assert.equal(await confirmation, false); assert.ok(f.dialog());
        React.act(() => f.dialog().dispatchEvent(back())); assert.equal(await chooser, null);
        assert.equal(underlyingBacks, 0); document.removeEventListener('command', underlying);
    } finally { f.close(); }
});
