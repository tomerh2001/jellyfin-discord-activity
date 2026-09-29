import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Exercise actual runtime control flow while replacing native UI dependencies.
const source = (await readFile(new URL('../src/runtime.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/\bexport (?=(?:async )?function\b)/g, '');

function fixture() {
    const calls = [];
    const handlers = new Map();
    const intervals = new Set();
    const connection = { id: 'account', serverId: 'server' };
    const launch = { baseUrl: '/jf/session', serverId: 'server', userId: 'user', accessToken: 'session' };
    const controller = { selection: connection, session: { discord: {}, exchange: { expiresAt: '2099-01-01T00:00:00Z' } } };
    let connectionState = 'SignedIn';
    class ApiClient {
        serverInfo() {}
        setAuthenticationInfo() {}
        ensureWebSocket() { calls.push('ensure-socket'); }
        closeWebSocket() { calls.push('close-socket'); }
    }
    const playback = {
        start: async () => { calls.push('snapshot'); throw new Error('Snapshot temporarily unavailable'); },
        dispose: () => calls.push('dispose-playback'),
        getSnapshot: () => ({ queue: [] })
    };
    const clients = [];
    const context = vm.createContext({
        URL, crypto: { randomUUID: () => 'device' },
        document: {}, window: { JellyfinWatch: {
            createWatchPresence: () => ({}), normalizeNativeRoute: value => value
        }, location: { origin: 'https://activity.example', hash: '#/home' } },
        ApiClient,
        ServerConnections: {
            clearData: () => calls.push('clear-accounts'), getApiClients: () => clients,
            addApiClient: client => clients.push(client), setLocalApiClient() {},
            connectToServer: async () => ({ State: connectionState })
        },
        flushSync: callback => callback(), beginAccountViewChange() {}, finishAccountViewChange() {},
        setUserInfo: async () => {}, queryClient: { clear() {} }, viewContainer: { reset() {} },
        appRouter: { cancelPendingNavigation() {}, show: async route => calls.push(['route', route]) },
        playbackManager: { stop: async () => calls.push('stop-local-player') },
        createNativePlaybackAdapter: () => playback, createActivityPlaybackClient() {},
        observeWatchPresence: () => ({ clear() {}, refresh: () => calls.push('presence'), dispose() {} }),
        observeQueueFailures: () => () => {},
        Events: { on: (_client, event, callback) => handlers.set(event, callback), off: (_client, event) => handlers.delete(event) },
        toast: options => calls.push(['error', options.text]),
        observeVideoPresentation: () => ({ stop() {}, dispose() {} }),
        observeNavigation: () => ({ dispose() {}, flush() {} }), restoredNavigation: () => '/home',
        installPlaybackPermission: () => Object.assign(() => {}, { reset() {} }), mountPlaybackPermission() {},
        onDocumentExit() {},
        clearTimeout() {}, setTimeout: () => 1,
        setInterval: callback => { intervals.add(callback); return callback; }, clearInterval: callback => intervals.delete(callback)
    });
    vm.runInContext(source + '\nglobalThis.runtimeTest = { finishDiscordBootstrap, installLaunch,\n'
        + 'configure(values) { controller = values.controller; apiClient = values.apiClient; launch = values.launch; ready = values.ready; },\n'
        + 'get apiClient() { return apiClient; }, get partyPlayback() { return partyPlayback; } };', context);
    const runtime = context.runtimeTest;
    const apiClient = new ApiClient();
    runtime.configure({ controller, apiClient, launch, ready: false });
    return { runtime, calls, handlers, intervals, apiClient, playback, connection, launch,
        configure: values => runtime.configure({ controller, apiClient, launch, ready: false, ...values }),
        connectionState: value => { connectionState = value; } };
}

test('a failed first playback snapshot leaves bootstrap and socket recovery running', async () => {
    const f = fixture();
    await assert.doesNotReject(f.runtime.finishDiscordBootstrap());
    assert.equal(f.runtime.apiClient, f.apiClient);
    assert.equal(f.runtime.partyPlayback, f.playback);
    assert.equal(f.intervals.size, 1, 'session polling remains active');
    assert.equal(f.calls.includes('dispose-playback'), false);
    assert.equal(f.calls.includes('close-socket'), false);
    f.handlers.get('websocketopen')();
    assert.equal(f.calls.at(-1), 'presence');
});

test('reinstalling a valid account survives a temporarily failed playback snapshot', async () => {
    const f = fixture();
    f.configure({ ready: true });
    await assert.doesNotReject(f.runtime.installLaunch(f.launch, f.connection, () => true));
    assert.notEqual(f.runtime.apiClient, f.apiClient);
    assert.equal(f.runtime.partyPlayback, f.playback);
    assert.equal(f.calls.includes('snapshot'), true);
    assert.deepEqual(f.calls.filter(value => Array.isArray(value) && value[0] === 'route'), [['route', '/home']]);
    assert.equal(f.calls.includes('dispose-playback'), false);
});

test('a rejected Jellyfin login still clears the client and returns to sign in', async () => {
    const f = fixture();
    f.configure({ ready: true });
    f.connectionState('ServerSignIn');
    await assert.rejects(f.runtime.installLaunch(f.launch, f.connection, () => true), /Could not connect to your Jellyfin account/);
    assert.equal(f.runtime.apiClient, undefined);
    assert.equal(f.calls.includes('snapshot'), false);
    assert.deepEqual(f.calls.filter(value => Array.isArray(value) && value[0] === 'route'), [['route', '/login']]);
});
