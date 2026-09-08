import { ApiClient } from 'jellyfin-apiclient';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { appHost } from 'components/apphost';
import { playbackManager } from 'components/playback/playbackmanager';
import { appRouter } from 'components/router/appRouter';
import viewContainer from 'components/viewContainer';
import { queryClient } from 'utils/query/queryClient';
import SyncPlay from 'plugins/syncPlay/core';
import SyncPlaySettingsEditor from 'plugins/syncPlay/ui/settings/SettingsEditor';
import Events from 'utils/events';
import toast from 'components/toast/toast';
import { observeMediaPlaying } from './mediaEvents';
import { installPlaybackPermission } from './playbackPermission';
import { observeQueueFailures } from './queueErrors';
import { applyPresentation, observeVideoPresentation } from './presentation';
import { onDocumentExit } from './lifecycle';
import { observeNavigation, restoredNavigation } from './navigation';
import { createActivityController, preferredAccount } from './controller';
import { chooseAccount, confirmServerChange, showWatchMenu, showLoading, showStartupError, showClosed, mountPlaybackPermission } from './ui';
import './style.css';

let controller;
let launch;
let apiClient;
let ready = false;
let closed = false;
let switching = false;
let joining;
let reconnectTimer;
let pollTimer;
let accountDialog;
let stopClient = () => {};
let videoPresentation;
let navigation;
let status = 'Choose something to watch';
const deviceId = crypto.randomUUID();
const broker = window.JellyfinWatch;

function reportError(message) { toast({ text: message }); }

async function stopNative() {
    switching = true;
    clearTimeout(reconnectTimer);
    joining = undefined;
    stopClient();
    stopClient = () => {};
    // Unbind shared controls before stopping this device. Changing accounts must
    // never send Stop to the other people watching the same group.
    if (ready && SyncPlay.Manager.isSyncPlayEnabled()) SyncPlay.Manager.disableSyncPlay();
    if (ready) await playbackManager.stop();
    apiClient?.closeWebSocket();
    videoPresentation?.stop();
}

function watchNavigation(connection, route) {
    navigation?.dispose();
    navigation = observeNavigation(window, value => broker.normalizeNativeRoute(value, connection.serverId), (value, sequence, keepalive) =>
        broker.saveNativeRestore(controller.session.exchange.appToken, connection.id, value, sequence, keepalive), route);
}

async function installLaunch(next, connection, isCurrent) {
    if (!isCurrent()) return;
    const route = restoredNavigation(value => broker.normalizeNativeRoute(value, next.serverId), {
        sameAccount: controller.selection?.id === connection.id && launch?.serverId === next.serverId,
        currentRoute: navigation?.route || window.location.hash,
        restoreRoute: next.restoreRoute, initialHash: window.location.hash, ready
    });
    navigation?.dispose();
    navigation = undefined;
    await stopNative();
    if (!isCurrent()) return;
    // Both native query and cached view state belong to the selected account.
    queryClient.clear();
    if (ready) viewContainer.reset();
    ServerConnections.clearData();
    ServerConnections.getApiClients().splice(0);
    launch = next;
    const address = new URL(next.baseUrl, window.location.origin).href;
    const server = {
        Id: next.serverId, UserId: next.userId, AccessToken: next.accessToken,
        ManualAddress: address, manualAddressOnly: true, LastConnectionMode: 2
    };
    apiClient = new ApiClient(address, 'Jellyfin Watch', '10.11.11', 'Discord Activity', deviceId);
    apiClient.enableAutomaticNetworking = false;
    apiClient.manualAddressOnly = true;
    apiClient.serverInfo(server);
    apiClient.setAuthenticationInfo(next.accessToken, next.userId);
    ServerConnections.setLocalApiClient(apiClient);
    ServerConnections.addApiClient(apiClient);
    const result = await ServerConnections.connectToServer(server, {
        enableAutoLogin: true, enableWebSocket: false, reportCapabilities: false,
        enableAutomaticBitrateDetection: false
    });
    if (!isCurrent()) { apiClient.closeWebSocket(); return; }
    if (result.State !== 'SignedIn') throw new Error('Could not connect to your Jellyfin account. Try choosing it again.');
    ServerConnections.firstConnection = true;
    switching = false;
    if (ready) {
        // A hash navigation uses the current native document and Discord socket.
        await appRouter.show(route);
        if (!isCurrent()) return;
        watchNavigation(connection, route);
        watchClient();
    } else window.location.hash = route;
}

