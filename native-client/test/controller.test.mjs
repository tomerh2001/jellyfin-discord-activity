import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityController, preferredAccount } from '../src/controller.js';

const connection = { id: 'account', serverId: 'server', serverUrl: 'https://media.example' };
const party = { id: 'party', groupId: 'group', serverId: connection.serverId, serverUrl: connection.serverUrl };
const matches = (account, group) => account.serverId === group.serverId && account.serverUrl === group.serverUrl;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(install) {
    let rejected;
    const calls = [];
    const session = token => ({ discord: { sdk: {} }, exchange: { appToken: token, expiresAt: new Date(Date.now() + 3600000).toISOString() } });
    const broker = {
        onSessionRejected: callback => { rejected = callback; return () => {}; },
        startActivitySession: async () => { calls.push('start'); return session('initial'); },
        resumeActivitySession: async () => { calls.push('resume'); return session('renewed'); },
        clearActivitySession: () => calls.push('clear'),
        closeDiscordActivity: () => calls.push('close'),
        getConnections: async () => ({ connections: [connection], preferredConnectionId: connection.id }),
        getParty: async () => party,
        matchesPartyServer: matches,
        joinParty: async () => { calls.push('join'); return party; },
        savePreference: async () => calls.push('preference'),
        launchNative: async token => { calls.push(['launch', token]); return { accessToken: token }; },
        logout: async () => calls.push('logout')
    };
    const controller = createActivityController(broker, install || (async launch => { calls.push(['install', launch.accessToken]); }), 'device');
    return { broker, controller, calls, reject: token => rejected(token) };
}

test('a preferred server never silently replaces an existing party', async () => {
    const other = { ...connection, id: 'other', serverUrl: 'https://other.example' };
    assert.equal(preferredAccount({ connections: [connection, other], preferredConnectionId: 'other' }, party, matches), connection);
    const f = fixture(); await f.controller.start();
    await assert.rejects(f.controller.select(other), /another Jellyfin server/);
    assert.deepEqual(f.calls, ['start']);
    await f.controller.select(other, true);
    assert.ok(f.calls.includes('join'));
});

test('repeat account selection installs fresh native clients while reusing one Discord session', async () => {
    const f = fixture(); await f.controller.start();
    await f.controller.select(connection);
    await f.controller.select({ ...connection, id: 'another-user-on-same-server' });
    assert.equal(f.calls.filter(value => value === 'start').length, 1);
    assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === 'install').length, 2);
    assert.equal(f.controller.selection.id, 'another-user-on-same-server');
    assert.ok(!f.calls.includes('join'));
});

test('expired broker proof resumes with retained Discord credentials without SDK reauthorization', async () => {
    const f = fixture(); await f.controller.start(); await f.controller.select(connection);
    f.broker.getConnections = async token => {
        if (token === 'initial') { f.reject(token); throw new Error('expired'); }
        return { connections: [connection] };
    };
    await f.controller.call('getConnections');
    assert.equal(f.controller.session.exchange.appToken, 'renewed');
    assert.equal(f.controller.needsLaunch, true);
    await f.controller.select(connection);
    assert.equal(f.controller.needsLaunch, false);
    assert.equal(f.calls.filter(value => value === 'resume').length, 1);
    assert.equal(f.calls.filter(value => value === 'start').length, 1);
    assert.deepEqual(f.calls.at(-1), ['install', 'renewed']);
});

test('a poll started before a completed server switch cannot discard the selected account', async () => {
    const f = fixture(); await f.controller.start(); await f.controller.load();
    const waiting = deferred();
    f.broker.getParty = () => waiting.promise;
    const poll = f.controller.poll();
    f.broker.getParty = async () => party;
    await f.controller.select(connection);
    waiting.resolve({ ...party, id: 'stale' });
    assert.equal(await poll, false);
    assert.equal(f.controller.selection, connection);
    assert.equal(f.controller.party, party);
});

test('party replacement clears selection and requires an explicit account choice', async () => {
    const f = fixture(); await f.controller.start(); await f.controller.select(connection);
    f.broker.getParty = async () => ({ ...party, serverId: 'changed' });
    assert.equal(await f.controller.poll(), true);
    assert.equal(f.controller.selection, undefined);
    assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === 'install').length, 1);
});

test('leaving revokes first and then closes without generating invites or commands', async () => {
    const f = fixture(); await f.controller.start();
    await f.controller.leave();
    assert.deepEqual(f.calls, ['start', 'logout', 'clear', 'close']);
    await assert.rejects(f.controller.call('getConnections'), /closed/);
});

test('an old request rejected after renewal retries the current token without a second resume', async () => {
    const f = fixture(); await f.controller.start();
    const delayed = deferred();
    const requested = [];
    let originalRequests = 0;
    f.broker.getConnections = async token => {
        requested.push(token);
        if (token === 'initial') {
            if (originalRequests++ === 0) await delayed.promise;
            f.reject(token);
            throw new Error('expired');
        }
        return { connections: [connection] };
    };
    const stale = f.controller.call('getConnections');
    const concurrent = await f.controller.call('getConnections');
    assert.deepEqual(concurrent.connections, [connection]);
    assert.equal(f.controller.session.exchange.appToken, 'renewed');
    delayed.resolve();
    assert.deepEqual((await stale).connections, [connection]);
    assert.deepEqual(requested, ['initial', 'initial', 'renewed', 'renewed']);
    assert.equal(f.calls.filter(value => value === 'resume').length, 1);
});

