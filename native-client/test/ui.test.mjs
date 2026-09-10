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
const flush = () => React.act(async () => { await new Promise(resolve => setImmediate(resolve)); });

function fixture() {
    const toasts = [];
    const controller = createNativeUi({ toast: value => toasts.push(value) });
    window.addEventListener('command', controller.handleCommand, true);
    const ui = Object.fromEntries(Object.entries(controller).map(([name, method]) => [name, (...args) => {
        let result; React.act(() => { result = method(...args); }); return result;
    }]));
    const element = document.createElement('div'); document.body.appendChild(element);
    const root = createRoot(element);
    React.act(() => root.render(React.createElement(ThemeProvider, { theme }, React.createElement(Components, { controller }))));
    const f = { ui, controller, window, document, toasts,
        button: text => [...document.querySelectorAll('button')].find(button => button.textContent === text),
        click: node => React.act(() => node.click()),
        dialog: () => document.querySelector('[role="dialog"]'),
        close() { window.removeEventListener('command', controller.handleCommand, true); React.act(() => root.unmount()); element.remove(); document.body.replaceChildren(); } };
    return f;
}

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

test('watch party dialog contains only a live roster and Close, with native Back dismissal', async () => {
    const f = fixture();
    let underlyingBacks = 0;
    const underlying = () => { underlyingBacks++; };
    document.addEventListener('command', underlying);
    try {
        const host = { id: 'host', displayName: 'Host', isSelf: true };
        const guest = { id: 'guest', displayName: 'Guest', isSelf: false };
        const dialog = f.ui.showParticipants({ participants: [host], loading: false });
        assert.equal(f.dialog().querySelector('.MuiDialogTitle-root').textContent, 'Watch party');
        assert.deepEqual([...f.dialog().querySelectorAll('button')].map(button => button.textContent), ['Close']);
        assert.match(f.dialog().textContent, /HostYou/);
        React.act(() => dialog.update({ participants: [host, guest], loading: false }));
        assert.equal(f.dialog().querySelectorAll('li').length, 2);
        const back = new window.CustomEvent('command', { detail: { command: 'back' }, bubbles: true, cancelable: true });
        React.act(() => f.dialog().dispatchEvent(back));
        await dialog.result;
        assert.equal(back.defaultPrevented, true);
        assert.equal(underlyingBacks, 0);
        assert.equal(f.dialog(), null);
        React.act(() => { dialog.update({ participants: [guest], loading: false }); dialog.close(); });
        assert.equal(f.dialog(), null, 'late updates cannot reopen a closed roster');
        const next = f.ui.showParticipants({ participants: [host], loading: false });
        f.click(f.button('Close')); await next.result; assert.equal(f.dialog(), null);
    } finally { document.removeEventListener('command', underlying); f.close(); }
});

test('loading blocks Back and terminal Activity exit is explicit and retryable', async () => {
    const f = fixture();
    try {
        const loading = f.ui.showLoading();
        const back = new window.CustomEvent('command', { detail: { command: 'back' }, bubbles: true, cancelable: true });
        React.act(() => f.dialog().dispatchEvent(back));
        assert.equal(back.defaultPrevented, true); assert.ok(f.dialog());
        React.act(() => loading.close());
        let attempts = 0;
        const result = f.ui.showClosed({ onClose: async () => { if (++attempts === 1) throw new Error('unavailable'); } });
        assert.equal(attempts, 0); f.click(f.button('Close Activity')); await flush();
        assert.equal(f.toasts[0], 'You are signed out. Close this Activity in Discord.');
        assert.equal(f.button('Close Activity').disabled, false);
        f.click(f.button('Close Activity')); await flush(); await result;
        assert.equal(attempts, 2); assert.equal(f.dialog(), null);
    } finally { f.close(); }
});