async function retry(action, message) {
    for (;;) {
        const loading = showLoading(message);
        try { return await action(); }
        catch {
            loading.close();
            await new Promise(resolve => {
                void showStartupError({ message: `${message.replace(/…$/, '')} failed. Try again.`, onRetry: () => { controller?.retryRecovery(); resolve(); } });
            });
        } finally { loading.close(); }
    }
}

export async function bootstrapDiscord() {
    if (!broker) throw new Error('The Discord connection module could not load.');
    document.documentElement.dataset.discordActivity = 'true';
    // The same document owns Discord RPC and native playback. Only preferences
    // may use the native storage shim; gateway identities stay in this closure.
    let credentials = { Servers: [] };
    ServerConnections.credentialProvider().credentials = value => {
        if (value) credentials = value;
        return credentials;
    };
    appHost.deviceId = () => deviceId;
    controller = createActivityController(broker, installLaunch, deviceId);
    const session = await retry(() => controller.start(), 'Connecting to Discord…');
    const stopPresentation = broker.observeActivityPresentation(session.discord, value => applyPresentation(document, value));
    onDocumentExit(window, () => {
        navigation?.flush(true);
        navigation?.dispose();
        closed = true;
        stopPresentation(); controller.dispose(); stopClient(); clearInterval(pollTimer); clearTimeout(reconnectTimer);
    });
    const { data, party } = await retry(() => controller.load(), 'Loading your accounts…');
    const preferred = preferredAccount(data, party, broker.matchesPartyServer);
    if (preferred) {
        try { await controller.select(preferred); return; }
        catch { /* Keep the account picker usable when a saved login has expired. */ }
    }
    await openAccounts(false, true, false);
}

export function openAccounts(changingServer = false, required = false, explicit = true) {
    if (closed) return Promise.resolve();
    if (accountDialog) return accountDialog;
    if (explicit) controller.retryRecovery();
    const userCall = (method, ...args) => { controller.retryRecovery(); return controller.call(method, ...args); };
    accountDialog = (async () => {
        let notice;
        do {
            const { data, party } = await retry(() => controller.load(), 'Loading your accounts…');
            const connection = await chooseAccount({
                data, party: changingServer ? null : party, changingServer, canCancel: !required,
                notice,
                onRefresh: () => userCall('getConnections'),
                onConnect: input => userCall('connectAccount', input),
                onCommunity: () => userCall('connectCommunity'),
                onDelete: id => userCall('deleteConnection', id),
                onQuickStart: serverUrl => userCall('startQuickConnect', serverUrl),
                onQuickPoll: (id, signal) => controller.call('pollQuickConnect', id, signal)
            });
            if (!connection) { if (required) continue; return; }
            if (changingServer && !(await confirmServerChange(connection))) continue;
            const loading = showLoading('Joining your watch party…');
            try { controller.retryRecovery(); await controller.select(connection, changingServer); return; }
            catch { notice = 'Could not join with that account. Check the server and try again.'; }
            finally { loading.close(); }
        } while (!closed);
    })().finally(() => { accountDialog = undefined; });
    return accountDialog;
}

async function joinParty() {
    const client = apiClient;
    if (closed || switching || joining?.client === client || !client?.isWebSocketOpen()) return;
    const attempt = { client, launch };
    joining = attempt;
    status = 'Joining watch party';
    try {
        const response = await client.joinSyncPlayGroup({ GroupId: attempt.launch.groupId });
        if (response && !response.ok) throw new Error('Join failed');
        if (joining === attempt && apiClient === client) status = 'Watching together';
    } catch {
        if (joining === attempt && apiClient === client) status = 'Could not join the watch party';
    } finally { if (joining === attempt) joining = undefined; }
}