test('a resume completing after explicit Leave revokes its result and never restores the session', async () => {
    const f = fixture(); await f.controller.start();
    const deferredResume = deferred();
    const resumed = deferred();
    const revoked = [];
    f.broker.resumeActivitySession = () => { resumed.resolve(); return deferredResume.promise; };
    f.broker.logout = async token => { revoked.push(token); };
    f.reject('initial');
    const recovery = f.controller.call('getConnections');
    const recoveryRejected = assert.rejects(recovery, /closed/);
    await resumed.promise;
    await f.controller.leave();
    deferredResume.resolve({ discord: { sdk: {} }, exchange: { appToken: 'late-token', expiresAt: new Date(Date.now() + 3600000).toISOString() } });
    await recoveryRejected;
    assert.deepEqual(revoked, ['initial', 'late-token']);
    assert.equal(f.controller.session.exchange.appToken, 'initial');
    await assert.rejects(f.controller.call('getConnections'), /closed/);
});

test('401s arriving during pending Leave cannot trigger a new session or account selection', async () => {
    const f = fixture(); await f.controller.start();
    const delayedRequest = deferred();
    const delayedLogout = deferred();
    f.broker.getConnections = async token => {
        await delayedRequest.promise;
        f.reject(token);
        throw new Error('expired');
    };
    f.broker.logout = () => delayedLogout.promise;
    const request = f.controller.call('getConnections');
    const requestRejected = assert.rejects(request, /closed/);
    const leave = f.controller.leave();
    assert.throws(() => f.controller.select(connection), /closed/);
    delayedRequest.resolve();
    await requestRejected;
    assert.ok(!f.calls.includes('resume'));
    delayedLogout.resolve();
    await leave;
});

test('a launch awaiting its response when Leave begins cannot install a native client', async () => {
    const f = fixture(); await f.controller.start();
    const launched = deferred();
    const delayedLaunch = deferred();
    f.broker.launchNative = () => { launched.resolve(); return delayedLaunch.promise; };
    const selection = f.controller.select(connection);
    await launched.promise;
    await f.controller.leave();
    delayedLaunch.resolve({ accessToken: 'late-launch' });
    await selection;
    assert.equal(f.controller.selection, undefined);
    assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === 'install').length, 0);
});

test('Leave invalidates an already running native installation before it can publish selection', async () => {
    const installing = deferred();
    const delayedInstall = deferred();
    let isCurrent;
    const f = fixture(async (_launch, _connection, current) => {
        isCurrent = current;
        installing.resolve();
        await delayedInstall.promise;
    });
    await f.controller.start();
    const selection = f.controller.select(connection);
    await installing.promise;
    assert.equal(isCurrent(), true);
    await f.controller.leave();
    assert.equal(isCurrent(), false);
    delayedInstall.resolve();
    await selection;
    assert.equal(f.controller.selection, undefined);
});

test('a rejected replacement cannot cause an automatic session loop, even if another endpoint succeeds', async () => {
    const f = fixture(); await f.controller.start();
    f.broker.getConnections = async token => { f.reject(token); throw new Error('expired'); };
    await assert.rejects(f.controller.call('getConnections'), { recoveryRequired: true });
    for (let attempts = 0; attempts < 5; attempts++) {
        await assert.rejects(f.controller.call('getConnections'), { recoveryRequired: true });
    }
    assert.equal(f.calls.filter(value => value === 'resume').length, 1);
    f.controller.retryRecovery();
    f.broker.resumeActivitySession = async () => {
        f.calls.push('resume');
        return { discord: { sdk: {} }, exchange: { appToken: 'explicit-retry', expiresAt: new Date(Date.now() + 3600000).toISOString() } };
    };
    assert.equal(await f.controller.call('getParty'), party);
    await assert.rejects(f.controller.call('getConnections'), { recoveryRequired: true });
    assert.equal(f.calls.filter(value => value === 'resume').length, 2);
});

test('failed Discord resume needs an explicit retry instead of retrying from every poll', async () => {
    const f = fixture(); await f.controller.start();
    f.broker.resumeActivitySession = async () => { f.calls.push('resume'); throw new Error('Membership unavailable'); };
    f.reject('initial');
    await assert.rejects(f.controller.poll(), { recoveryRequired: true });
    await assert.rejects(f.controller.poll(), { recoveryRequired: true });
    assert.equal(f.calls.filter(value => value === 'resume').length, 1);
    f.controller.retryRecovery();
    await assert.rejects(f.controller.poll(), { recoveryRequired: true });
    assert.equal(f.calls.filter(value => value === 'resume').length, 2);
});

test('an already revoked logout closes the Activity without resuming', async () => {
    const f = fixture(); await f.controller.start();
    f.broker.logout = async token => { f.reject(token); throw new Error('Session expired.'); };
    await f.controller.leave();
    assert.deepEqual(f.calls, ['start', 'clear', 'close']);
});
