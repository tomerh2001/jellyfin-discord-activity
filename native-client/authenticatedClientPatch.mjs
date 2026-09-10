/** Native login renders before the first authenticated Jellyfin ApiClient. */
export async function patchAuthenticatedClient(replace) {
    const plugin = 'src/plugins/syncPlay/plugin.ts';
    await replace(plugin,
        `        Events.on(playbackManager, 'playerchange', (_, newPlayer) => {
            SyncPlay.Manager.onPlayerChange(newPlayer);
        });`,
        `        Events.on(playbackManager, 'playerchange', (_, newPlayer) => {
            // The login route has no authenticated player or manager yet.
            if (SyncPlay.Manager.getPlayerWrapper()) SyncPlay.Manager.onPlayerChange(newPlayer);
        });`);
    await replace(plugin,
        `        // Start SyncPlay.
        const apiClient = ServerConnections.currentApiClient();
        if (apiClient) SyncPlay.Manager.init(apiClient);

        // FIXME: Multiple apiClients?
        Events.on(ServerConnections, 'apiclientcreated', (_, newApiClient) => SyncPlay.Manager.init(newApiClient));
        Events.on(ServerConnections, 'localusersignedin', () => SyncPlay.Manager.updateApiClient(ServerConnections.currentApiClient()));
        Events.on(ServerConnections, 'localusersignedout', () => SyncPlay.Manager.updateApiClient(ServerConnections.currentApiClient()));`,
        `        // Initialize once, when the first login supplies its ApiClient.
        // Later account changes reuse the cores and their existing listeners.
        const updateApiClient = (apiClient: ReturnType<typeof ServerConnections.currentApiClient>) => {
            if (!apiClient) return;
            if (SyncPlay.Manager.getPlayerWrapper()) SyncPlay.Manager.updateApiClient(apiClient);
            else SyncPlay.Manager.init(apiClient);
        };
        updateApiClient(ServerConnections.currentApiClient());

        Events.on(ServerConnections, 'apiclientcreated', (_, apiClient) => updateApiClient(apiClient));
        Events.on(ServerConnections, 'localusersignedin', () => updateApiClient(ServerConnections.currentApiClient()));
        Events.on(ServerConnections, 'localusersignedout', () => updateApiClient(ServerConnections.currentApiClient()));`);

    const connection = 'src/lib/jellyfin-apiclient/connectionManager.js';
    await replace(connection,
        'function updateServerInfo(server, systemInfo) {',
        `function isActivityCurrent(options) {
    return typeof options?.isActivityCurrent !== 'function' || options.isActivityCurrent();
}

function updateServerInfo(server, systemInfo) {`);
    await replace(connection,
        '        function onLocalUserSignIn(server, serverUrl, user) {',
        `        function onLocalUserSignIn(server, serverUrl, user, options = {}) {
            if (!isActivityCurrent(options)) return Promise.resolve();`);
    await replace(connection,
        'self.onLocalUserSignedIn.call(self, user)',
        'self.onLocalUserSignedIn.call(self, user, options)');
    await replace(connection,
        "                events.trigger(self, 'localusersignedin', [user]);",
        "                if (isActivityCurrent(options)) events.trigger(self, 'localusersignedin', [user]);");
    await replace(connection,
        'return onLocalUserSignIn(server, apiClient.serverAddress(), result.User);',
        'return onLocalUserSignIn(server, apiClient.serverAddress(), result.User, options);');
    await replace(connection,
        `                options = options || {};

                tryReconnect(server).then(
                    (result) => {`,
        `                options = options || {};
                if (!isActivityCurrent(options)) { resolve({ State: ConnectionState.Unavailable }); return; }

                tryReconnect(server).then(
                    (result) => {
                        if (!isActivityCurrent(options)) { resolve({ State: ConnectionState.Unavailable }); return; }`);
    await replace(connection,
        '        function onSuccessfulConnection(server, systemInfo, connectionMode, serverUrl, verifyLocalAuthentication, resolve, options = {}) {',
        `        function onSuccessfulConnection(server, systemInfo, connectionMode, serverUrl, verifyLocalAuthentication, resolve, options = {}) {
            if (!isActivityCurrent(options)) { resolve({ State: ConnectionState.Unavailable }); return; }`);
    await replace(connection,
        `            const resolveActions = function () {
                resolve(result);`,
        `            const resolveActions = function () {
                if (!isActivityCurrent(options)) { resolve({ State: ConnectionState.Unavailable }); return; }
                resolve(result);`);
    await replace(connection,
        `                result.ApiClient.getCurrentUser().then((user) => {
                    onLocalUserSignIn(server, serverUrl, user).then(resolveActions, resolveActions);`,
        `                result.ApiClient.getCurrentUser().then((user) => {
                    if (!isActivityCurrent(options)) { resolve({ State: ConnectionState.Unavailable }); return; }
                    onLocalUserSignIn(server, serverUrl, user, options).then(resolveActions, resolveActions);`);

    const servers = 'src/lib/jellyfin-apiclient/ServerConnections.js';
    await replace(servers,
        `    onLocalUserSignedIn(user) {
        const apiClient = this.getApiClient(user.ServerId);
        this.setLocalApiClient(apiClient);
        setTimeout(() => detectBitrate(this.getApi(user.ServerId), true), 6000);
        return setUserInfo(user.Id, apiClient).then(() => {`,
        `    onLocalUserSignedIn(user, options = {}) {
        const apiClient = this.getApiClient(user.ServerId);
        const isCurrent = () => apiClient && this.getApiClient(user.ServerId) === apiClient
            && (typeof options.isActivityCurrent !== 'function' || options.isActivityCurrent());
        if (!isCurrent()) return Promise.resolve();
        this.setLocalApiClient(apiClient);
        setTimeout(() => { if (isCurrent()) detectBitrate(this.getApi(user.ServerId), true); }, 6000);
        return setUserInfo(user.Id, apiClient).then(() => {
            if (!isCurrent()) return;`);
    // Login/logout can overlap an outstanding preferences query. Its response
    // may complete, but cannot reattach a departed account's settings.
    await replace('src/scripts/settings/userSettings.js',
        `            .then(result => {
                result.CustomPrefs = result.CustomPrefs || {};
                self.displayPrefs = result;
            });`,
        `            .then(result => {
                if (self.currentUserId !== userId || self.currentApiClient !== apiClient) return;
                result.CustomPrefs = result.CustomPrefs || {};
                self.displayPrefs = result;
            });`);
}
