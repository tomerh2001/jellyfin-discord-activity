import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createNativeUi } from '../src/uiCore.js';

const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');
const connection = { id: 'saved-1', serverId: 'server-1', serverUrl: 'https://jellyfin.example.com',
    serverName: 'My Jellyfin', jellyfinUsername: 'Viewer', kind: 'personal' };
const data = { connections: [connection], defaultServerUrl: connection.serverUrl, communityAvailable: true };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
    const { window } = new JSDOM('<body></body>');
    const pending = new Map();
    const timers = new Map();
    const toasts = [];
    const menus = [];
    let timerId = 0;
    const helper = {
        createDialog() { const dialog = window.document.createElement('div'); dialog.className = 'dialog'; return dialog; },
        open(dialog) {
            const container = window.document.createElement('div'); container.className = 'dialogContainer';
            container.appendChild(dialog); window.document.body.appendChild(container); dialog.dialogContainer = container;
            dialog.dispatchEvent(new window.Event('open'));
            return new Promise(resolve => pending.set(dialog, resolve));
        },
        close(dialog) {
            if (!pending.has(dialog)) return;
            dialog.dispatchEvent(new window.Event('closing'));
            dialog.dialogContainer.remove();
            dialog.dispatchEvent(new window.Event('close'));
            pending.get(dialog)(); pending.delete(dialog);
        }
    };
    const ui = createNativeUi({ document: window.document, dialogHelper: helper,
        actionSheet: { show(options) { menus.push(options); return new Promise((resolve, reject) => { options.resolve = resolve; options.reject = reject; }); } },
        toast: value => toasts.push(value.text), now: () => 1000,
        setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id) });
    const document = window.document;
    return { ui, window, document, helper, timers, toasts, menus,
        button: text => [...document.querySelectorAll('button')].find(button => button.textContent === text),
        dialog: () => document.querySelector('[role="dialog"]'),
        tick() { const entry = timers.entries().next().value; if (entry) { timers.delete(entry[0]); entry[1](); } },
        close() { for (const dialog of [...pending.keys()]) helper.close(dialog); window.close(); } };
}

test('native account dialog escapes server/user text and prevents unrelated server selection', async () => {
    const f = fixture();
    try {
        const dangerous = { ...connection, serverName: '<img src=x onerror=alert(1)>', jellyfinUsername: '<script>bad()</script>' };
        const result = f.ui.chooseAccount({ data: { ...data, connections: [dangerous, { ...connection, id: 'other', serverUrl: 'https://elsewhere.example.com' }] },
            party: { serverId: connection.serverId, serverUrl: connection.serverUrl }, onDelete() {} });
        assert.equal(f.document.querySelector('script, img'), null);
        assert.match(f.document.body.textContent, /<img src=x onerror=alert\(1\)>/);
        assert.equal(f.document.querySelector('[name="serverUrl"]').readOnly, true);
        assert.equal(f.document.querySelectorAll('.discordNativeAccount')[1].disabled, true);
        assert.equal(f.document.querySelectorAll('input[is="emby-input"]').length, 3);
        assert.equal(f.document.querySelectorAll('button:not([is="emby-button"])').length, 0);
        f.document.querySelector('.discordNativeAccount').click();
        assert.equal(await result, dangerous);
    } finally { f.close(); }
});

test('login preserves password bytes, prevents duplicate submission, and clears fields on close', async () => {
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
        form.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].password, '  password stays verbatim  ');
        assert.equal(f.dialog().getAttribute('aria-busy'), 'true');
        resolveLogin(connection);
        assert.equal(await result, connection);
        assert.equal(password.value, '');
    } finally { f.close(); }
});

test('community access requires its own click and stays unavailable for another party server', async () => {
    const f = fixture();
    try {
        let calls = 0;
        const result = f.ui.chooseAccount({ data, onCommunity: async () => { calls++; return connection; } });
        assert.equal(calls, 0);
        f.button('Use community account').click();
        assert.equal(await result, connection);
        assert.equal(calls, 1);
        const next = f.ui.chooseAccount({ data, party: { serverId: 'other', serverUrl: 'https://other.example.com' }, onCommunity: async () => connection });
        assert.equal(f.button('Use community account').parentElement.hidden, true);
        f.button('Back to watching').click(); await next;
    } finally { f.close(); }
});

test('failed refresh stops loading and can retry; remove refreshes without choosing an account', async () => {
    const f = fixture();
    try {
        const deleted = [];
        let fail = true;
        const result = f.ui.chooseAccount({ data, onDelete: async id => deleted.push(id), onRefresh: async () => {
            if (fail) throw new Error('The server is temporarily unavailable.');
            return { ...data, connections: [] };
        } });
        f.button('Refresh saved accounts').click(); await flush();
        assert.equal(f.dialog().getAttribute('aria-busy'), 'false');
        assert.equal(f.document.querySelector('[role="status"]').hidden, true);
        assert.equal(f.document.querySelector('[role="alert"]').textContent, 'The server is temporarily unavailable.');
        fail = false; f.button('Remove').click(); await flush();
        assert.deepEqual(deleted, ['saved-1']);
        assert.equal(f.document.querySelector('.discordNativeAccount'), null);
        assert.ok(f.dialog(), 'removing an account does not select another one or close the chooser');
        f.button('Back to watching').click(); assert.equal(await result, null);
    } finally { f.close(); }
});

