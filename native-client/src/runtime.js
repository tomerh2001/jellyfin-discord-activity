import { ApiClient } from 'jellyfin-apiclient';
import { flushSync } from 'react-dom';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { appHost } from 'components/apphost';
import { playbackManager } from 'components/playback/playbackmanager';
import { appRouter } from 'components/router/appRouter';
import viewContainer from 'components/viewContainer';
import { queryClient } from 'utils/query/queryClient';
import { setUserInfo } from 'scripts/settings/userSettings';
import Events from 'utils/events';
import toast from 'components/toast/toast';
import { installPlaybackPermission } from './playbackPermission';
import { observeQueueFailures } from './queueErrors';
import { observeWatchPresence } from './watchPresence';
import { applyPresentation, observeVideoPresentation } from './presentation';
import { onDocumentExit } from './lifecycle';
import { observeNavigation, restoredNavigation } from './navigation';
import { createActivityController, preferredAccount } from './controller';
import { beginAccountViewChange, finishAccountViewChange } from './accountViewState';
import { showParticipants, showLoading, showStartupError, mountPlaybackPermission } from './ui';
import { createActivityPlaybackClient } from './activityPlaybackClient';
import { createNativePlaybackAdapter } from './nativePlaybackAdapter';
import './style.css';

let controller;
let launch;
let apiClient;
let ready = false;
let closed = false;
let switching = false;
let partyPlayback;
let reconnectTimer;
let pollTimer;
let loginData;
let loginPending;
let logoutPending;
let participants;
let participantDialog;
let participantSnapshot = { participants: [], loading: true };
let stopClient = () => {};
let clearPresence = () => {};
let videoPresentation;
let resetPlaybackPermission = () => {};
let navigation;
const deviceId = crypto.randomUUID();
const broker = window.JellyfinWatch;

function reportError(message) { toast({ text: message }); }

async function stopNative() {
    const stoppingClient = apiClient;
    appRouter.cancelPendingNavigation();
    switching = true;
    resetPlaybackPermission();
    clearTimeout(reconnectTimer);
    stopClient();
    stopClient = () => {};
    await setUserInfo(null, null);
    if (apiClient !== stoppingClient) return;
    // stopClient restores local controls before account cleanup stops this device.
    if (ready) await playbackManager.stop();
    stoppingClient?.closeWebSocket();
    if (apiClient === stoppingClient) videoPresentation?.stop();
}

function watchNavigation(connection, route) {
    navigation?.dispose();
    navigation = observeNavigation(window, value => broker.normalizeNativeRoute(value, connection.serverId), (value, sequence, keepalive) =>
        broker.saveNativeRestore(controller.session.exchange.appToken, connection.id, value, sequence, keepalive), route);
}

