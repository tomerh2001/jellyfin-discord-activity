import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createParticipantsView } from '../src/ParticipantsView.js';

const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');
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
const ParticipantsView = createParticipantsView(React, mui);
const theme = createTheme({ palette: { mode: 'dark' } });
const host = { id: 'host', displayName: 'Host', isSelf: true };
const guest = { id: 'guest', displayName: '<img src=x onerror=alert(1)>', isSelf: false };

function fixture() {
    const element = document.createElement('div'); document.body.appendChild(element);
    const root = createRoot(element);
    return {
        render: snapshot => React.act(() => root.render(React.createElement(ThemeProvider, { theme }, React.createElement(ParticipantsView, { snapshot })))),
        close: () => { React.act(() => root.unmount()); element.remove(); }
    };
}

test('native roster renders names and self label safely, and updates without stale departed rows', () => {
    const f = fixture();
    try {
        f.render({ participants: [host, guest], loading: false });
        assert.equal(document.querySelectorAll('li').length, 2);
        assert.match(document.body.textContent, /HostYou/);
        assert.match(document.body.textContent, /<img src=x onerror=alert\(1\)>/);
        assert.equal(document.querySelector('img, script, button, iframe'), null);
        assert.equal(document.querySelector('ul').getAttribute('aria-label'), 'Activity participants');
        f.render({ participants: [host], loading: false });
        assert.equal(document.querySelectorAll('li').length, 1);
        assert.doesNotMatch(document.body.textContent, /onerror/);
    } finally { f.close(); }
});

test('loading, empty and unavailable roster states stay distinct and preserve known names', () => {
    const f = fixture();
    try {
        f.render({ participants: [], loading: true });
        assert.match(document.querySelector('[role="status"]').textContent, /Loading participants/);
        assert.equal(document.querySelector('ul').getAttribute('aria-busy'), 'true');
        assert.doesNotMatch(document.body.textContent, /No one/);
        f.render({ participants: [host], loading: false, error: 'Could not refresh the list.' });
        assert.match(document.querySelector('[role="alert"]').textContent, /Could not refresh/);
        assert.match(document.body.textContent, /HostYou/);
        assert.doesNotMatch(document.body.textContent, /No one/);
        f.render({ participants: [], loading: false });
        assert.match(document.body.textContent, /No one is in this Activity/);
        assert.equal(document.querySelector('[role="alert"], [role="status"]'), null);
    } finally { f.close(); }
});
