import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { patchAuthenticatedClient } from '../authenticatedClientPatch.mjs';

const ts = createRequire(import.meta.url)('typescript');

async function fixture(initialClient) {
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    const read = path => execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/${path}`], { encoding: 'utf8' });
    const files = new Map();
    await patchAuthenticatedClient(async (path, before, after) => {
        const source = files.get(path) ?? read(path);
        assert.equal(source.split(before).length, 2, 'patch must match the verified upstream exactly once');
        files.set(path, source.replace(before, after));
    });
    const listeners = new Map();
    const Events = {
        on(target, name, callback) {
            const handlers = listeners.get(target) ?? new Map();
            handlers.set(name, [...(handlers.get(name) ?? []), callback]);
            listeners.set(target, handlers);
        },
        trigger(target, name, args = []) {
            for (const callback of listeners.get(target)?.get(name) ?? []) callback({ type: name }, ...args);
        }
    };
    const initCounts = { time: 0, playback: 0, queue: 0, controller: 0 };
    const core = name => class {
        init(manager) { this.manager = manager; initCounts[name]++; }
        forceUpdate() { assert.ok(this.manager); Events.trigger(this, 'time-sync-server-update', [0, 0]); }
    };
    const bind = [];
    const wrapper = { bindToPlayer: () => bind.push('bind'), unbindFromPlayer: () => bind.push('unbind'),
        isPlaybackActive: () => false };
    const PlayerFactory = { setDefaultWrapper() {}, registerWrapper() {}, getDefaultWrapper: () => wrapper,
        getWrapper: () => wrapper };
    const compile = (source, imports) => {
        const exports = {};
        vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
            module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
        } }).outputText, { exports, Date, console: { debug() {}, log() {}, warn() {}, error() {} }, require(name) {
            assert.ok(name in imports, `Unexpected source dependency: ${name}`);
            return imports[name];
        } });
        return exports.default;
    };
    const ManagerClass = compile(read('src/plugins/syncPlay/core/Manager.js'), {
        './Helper': { waitForEventOnce: (target, event) => new Promise(resolve => Events.on(target, event, resolve)) },
        './timeSync/TimeSyncCore': { default: core('time') }, './PlaybackCore': { default: core('playback') },
        './QueueCore': { default: core('queue') }, './Controller': { default: core('controller') },
        '../../../components/toast/toast': { default() {} }, '../../../lib/globalize': { default: { translate: key => key } },
        '../../../utils/events.ts': { default: Events }
    });
    const Manager = new ManagerClass(PlayerFactory);
    let current = initialClient;
    const connections = { currentApiClient: () => current };
    const playbackManager = {};
    const Plugin = compile(files.get('src/plugins/syncPlay/plugin.ts'), {
        'components/playback/playbackmanager': { playbackManager },
        'constants/pluginType': { PluginType: { SyncPlay: 'syncplay' } },
        'lib/jellyfin-apiclient': { ServerConnections: connections }, 'utils/events': { default: Events },
        './core': { default: { Manager, PlayerFactory } },
        './ui/players/NoActivePlayer': { default: class {} }, './ui/players/HtmlVideoPlayer': { default: class {} },
        './ui/players/HtmlAudioPlayer': { default: class {} }
    });
    new Plugin();
    return { Manager, initCounts, bind, files, read,
        emit: (event, client) => { current = client; Events.trigger(connections, event, client ? [client] : []); },
        changePlayer: player => Events.trigger(playbackManager, 'playerchange', [player]),
        serverClockListeners: () => listeners.get(Manager.timeSyncCore)?.get('time-sync-server-update')?.length ?? 0 };
}

test('first login initializes native SyncPlay fully after an unauthenticated route', async () => {
    const state = await fixture(undefined);
    assert.equal(state.Manager.getPlayerWrapper(), null);
    state.changePlayer(null);
    state.emit('localusersignedout', undefined);
    assert.deepEqual(state.initCounts, { time: 0, playback: 0, queue: 0, controller: 0 });
    let pings = 0;
    const first = { sendSyncPlayPing: () => { pings++; } };
    state.emit('apiclientcreated', first);
    state.emit('localusersignedin', first);
    assert.deepEqual(state.initCounts, { time: 1, playback: 1, queue: 1, controller: 1 });
    assert.equal(state.serverClockListeners(), 1);
    state.Manager.processGroupUpdate({ Type: 'GroupJoined', Data: {
        GroupId: 'party', LastUpdatedAt: new Date().toISOString()
    } }, first);
    await Promise.resolve();
    assert.equal(state.Manager.isSyncPlayEnabled(), true);
    assert.equal(state.Manager.syncPlayReady, true);
    assert.deepEqual(state.bind, ['bind']);
    assert.equal(pings, 1, 'the first joined party has initialized clock and playback cores');
});

test('saved startup and later account replacement reuse initialized native cores exactly once', async () => {
    const first = { sendSyncPlayPing() {} };
    const state = await fixture(first);
    state.changePlayer({ id: 'native-player' });
    const oldWrapper = state.Manager.getPlayerWrapper();
    state.emit('localusersignedout', undefined);
    const second = { sendSyncPlayPing() {} };
    state.emit('apiclientcreated', second);
    state.emit('localusersignedin', second);
    assert.equal(state.Manager.getApiClient(), second);
    assert.equal(state.Manager.getPlayerWrapper(), oldWrapper);
    assert.deepEqual(state.initCounts, { time: 1, playback: 1, queue: 1, controller: 1 });
    assert.equal(state.serverClockListeners(), 1, 'account changes cannot duplicate clock/ping listeners');
});

test('authenticated-client patch rejects applying the same source adaptation twice', async () => {
    const { files } = await fixture(undefined);
    await assert.rejects(patchAuthenticatedClient(async (path, before) => {
        assert.equal(files.get(path).split(before).length, 2, 'exact upstream source required');
    }), /exact upstream source required/);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function connectionFixture(source) {
    const requests = [];
    const events = [];
    const hooks = [];
    let current = true;
    const credentials = { Servers: [] };
    const provider = { credentials: () => credentials, addOrUpdateServer(servers, server) {
        const index = servers.findIndex(existing => existing.Id === server.Id);
        if (index < 0) servers.push(server); else servers[index] = server;
    } };
    const imports = {
        '@jellyfin/sdk/lib/constants': { AUTHORIZATION_HEADER: 'Authorization' },
        '@jellyfin/sdk/lib/utils': { getAuthorizationHeader: () => 'fixture authorization' },
        '@jellyfin/sdk/lib/versions': { MINIMUM_VERSION: '12.0.0' },
        '@jellyfin/sdk/lib/utils/api/session-api': { getSessionApi: assert.fail },
        '@jellyfin/sdk/lib/utils/versioning': { compareVersions: () => 0 },
        'utils/events': { default: { trigger: (_target, event) => events.push(event) } },
        'utils/fetch': { ajax: options => { const request = { ...deferred(), options }; requests.push(request); return request.promise; } },
        'utils/jellyfin-apiclient/compat': { toApi: () => ({ update() {} }) },
        'utils/jellyfin-apiclient/createApiClient': { createApiClient: assert.fail },
        'utils/string': { equalsIgnoreCase: (a, b) => a?.toLowerCase() === b?.toLowerCase() },
        'utils/url': { safeDecodeURIComponent: value => value },
        './connectionMode': { ConnectionMode: { Manual: 2 } },
        './connectionState': { ConnectionState: { SignedIn: 'SignedIn', ServerSignIn: 'ServerSignIn', Unavailable: 'Unavailable' } },
        './utils/getServerAddress': { default: server => server.ManualAddress }
    };
    const exports = {};
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
    } }).outputText, { exports, console: { log() {}, debug() {}, warn() {}, info() {} },
        setTimeout: callback => { queueMicrotask(callback); return 0; },
        require: name => { assert.ok(name in imports, `Unexpected ConnectionManager import ${name}`); return imports[name]; } });
    const manager = new exports.default(provider, 'fixture', '1', 'test', 'device', {});
    const user = deferred();
    const preferences = deferred();
    const server = { Id: 'same-server', UserId: 'old-user', AccessToken: 'old-capability', ManualAddress: 'https://fixture.invalid/old', manualAddressOnly: true };
    const makeClient = info => {
        let data = info;
        return {
            serverInfo(value) { if (value) data = value; return data; }, serverAddress: () => data.ManualAddress,
            appName: () => 'fixture', appVersion: () => '1', deviceName: () => 'test', deviceId: () => 'device',
            setSystemInfo() {}, updateServerInfo(value) { data = value; }, setAuthenticationInfo() {},
            accessToken: () => data.AccessToken, getCurrentUser: () => user.promise,
            enableAutomaticNetworking: false, reportCapabilities: assert.fail
        };
    };
    const first = makeClient(server);
    manager.addApiClient(first);
    manager.onLocalUserSignedIn = (_user, options) => { hooks.push(options); return preferences.promise; };
    events.length = 0;
    const begin = () => manager.connectToServer(server, { enableAutoLogin: true, enableWebSocket: false,
        reportCapabilities: false, isActivityCurrent: () => current });
    const replace = () => {
        current = false;
        manager.clearData(); manager.getApiClients().splice(0);
        const next = makeClient({ Id: 'same-server', UserId: 'new-user', AccessToken: 'new-capability', ManualAddress: 'https://fixture.invalid/new' });
        manager.addApiClient(next); events.length = 0;
        return next;
    };
    const assertReplacement = next => {
        assert.equal(manager.getApiClient('same-server'), next);
        assert.equal(credentials.Servers.length, 1);
        assert.equal(credentials.Servers[0].UserId, 'new-user');
        assert.equal(credentials.Servers[0].AccessToken, 'new-capability');
        assert.deepEqual(events, [], 'obsolete connection cannot emit signin/connected or create an ApiClient');
    };
    return { manager, requests, user, preferences, hooks, begin, replace, assertReplacement };
}

test('obsolete native connection cannot restore an account after delayed discovery, authentication, or user lookup', async () => {
    const { files } = await fixture(undefined);
    for (const phase of ['discovery', 'authentication', 'user', 'preferences']) {
        const state = connectionFixture(files.get('src/lib/jellyfin-apiclient/connectionManager.js'));
        const pending = state.begin(); await tick();
        assert.equal(state.requests.length, 1);
        if (phase !== 'discovery') {
            state.requests[0].resolve({ Id: 'same-server', Version: '12.0.0', ServerName: 'Fixture' });
            await tick(); assert.equal(state.requests.length, 2);
        }
        if (phase === 'user' || phase === 'preferences') {
            state.requests[1].resolve({ Id: 'same-server', Version: '12.0.0' });
            await tick();
        }
        if (phase === 'preferences') {
            state.user.resolve({ Id: 'old-user', ServerId: 'same-server' }); await tick();
            assert.equal(state.hooks.length, 1);
            assert.equal(typeof state.hooks[0].isActivityCurrent, 'function', 'signin hook receives account ownership');
        }
        const next = state.replace();
        if (phase === 'discovery') state.requests[0].resolve({ Id: 'same-server', Version: '12.0.0' });
        if (phase === 'authentication') state.requests[1].resolve({ Id: 'same-server', Version: '12.0.0' });
        if (phase === 'user') state.user.resolve({ Id: 'old-user', ServerId: 'same-server' });
        if (phase === 'preferences') state.preferences.resolve();
        const result = await pending;
        assert.equal(result.State, 'Unavailable', phase);
        state.assertReplacement(next);
        if (phase !== 'preferences') assert.equal(state.hooks.length, 0, phase);
    }
});

test('a late preferences response cannot reattach a logged-out or replaced account', async () => {
    const { files } = await fixture(undefined);
    const source = files.get('src/scripts/settings/userSettings.js');
    const method = source.slice(source.indexOf('    setUserInfo(userId, apiClient) {'), source.indexOf("    // FIXME: 'appSettings.set'"));
    const requests = [];
    const settings = new Function('queryClient', 'ServerConnections', 'getDisplayPreferencesQuery', 'DISPLAY_PREFERENCES_ID', 'CLIENT_ID', 'clearTimeout',
        `return { ${method} };`)(
        { fetchQuery: () => { const request = deferred(); requests.push(request); return request.promise; } },
        { getApi: () => ({}) }, () => ({}), 'usersettings', 'emby', assert.fail);
    const old = { serverId: () => 'same-server' }, replacement = { serverId: () => 'same-server' };
    const stale = settings.setUserInfo('old-user', old);
    await settings.setUserInfo(null, null);
    const current = settings.setUserInfo('new-user', replacement);
    requests[1].resolve({ CustomPrefs: { theme: 'new' } }); await current;
    requests[0].resolve({ CustomPrefs: { theme: 'old' } }); await stale;
    assert.equal(settings.currentApiClient, replacement);
    assert.equal(settings.currentUserId, 'new-user');
    assert.equal(settings.displayPrefs.CustomPrefs.theme, 'new');
});

test('obsolete signin cannot run a delayed bitrate probe or native-shell callback for another account', async () => {
    const { files } = await fixture(undefined);
    const source = files.get('src/lib/jellyfin-apiclient/ServerConnections.js');
    const method = source.slice(source.indexOf('    onLocalUserSignedIn(user, options = {}) {'), source.indexOf('\n}\n\nconst credentialProvider'));
    const timer = []; const local = []; const probes = []; const native = [];
    const preferences = deferred();
    const callbacks = new Function('setTimeout', 'detectBitrate', 'setUserInfo', 'window', `return { ${method} };`)(
        callback => timer.push(callback), value => probes.push(value), () => preferences.promise,
        { NativeShell: { onLocalUserSignedIn: value => native.push(value) } });
    const first = { accessToken: () => 'old-capability' };
    const next = { accessToken: () => 'new-capability' };
    let client = first; let active = true;
    const receiver = { getApiClient: () => client, setLocalApiClient: value => local.push(value), getApi: () => client };
    const pending = callbacks.onLocalUserSignedIn.call(receiver, { Id: 'old-user', ServerId: 'same-server' }, { isActivityCurrent: () => active });
    assert.deepEqual(local, [first]);
    active = false; client = next;
    preferences.resolve(); await pending;
    timer[0]();
    assert.deepEqual(probes, []);
    assert.deepEqual(native, []);
    await callbacks.onLocalUserSignedIn.call(receiver, { Id: 'old-user', ServerId: 'same-server' }, { isActivityCurrent: () => false });
    assert.deepEqual(local, [first], 'an already obsolete signin cannot replace the local client');
});
