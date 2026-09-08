import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { nativeQueueFailureMessage, observeQueueFailures } from '../src/queueErrors.js';

test('queue feedback accepts only fixed errors on this exact gateway queue endpoint', () => {
    const origin = 'https://activity.test';
    const baseUrl = '/jf/test-capability';
    const failure = { url: `${origin}${baseUrl}/SyncPlay/SetNewQueue`, status: 400, errorCode: 'native_queue_empty' };
    assert.match(nativeQueueFailureMessage(failure, baseUrl, origin), /no playable items/);
    for (const patch of [
        { url: 'https://other.test/jf/test-capability/SyncPlay/SetNewQueue' },
        { url: `${origin}/jf/other-capability/SyncPlay/SetNewQueue` },
        { url: `${origin}${baseUrl}/SyncPlay/SetNewQueue/other` },
        { url: `${origin}${baseUrl}/SyncPlay/Join` },
        { status: 403 }, { errorCode: 'untrusted-private-text' }, { errorCode: 'toString' }
    ]) assert.equal(nativeQueueFailureMessage({ ...failure, ...patch }, baseUrl, origin), undefined);
    const listeners = new Map(); const client = {}; const shown = [];
    const events = { on: (_client, event, callback) => listeners.set(event, callback),
        off: (_client, event) => listeners.delete(event) };
    const stop = observeQueueFailures(events, client, baseUrl, origin, text => shown.push(text));
    listeners.get('requestfail')({}, failure);
    // The API client emits a second failure without status after its rejected promise.
    listeners.get('requestfail')({}, { url: failure.url });
    assert.equal(shown.length, 1);
    assert.equal(shown[0].includes('test-capability'), false);
    stop(); assert.equal(listeners.size, 0);
});

const helperFile = new URL('../.build/source/src/plugins/syncPlay/core/Helper.js', import.meta.url);
test('patched native episode expansion retains a playable selection absent from the series response',
    { skip: !existsSync(helperFile) && 'Prepare or build the pinned native source first' }, async () => {
        // Execute the prepared upstream helper, including its actual expansion logic.
        // These two imports are used only by unrelated branches of the helper.
        const source = (await readFile(helperFile, 'utf8')).replace(/^import .*;\n/gm, '');
        const { translateItemsForPlayback } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
        const selected = { Id: 'selected-episode', Type: 'Episode', SeriesId: 'series' };
        let series = [{ Id: 'other-episode' }];
        const apiClient = {
            getCurrentUser: async () => ({ Configuration: { EnableNextEpisodeAutoPlay: true } }),
            getCurrentUserId: () => 'viewer', getEpisodes: async () => ({ Items: series })
        };
        assert.deepEqual(await translateItemsForPlayback(apiClient, [selected], {}), [selected]);
        series = [];
        assert.deepEqual(await translateItemsForPlayback(apiClient, [selected], {}), [selected]);
        series = [{ Id: 'earlier' }, selected, { Id: 'next-episode' }];
        assert.deepEqual(await translateItemsForPlayback(apiClient, [selected], {}), [selected, { Id: 'next-episode' }]);
    });