async function installLaunch(next, connection, isCurrent) {
    if (!isCurrent()) return;
    try {
        const route = restoredNavigation(value => broker.normalizeNativeRoute(value, next.serverId), {
            sameAccount: controller.selection?.id === connection.id && launch?.serverId === next.serverId,
            currentRoute: navigation?.route || window.location.hash,
            restoreRoute: next.restoreRoute, initialHash: window.location.hash, ready
        });
        navigation?.dispose();
        navigation = undefined;
        await stopNative();
        if (!isCurrent()) return;
        // Modern Home retains imperative controllers inside React state. Suspend
        // account providers before clearing queries and remount them for the new client.
        flushSync(beginAccountViewChange);
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
        apiClient = new ApiClient(address, 'Jellyfin Watch', '12.0.0', 'Discord Activity', deviceId);
        apiClient.enableAutomaticNetworking = false;
        apiClient.manualAddressOnly = true;
        apiClient.serverInfo(server);
        apiClient.setAuthenticationInfo(next.accessToken, next.userId);
        ServerConnections.addApiClient(apiClient);
        ServerConnections.setLocalApiClient(apiClient);
        const installedClient = apiClient;
        const result = await ServerConnections.connectToServer(server, {
            enableAutoLogin: true, enableWebSocket: false, reportCapabilities: false,
            enableAutomaticBitrateDetection: false, isActivityCurrent: isCurrent
        });
        if (!isCurrent()) { installedClient.closeWebSocket(); return; }
        if (result.State !== 'SignedIn') throw new Error('Could not connect to your Jellyfin account. Sign in to try again.');
        ServerConnections.firstConnection = true;
        if (ready) {
            await watchClient();
            if (!isCurrent()) return;
        }
        switching = false;
        flushSync(finishAccountViewChange);
        if (ready) {
            // A hash navigation uses the current native document and Discord socket.
            await appRouter.show(route);
            if (!isCurrent()) return;
            watchNavigation(connection, route);
        } else window.location.hash = route;
    } catch (error) {
        if (isCurrent()) {
            await clearNativeAccount();
            if (ready) {
                await appRouter.show('/login');
                reportError('Could not connect to Jellyfin. Sign in to try again.');
            }
        }
        throw error;
    }
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
    participants = broker.observeActivityParticipants(session.discord, value => {
        participantSnapshot = value;
        participantDialog?.update(value);
    });
    onDocumentExit(window, () => {
        navigation?.flush(true);
        navigation?.dispose();
        closed = true;
        participants.dispose(); participantDialog?.close(); stopPresentation(); controller.dispose(); stopClient(); clearInterval(pollTimer); clearTimeout(reconnectTimer);
    });
    const { data, party } = await retry(() => controller.load(), 'Loading your accounts…');
    loginData = { data, party };
    const preferred = preferredAccount(data, party, broker.matchesPartyServer);
    if (preferred) {
        try { await controller.select(preferred); return; }
        catch { await clearNativeAccount(); }
    }
    ServerConnections.firstConnection = true;
    window.location.hash = '/login';
}

export async function getLoginOptions() {
    if (!loginData) { controller.retryRecovery(); loginData = await controller.load(); }
    const { data, party } = loginData;
    const partyServerUrl = party && (party.serverUrl === data.canonicalDefaultServerUrl ? data.defaultServerUrl : party.serverUrl);
    return {
        defaultServerUrl: data.defaultServerUrl, partyServerUrl,
        communityAvailable: data.communityAvailable && (!party || party.serverUrl === data.canonicalDefaultServerUrl)
    };
}

export async function loginJellyfin(input, isCurrent = () => true) {
    if (closed || !isCurrent()) return;
    if (loginPending || logoutPending) throw new Error('Sign-in is still finishing. Try again in a moment.');
    controller.retryRecovery();
    loginPending = (async () => {
        const connection = input ? await controller.call('connectAccount', input) : await controller.call('connectCommunity');
        if (!isCurrent() || closed) return;
        await controller.select(connection);
        loginData = undefined;
    })().catch(error => { loginData = undefined; throw error; })
        .finally(() => { loginPending = undefined; });
    return loginPending;
}

async function clearNativeAccount() {
    navigation?.dispose(); navigation = undefined;
    await stopNative();
    flushSync(beginAccountViewChange);
    queryClient.clear();
    if (ready) viewContainer.reset();
    ServerConnections.clearData();
    ServerConnections.getApiClients().splice(0);
    // Upstream setLocalApiClient ignores null; explicitly drop its local pointer.
    ServerConnections.localApiClient = null;
    window.ApiClient = undefined;
    apiClient = undefined;
    launch = undefined;
    ServerConnections.firstConnection = true;
    switching = false;
    flushSync(finishAccountViewChange);
}

export function logoutJellyfin() {
    if (logoutPending) return logoutPending;
    logoutPending = (async () => {
        try {
            controller.retryRecovery();
            // Revoke only this saved Jellyfin login; Discord and other viewers remain.
            await controller.logoutAccount();
            await clearNativeAccount();
            loginData = undefined;
            await appRouter.show('/login');
        } catch {
            reportError('Could not sign out. Try again.');
        }
    })().finally(() => { logoutPending = undefined; });
    return logoutPending;
}