function watchClient() {
    const client = apiClient;
    const stopQueue = observeQueueFailures(Events, client, launch.baseUrl, window.location.origin, reportError);
    const opened = () => { clearTimeout(reconnectTimer); void joinParty(); };
    const disconnected = () => {
        if (switching || closed) return;
        status = 'Reconnecting';
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            if (controller.selection && !controller.busy && !accountDialog) {
                void controller.select(controller.selection).catch(() => {
                    reportError('Could not reconnect. Choose your account to try again.');
                    void openAccounts(false, false, false);
                });
            }
        }, 40000);
    };
    Events.on(client, 'websocketopen', opened);
    Events.on(client, 'websocketclose', disconnected);
    stopClient = () => {
        stopQueue();
        Events.off(client, 'websocketopen', opened);
        Events.off(client, 'websocketclose', disconnected);
    };
    client.ensureWebSocket();
    if (client.isWebSocketOpen()) void joinParty();
}

export async function finishDiscordBootstrap() {
    ready = true;
    watchNavigation(controller.selection, window.location.hash);
    Events.on(SyncPlay.Manager, 'enabled', (_event, enabled) => { status = enabled ? 'Watching together' : 'Party disconnected'; });
    const stopObserving = observeMediaPlaying(document, value => value instanceof HTMLMediaElement, () => {
        status = 'Watching together';
    });
    videoPresentation = observeVideoPresentation(document, value => value instanceof HTMLVideoElement, () => {});
    const stopped = () => { videoPresentation.stop(); status = 'Choose something to watch'; };
    Events.on(playbackManager, 'playbackstop', stopped);
    const stopPermission = installPlaybackPermission(window, () => SyncPlay.Manager.getLastPlaybackCommand(), mountPlaybackPermission);
    onDocumentExit(window, () => { stopObserving(); videoPresentation.dispose(); stopPermission(); Events.off(playbackManager, 'playbackstop', stopped); });
    watchClient();
    let polling = false;
    pollTimer = setInterval(async () => {
        if (closed || polling || switching || controller.busy || accountDialog) return;
        polling = true;
        try {
            if (await controller.poll()) {
                navigation?.dispose();
                await stopNative();
                reportError('The party changed server. Choose your account to join.');
                void openAccounts(false, true, false);
            } else if (controller.needsLaunch && controller.selection) await controller.select(controller.selection);
        } catch (error) {
            if (error?.recoveryRequired) void openAccounts(false, false, false);
            // A temporary broker outage must not stop working playback.
        }
        finally { polling = false; }
    }, 5000);
}

export function openWatchMenu(anchor) {
    if (!controller || closed) return Promise.resolve();
    const manager = SyncPlay.Manager;
    return showWatchMenu({
        anchor, status,
        onInvite: async () => {
            const discord = controller.session.discord;
            if (!discord.sdk || !discord.guildId) { reportError('Use Discord’s channel invite or Join Activity controls.'); return; }
            try { await discord.sdk.commands.openInviteDialog(); }
            catch { reportError('Discord could not open an invite. Use the channel’s Join Activity controls.'); }
        },
        onAccounts: () => openAccounts(),
        onChangeServer: () => openAccounts(true),
        onLeave: async () => {
            try { await controller.leave(); }
            catch { reportError('Could not confirm sign-out. Try leaving again.'); return; }
            closed = true;
            navigation?.dispose();
            clearInterval(pollTimer);
            await stopNative();
            await showClosed({});
        },
        onSyncSettings: manager.isSyncPlayEnabled() ? () => new SyncPlaySettingsEditor(apiClient, manager.getTimeSyncCore(), { groupInfo: manager.getGroupInfo() }).embed() : undefined,
        onResumePlayback: manager.isSyncPlayEnabled() && !manager.isPlaylistEmpty() && !manager.isPlaybackActive() ? () => manager.resumeGroupPlayback(apiClient) : undefined,
        onHaltPlayback: manager.isSyncPlayEnabled() && manager.isPlaybackActive() ? () => manager.haltGroupPlayback(apiClient) : undefined
    });
}

export function failDiscordBootstrap() {
    void showStartupError({ message: 'Jellyfin could not start. Close this Activity and open it again.' });
}