test('Quick Connect polls sequentially and closing aborts an in-flight poll and ignores its late success', async () => {
    const f = fixture();
    try {
        let pollSignal;
        let resolvePoll;
        let polls = 0;
        const result = f.ui.chooseAccount({ data,
            onQuickStart: async serverUrl => { assert.equal(serverUrl, connection.serverUrl); return { id: 'quick-1', code: '123456', expiresAt: new Date(10_000).toISOString() }; },
            onQuickPoll: (_id, signal) => { polls++; pollSignal = signal; return new Promise(resolve => { resolvePoll = resolve; }); } });
        f.button('Use Quick Connect').click(); await flush();
        assert.equal(f.document.querySelector('.discordNativeQuickCode').textContent, '123456');
        f.tick(); f.tick();
        assert.equal(polls, 1);
        assert.equal(f.timers.size, 0, 'a second poll is not scheduled until the first completes');
        f.button('Back to watching').click();
        assert.equal(await result, null);
        assert.equal(pollSignal.aborted, true);
        resolvePoll({ status: 'connected', connection }); await flush();
        assert.equal(f.dialog(), null); assert.equal(f.timers.size, 0);
    } finally { f.close(); }
});

test('Quick Connect pending then success chooses the linked account; expiration is retryable', async () => {
    const f = fixture();
    try {
        let polls = 0;
        const result = f.ui.chooseAccount({ data,
            onQuickStart: async () => ({ id: 'quick-2', code: '654321', expiresAt: new Date(10_000).toISOString() }),
            onQuickPoll: async () => ++polls === 1 ? { status: 'pending' } : { status: 'connected', connection } });
        f.button('Use Quick Connect').click(); await flush();
        f.tick(); await flush(); assert.equal(f.timers.size, 1);
        f.tick(); assert.equal(await result, connection);
        const expired = f.ui.chooseAccount({ data,
            onQuickStart: async () => ({ id: 'quick-old', code: '000000', expiresAt: new Date(100).toISOString() }),
            onQuickPoll: async () => { throw new Error('Expired codes must not be polled'); } });
        f.button('Use Quick Connect').click(); await flush(); f.tick(); await flush();
        assert.match(f.document.querySelector('[role="alert"]').textContent, /expired/);
        assert.equal(f.button('Use Quick Connect').disabled, false);
        f.button('Back to watching').click(); await expired;
    } finally { f.close(); }
});

test('server replacement requires confirmation; native watch menu invokes only the selected action', async () => {
    const f = fixture();
    try {
        const cancelled = f.ui.confirmServerChange(connection);
        f.button('Keep current server').click(); assert.equal(await cancelled, false);
        const confirmed = f.ui.confirmServerChange(connection);
        f.button('Change server').click(); assert.equal(await confirmed, true);
        let calls = 0;
        const menu = f.ui.showWatchMenu({ status: 'Watching together', onInvite: () => { calls++; }, onAccounts: () => { throw new Error('Must not select accounts'); }, onSyncSettings: () => {} });
        assert.equal(calls, 0);
        assert.equal(f.menus[0].resolveOnClick, true, 'do not defer selection until the native dialog exit animation');
        assert.equal(f.menus[0].items.some(item => /fullscreen/i.test(item.name)), false);
        assert.equal(f.menus[0].items.some(item => item.id === 'sync'), true);
        f.menus[0].resolve('invite'); await menu; assert.equal(calls, 1);
    } finally { f.close(); }
});

test('native startup retry shows failures, serializes clicks, and closes after success', async () => {
    const f = fixture();
    try {
        let calls = 0;
        const dialog = f.ui.showStartupError({ message: 'Could not load your accounts.', onRetry: async () => {
            if (++calls === 1) throw new Error('Still unavailable.');
        } });
        f.button('Try again').click(); await flush();
        assert.equal(f.document.querySelector('[role="alert"]').textContent, 'Still unavailable.');
        assert.equal(f.dialog().getAttribute('aria-busy'), 'false');
        f.button('Try again').click(); await dialog;
        assert.equal(calls, 2); assert.equal(f.dialog(), null);
        const loading = f.ui.showLoading('Loading your accounts…');
        assert.equal(f.dialog().getAttribute('aria-busy'), 'true');
        loading.close(); loading.close(); assert.equal(f.dialog(), null);
        const terminal = f.ui.showStartupError({ message: 'Close this Activity and open it again.' });
        assert.equal(f.button('Try again'), undefined, 'a terminal bootstrap failure must not offer a retry that does nothing');
        f.helper.close(f.dialog()); await terminal;
    } finally { f.close(); }
});

test('required native dialogs contain Back and external abort still closes the chooser', async () => {
    const f = fixture();
    try {
        const controller = new AbortController();
        const result = f.ui.chooseAccount({ data, canCancel: false, signal: controller.signal });
        assert.equal(f.button('Back to watching'), undefined);
        const back = new f.window.CustomEvent('command', { detail: { command: 'back' }, bubbles: true, cancelable: true });
        f.dialog().dispatchEvent(back);
        assert.equal(back.defaultPrevented, true);
        controller.abort(); assert.equal(await result, null);
        assert.equal(f.dialog(), null);
    } finally { f.close(); }
});

test('playback permission mounts the original native button and preserves its direct gesture', () => {
    const f = fixture();
    try {
        const play = f.document.createElement('button', { is: 'emby-button' });
        play.textContent = 'Tap to play on this device';
        let played = false;
        play.addEventListener('click', () => { played = true; });
        const dispose = f.ui.mountPlaybackPermission(play);
        assert.equal(f.button('Tap to play on this device'), play);
        assert.equal(f.dialog().querySelector('h1').textContent, 'Join playback');
        play.click(); assert.equal(played, true, 'the original click handler runs before returning to any promise');
        dispose(); dispose(); assert.equal(f.dialog(), null);
    } finally { f.close(); }
});