export async function openAccounts() {
    if (closed) return;
    controller.cancelSelection();
    if (apiClient) await clearNativeAccount();
    loginData = undefined;
    controller.retryRecovery();
    if (ready) await appRouter.show('/login');
    else window.location.hash = '/login';
}

function watchClient() {
    const client = apiClient;
    const playback = createNativePlaybackAdapter({ playbackManager, events: Events, apiClient: client,
        baseUrl: launch.baseUrl, createClient: createActivityPlaybackClient, onError: reportError });
    partyPlayback = playback;
    const discord = controller.session.discord;
    const presence = observeWatchPresence({ document, playbackManager, events: Events,
        publisher: broker.createWatchPresence(discord),
        isCurrent: () => !closed && !switching && apiClient === client && controller.session.discord === discord
            && !controller.needsLaunch && client.isWebSocketOpen()
            && Date.parse(controller.session.exchange.expiresAt) > Date.now() });
    clearPresence = presence.clear;
    const stopQueue = observeQueueFailures(Events, client, launch.baseUrl, window.location.origin, reportError);
    const opened = () => { clearTimeout(reconnectTimer); presence.refresh(); };
    const disconnected = () => {
        if (switching || closed) return;
        presence.clear();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            if (controller.selection && !controller.busy && !loginPending && !logoutPending) {
                void controller.select(controller.selection).catch(() => {
                    reportError('Could not reconnect. Sign in to try again.');
                    void openAccounts();
                });
            }
        }, 40000);
    };
    Events.on(client, 'websocketopen', opened);
    Events.on(client, 'websocketclose', disconnected);
    stopClient = () => {
        playback.dispose();
        if (partyPlayback === playback) partyPlayback = undefined;
        presence.dispose();
        clearPresence = () => {};
        stopQueue();
        Events.off(client, 'websocketopen', opened);
        Events.off(client, 'websocketclose', disconnected);
    };
    client.ensureWebSocket();
    return playback.start();
}

export async function finishDiscordBootstrap() {
    ready = true;
    if (controller.selection) watchNavigation(controller.selection, window.location.hash);
    videoPresentation = observeVideoPresentation(document, value => value instanceof HTMLVideoElement, () => {});
    const stopped = () => { resetPlaybackPermission(); videoPresentation.stop(); };
    Events.on(playbackManager, 'playbackstop', stopped);
    const stopPermission = installPlaybackPermission(window, () => {
        const state = partyPlayback?.getSnapshot();
        return { Command: !state?.queue?.length ? 'Stop' : state.paused ? 'Pause' : 'Unpause' };
    }, mountPlaybackPermission);
    resetPlaybackPermission = stopPermission.reset;
    onDocumentExit(window, () => { videoPresentation.dispose(); stopPermission(); Events.off(playbackManager, 'playbackstop', stopped); });
    if (apiClient) await watchClient();
    let polling = false;
    pollTimer = setInterval(async () => {
        if (closed || polling || switching || controller.busy || loginPending || logoutPending || !apiClient) return;
        polling = true;
        try {
            if (await controller.poll()) {
                navigation?.dispose();
                await stopNative();
                reportError('The party changed server. Sign in to join.');
                void openAccounts();
            } else if (controller.needsLaunch && controller.selection) await controller.select(controller.selection);
        } catch (error) {
            if (error?.recoveryRequired) { clearPresence(); void openAccounts(); }
            // A temporary broker outage must not stop working playback.
        }
        finally { polling = false; }
    }, 5000);
}

export function openWatchMenu() {
    if (!controller || closed) return Promise.resolve();
    if (participantDialog) return participantDialog.result;
    const dialog = showParticipants(participantSnapshot);
    participantDialog = dialog;
    void participants.refresh();
    void dialog.result.finally(() => { if (participantDialog === dialog) participantDialog = undefined; });
    return dialog.result;
}

export function failDiscordBootstrap() {
    void showStartupError({ message: 'Jellyfin could not start. Close this Activity and open it again.' });
}
