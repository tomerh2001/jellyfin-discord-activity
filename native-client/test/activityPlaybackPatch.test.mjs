import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { patchActivityPlayback } from '../activityPlaybackPatch.mjs';

let patched;
async function sources() {
    if (patched) return patched;
    const upstream = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
    const archive = new URL(`../.build/${upstream.commit}.tar.gz`, import.meta.url);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), upstream.archiveSha256);
    const files = new Map();
    await patchActivityPlayback(async (path, before, after) => {
        const source = files.get(path) ?? execFileSync('tar', ['-xOf', archive.pathname, `jellyfin-web-${upstream.commit}/${path}`], { encoding: 'utf8' });
        assert.equal(source.split(before).length, 2, `Exact upstream anchor: ${path}\n${before}`);
        files.set(path, source.replace(before, after));
    });
    patched = files; return files;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the native socket cannot bind upstream SyncPlay timing alongside Activity playback', async () => {
    const files = await sources(); const notifications = files.get('src/scripts/serverNotifications.js');
    assert.ok(!notifications.includes('SyncPlayCommand'));
    assert.ok(!notifications.includes('SyncPlayGroupUpdate'));
    assert.ok(notifications.includes('OutboundWebSocketMessageType.Play'));
    assert.ok(notifications.includes('OutboundWebSocketMessageType.GeneralCommand'));
    await assert.rejects(patchActivityPlayback(async (path, before) => {
        assert.equal(files.get(path).split(before).length, 2, 'fresh upstream source required');
    }), /fresh upstream source/);
});

test('prepared Activity queues still enter native playback with their selected item, tracks and reporting callback', async () => {
    const source = (await sources()).get('src/components/playback/playbackmanager.js');
    const section = source.slice(source.indexOf('        self.activityPlayPrepared = function'), source.indexOf('        // Set playlist state.'));
    const calls = []; const player = {}; const previous = { DefaultAudioStreamIndex: 2 };
    const self = { _currentPlayer: player, _playQueueManager: { setPlaylist: items => calls.push(['playlist', items]) } };
    let begin;
    new Function('self', 'getPreviousSource', 'playInternal', 'setPlaylistState', 'loading', section)(self,
        value => { assert.equal(value, player); return previous; },
        (item, options, onStarted, source) => { calls.push(['native', item, options, source]); begin = onStarted; return Promise.resolve(); },
        (...args) => calls.push(['index', ...args]), { hide: () => calls.push(['hide']) });
    const items = [{ Id: 'one', PlaylistItemId: 'entry-one' }, { Id: 'two', PlaylistItemId: 'entry-two' }];
    let active = true;
    await self.activityPlayPrepared(items, { startIndex: 1, startPositionTicks: 123, audioStreamIndex: 2,
        activityRetainTracks: true, activityIsCurrent: () => active });
    assert.equal(calls[0][1], items[1]);
    assert.equal(calls[0][2].startPositionTicks, 123);
    assert.equal(calls[0][2].audioStreamIndex, 2);
    assert.equal(calls[0][3], previous);
    begin(); assert.deepEqual(calls.slice(1), [['playlist', items], ['index', 'entry-two', 1], ['hide']]);
    calls.length = 0; active = false; begin();
    assert.deepEqual(calls, [], 'a cancelled native start callback cannot reset the replacement queue');
    await self.activityPlayPrepared(items, { startIndex: 1, activityIsCurrent: () => false });
    assert.deepEqual(calls, []);
});

test('native episode/parts preparation cancelled by account replacement cannot publish its old queue', async () => {
    const source = (await sources()).get('src/components/playback/playbackmanager.js');
    const section = source.slice(source.indexOf('        self.play = async function'), source.indexOf('\n        function getPlayerData'));
    // The enclosing PlaybackManager constructor closes after assigning self.play.
    const assignment = section.slice(0, section.lastIndexOf('\n    }'));
    const delayed = deferred(); const played = []; let active = true;
    const self = { activityPlayback: { beginPreparation: () => 1, isPreparationCurrent: () => active } };
    new Function('self', 'normalizePlayOptions', 'getItemsForPlayback', 'translateItemsForPlayback', 'getAdditionalParts', 'playWithIntros', 'loading', assignment)(
        self, () => {}, async () => ({ Items: [{ Id: 'series' }] }), () => delayed.promise,
        async items => items.map(item => [item]), (...args) => played.push(args), { show() {} });
    const pending = self.play({ ids: ['series'], serverId: 'old-account' });
    await tick(); active = false; delayed.resolve([{ Id: 'old-episode', ServerId: 'old-account' }]); await pending;
    assert.deepEqual(played, []);
});

