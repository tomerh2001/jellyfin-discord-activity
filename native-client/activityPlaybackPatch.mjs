/** Keep native Jellyfin preparation/reporting while the Activity orders intent. */
export async function patchActivityPlayback(replace) {
    const notifications = 'src/scripts/serverNotifications.js';
    await replace(notifications,
        `        apiClient.subscribe([OutboundWebSocketMessageType.GeneralCommand], ({ Data }) => processGeneralCommand(Data, apiClient)),
        apiClient.subscribe([OutboundWebSocketMessageType.SyncPlayCommand], ({ Data }) => {
            pluginManager.firstOfType(PluginType.SyncPlay)?.instance.Manager.processCommand(Data, apiClient);
        }),
        apiClient.subscribe([OutboundWebSocketMessageType.SyncPlayGroupUpdate], ({ Data }) => {
            pluginManager.firstOfType(PluginType.SyncPlay)?.instance.Manager.processGroupUpdate(Data, apiClient);
            Events.trigger(serverNotifications, OutboundWebSocketMessageType.SyncPlayGroupUpdate, [apiClient, Data]);
        })`,
        `        apiClient.subscribe([OutboundWebSocketMessageType.GeneralCommand], ({ Data }) => processGeneralCommand(Data, apiClient))`);
    for (const statement of ["import { pluginManager } from 'components/pluginManager';\n", "import { PluginType } from 'constants/pluginType';\n"]) await replace(notifications, statement, '');

    const playback = 'src/components/playback/playbackmanager.js';
    await replace(playback,
        '        self.play = async function (options) {\n            normalizePlayOptions(options);',
        `        self.play = async function (options) {
            const activity = self.activityPlayback;
            const preparation = activity?.beginPreparation();
            normalizePlayOptions(options);`);
    await replace(playback,
        '            return playWithIntros(items, options);',
        '            if (activity && !activity.isPreparationCurrent(preparation)) return;\n            options.activityPreparationCurrent = activity ? () => activity.isPreparationCurrent(preparation) : undefined;\n            return playWithIntros(items, options);');
    await replace(playback,
        '            return getIntros(firstItem, apiClient, options).then(function (introsResult) {',
        '            return getIntros(firstItem, apiClient, options).then(function (introsResult) {\n                if (options.activityPreparationCurrent?.() === false) return;');
    await replace(playback,
        `                return playInternal(items[playStartIndex], introPlayOptions, function () {
                    self._playQueueManager.setPlaylist(items);

                    setPlaylistState(items[playStartIndex].PlaylistItemId, playStartIndex);
                    loading.hide();
                });`,
        `                if (self.activityPlayback) return self.activityPlayback.playPrepared(items, introPlayOptions);
                return self.activityPlayPrepared(items, introPlayOptions);`);
    await replace(playback,
        '        // Set playlist state. Using a method allows for overloading in derived player implementations',
        `        // Activity queue entries are already translated and permission-filtered.
        // Keep the native stream selection, tracks, playback reporting and OSD.
        self.activityPlayPrepared = function (items, options) {
            const index = options.startIndex || 0;
            if (options.activityIsCurrent?.() === false || !items[index]) return Promise.resolve();
            const previous = options.activityRetainTracks && self._currentPlayer ? getPreviousSource(self._currentPlayer) : undefined;
            return playInternal(items[index], { ...options, items }, function () {
                if (options.activityIsCurrent?.() === false) return;
                self._playQueueManager.setPlaylist(items);
                setPlaylistState(items[index].PlaylistItemId, index);
                loading.hide();
            }, previous);
        };

        // Set playlist state. Using a method allows for overloading in derived player implementations`);
    await replace(playback,
        '        function queueAll(items, mode, player) {\n            if (!items.length) {',
        '        function queueAll(items, mode, player) {\n            if (self.activityPlayback) return self.activityPlayback.queuePrepared(items, mode);\n            if (!items.length) {');
    await replace(playback,
        "            const errorOccurred = displayErrorCode && typeof (displayErrorCode) === 'string';",
        `            const errorOccurred = displayErrorCode && typeof (displayErrorCode) === 'string';
            const activity = self.activityPlayback;
            const activityEnded = !errorOccurred && self._playNextAfterEnded ? activity?.captureEnded(state) : undefined;`);
    await replace(playback,
        `            } else if (newPlayer) {
                const apiClient = ServerConnections.getApiClient(nextItem.item.ServerId);`,
        `            } else if (activity) {
                // The Activity owns the shared queue; personal AutoNext cannot
                // leave one member stopped while the party advances.
                if (activityEnded) activity.ended(state, activityEnded);
            } else if (newPlayer) {
                const apiClient = ServerConnections.getApiClient(nextItem.item.ServerId);`);

    // An old item's asynchronous preparation must not start or report after a
    // newer selection, account replacement or Stop has cancelled its intent.
    await replace(playback,
        '        function playInternal(item, playOptions, onPlaybackStartedFn, prevSource) {',
        '        function playInternal(item, playOptions, onPlaybackStartedFn, prevSource) {\n            if (playOptions.activityIsCurrent?.() === false) return Promise.resolve();');
    await replace(playback,
        '                .catch(onInterceptorRejection)\n                .then(() => {',
        '                .catch(error => { if (playOptions.activityIsCurrent?.() !== false) return onInterceptorRejection(error); })\n                .then(() => {');
    await replace(playback,
        '                .then((bitrate) => {\n                    return playAfterBitrateDetect',
        '                .then((bitrate) => {\n                    if (playOptions.activityIsCurrent?.() === false) return;\n                    return playAfterBitrateDetect');
    await replace(playback,
        '                        .catch(onPlaybackRejection);',
        '                        .catch(error => { if (playOptions.activityIsCurrent?.() !== false) return onPlaybackRejection(error); });');
    await replace(playback,
        '        function playAfterBitrateDetect(maxBitrate, item, playOptions, onPlaybackStartedFn, prevSource) {',
        '        function playAfterBitrateDetect(maxBitrate, item, playOptions, onPlaybackStartedFn, prevSource) {\n            if (playOptions.activityIsCurrent?.() === false) return Promise.resolve();');
    await replace(playback,
        '            return Promise.all([promise, player.getDeviceProfile(item), apiClient.getCurrentUser(), getSourceItem]).then(function (responses) {',
        '            return Promise.all([promise, player.getDeviceProfile(item), apiClient.getCurrentUser(), getSourceItem]).then(function (responses) {\n                if (playOptions.activityIsCurrent?.() === false) return;');
    await replace(playback,
        '                return getPlaybackMediaSource(player, apiClient, deviceProfile, item, mediaSourceId, options).then(async (mediaSource) => {',
        '                return getPlaybackMediaSource(player, apiClient, deviceProfile, item, mediaSourceId, options).then(async (mediaSource) => {\n                    if (playOptions.activityIsCurrent?.() === false) return;');
    await replace(playback,
        '                    const playedItem = await getItemOfMediaSource(apiClient, item, mediaSource, sourceItem);',
        '                    const playedItem = await getItemOfMediaSource(apiClient, item, mediaSource, sourceItem);\n                    if (playOptions.activityIsCurrent?.() === false) return;');
    await replace(playback,
        '                    return player.play(streamInfo).then(function () {\n                        loading.hide();',
        '                    return player.play(streamInfo).then(function () {\n                        if (playOptions.activityIsCurrent?.() === false) return;\n                        loading.hide();');
    await replace(playback,
        '                    }, function (err) {\n                        // TODO: Improve this',
        '                    }, function (err) {\n                        if (playOptions.activityIsCurrent?.() === false) return;\n                        // TODO: Improve this');
    await replace(playback,
        '                        setTimeout(function () {\n                            onPlaybackError.call(player, err, {',
        '                        setTimeout(function () {\n                            if (playOptions.activityIsCurrent?.() === false) return;\n                            onPlaybackError.call(player, err, {');
}