test('late native device-profile, media-source and version-item results cannot start stale media', async () => {
    const source = (await sources()).get('src/components/playback/playbackmanager.js');
    const section = source.slice(source.indexOf('        function playAfterBitrateDetect('), source.indexOf('        self.getPlaybackInfo ='));
    for (const phase of ['profile', 'media', 'version', 'current']) {
        let active = true; const calls = []; const profile = deferred(); const media = deferred(); const version = deferred();
        const item = { Id: 'episode', MediaType: 'Video', ServerId: 'server' };
        const player = { getDeviceProfile: () => profile.promise, play: async value => calls.push(['play', value]) };
        const api = { getItem: async () => item, getCurrentUser: async () => ({ Configuration: {} }) };
        const dependencies = {
            self: { _currentPlayer: null, trackHasSecondarySubtitleSupport: () => false },
            getPlayer: () => player, isServerItem: () => true, BaseItemKind: {},
            ServerConnections: { getApiClient: () => api }, getMatchingMediaSource: () => null,
            enableLocalPlaylistManagement: () => true, autoSetNextTracks() {},
            getPlaybackMediaSource: () => media.promise, getItemOfMediaSource: () => version.promise,
            createStreamInfo: () => ({ url: 'authorized-fixture-stream' }), getPlayerData: () => player,
            loading: { hide() {} }, onPlaybackStarted: () => calls.push(['report-start']),
            console: { error() {} }
        };
        const run = new Function(...Object.keys(dependencies), `${section}\nreturn playAfterBitrateDetect;`)(...Object.values(dependencies));
        const pending = run(10_000_000, item, { startPositionTicks: 0, activityIsCurrent: () => active }, () => calls.push(['set-queue']));
        if (phase === 'profile') active = false;
        profile.resolve({}); await tick();
        if (phase === 'media') active = false;
        media.resolve({ MediaStreams: [], DefaultSubtitleStreamIndex: -1 }); await tick();
        if (phase === 'version') active = false;
        version.resolve(item); await pending;
        if (phase === 'current') assert.deepEqual(calls, [['play', { url: 'authorized-fixture-stream', aspectRatio: undefined, fullscreen: undefined }], ['set-queue'], ['report-start']]);
        else assert.deepEqual(calls, [], phase);
    }
});

test('native ended handling advances an Activity without waiting for personal AutoNext preferences and preserves normal Jellyfin behavior', async () => {
    const source = (await sources()).get('src/components/playback/playbackmanager.js');
    const section = source.slice(source.indexOf('        function onPlaybackStopped(e, displayErrorCode)'), source.indexOf('        function onPlaybackChanging('));
    for (const scenario of ['activity-next', 'activity-last', 'activity-error', 'native-disabled', 'native-enabled']) {
        const calls = [];
        const state = { PlayState: { PlaylistItemId: 'entry' } };
        const player = {};
        const streamInfo = { item: { ServerId: 'server' } };
        const data = { streamInfo };
        const next = scenario === 'activity-last' ? null : { item: { Id: 'next', ServerId: 'server', MediaType: 'Video' } };
        const captured = { epoch: 'party', queueRevision: 7 };
        const self = { _playNextAfterEnded: true, getPlayerState: () => state,
            _playQueueManager: { getNextItemInfo: () => next, reset: () => calls.push('reset') },
            nextTrack: () => calls.push('native-next'),
            ...(scenario.startsWith('activity') ? { activityPlayback: {
                captureEnded(value) { assert.equal(value, state); calls.push('capture'); return captured; },
                ended(value, context) { assert.equal(value, state); assert.equal(context, captured); calls.push('activity-next'); }
            } } : {})
        };
        const dependencies = { self, getPlayerData: () => data, stopPlaybackProgressTimer() {}, isServerItem: () => true,
            reportPlayback: () => calls.push('report-stopped'), Events: { trigger: () => calls.push('event') },
            getDefaultPlayOptions: () => ({}), getPlayer: () => player,
            destroyPlayer: () => calls.push('destroy'), removeCurrentPlayer: () => calls.push('remove'),
            showPlaybackInfoErrorMessage: () => calls.push('error'), MediaType: { Video: 'Video' },
            ServerConnections: { getApiClient: () => ({ getCurrentUser: async () => {
                calls.push('get-user'); return { Configuration: { EnableNextEpisodeAutoPlay: scenario === 'native-enabled' } };
            } }) }
        };
        const stopped = new Function(...Object.keys(dependencies), `${section}\nreturn onPlaybackStopped;`)(...Object.values(dependencies));
        stopped.call(player, {}, scenario === 'activity-error' ? '.MediaDecodeError' : undefined);
        await tick();
        if (scenario === 'activity-next' || scenario === 'activity-last') {
            assert.equal(calls.filter(value => value === 'activity-next').length, 1, scenario);
            assert.ok(calls.indexOf('capture') < calls.indexOf('report-stopped'));
            assert.ok(!calls.includes('get-user'), 'the Activity does not wait on private AutoNext preferences');
            assert.equal(streamInfo.ended, true, 'native playback reporting still marks the stream ended');
            if (scenario === 'activity-last') assert.ok(calls.indexOf('remove') < calls.indexOf('activity-next'));
        } else {
            assert.ok(!calls.includes('activity-next'));
            assert.equal(calls.includes('native-next'), scenario === 'native-enabled');
        }
    }
});
