import { ApiClient } from 'jellyfin-apiclient';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { appHost } from 'components/apphost';
import { playbackManager } from 'components/playback/playbackmanager';
import SyncPlay from 'plugins/syncPlay/core';
import Events from 'utils/events';
import toast from 'components/toast/toast';
import { waitForParent, sendStatus, observePresentation, sendVideoState } from './bridge';
import { observeMediaPlaying } from './mediaEvents';
import { installPlaybackPermission } from './playbackPermission';
import { observeQueueFailures } from './queueErrors';
import { applyPresentation, observeVideoPresentation } from './presentation';
import { onDocumentExit } from './lifecycle';
import './style.css';

let launch;
let apiClient;
let joinPending = false;
let reconnectTimer;

export async function bootstrapDiscord() {
    launch = await waitForParent(window);
    document.documentElement.dataset.discordActivity = 'true';
    applyPresentation(document, launch.presentation);
    const stopPresentation = observePresentation(window, launch.nonce, value => applyPresentation(document, value));
    onDocumentExit(window, stopPresentation);
    // The native client may remember playback preferences, but gateway credentials
    // must disappear with this frame. The broker stores real server credentials.
    let credentials = { Servers: [] };
    ServerConnections.credentialProvider().credentials = value => {
        if (value) credentials = value;
        return credentials;
    };
    appHost.deviceId = () => launch.deviceId;
    const address = new URL(launch.baseUrl, window.location.origin).href;
    const server = {
        Id: launch.serverId, UserId: launch.userId, AccessToken: launch.accessToken,
        ManualAddress: address, manualAddressOnly: true, LastConnectionMode: 2
    };
    apiClient = new ApiClient(address, 'Jellyfin Watch', '10.11.11', 'Discord Activity', launch.deviceId);
    apiClient.enableAutomaticNetworking = false;
    apiClient.manualAddressOnly = true;
    apiClient.serverInfo(server);
    apiClient.setAuthenticationInfo(launch.accessToken, launch.userId);
    ServerConnections.addApiClient(apiClient);
    ServerConnections.setLocalApiClient(apiClient);
    const result = await ServerConnections.connectToServer(server, {
        enableAutoLogin: true, enableWebSocket: false, reportCapabilities: false,
        enableAutomaticBitrateDetection: false
    });
    if (result.State !== 'SignedIn') throw new Error('Could not connect to your Jellyfin account.');
    ServerConnections.firstConnection = true;
    window.location.hash = '#/home';
}

async function joinParty() {
    if (joinPending || !apiClient.isWebSocketOpen()) return;
    joinPending = true;
    sendStatus(window, launch.nonce, 'joining');
    try {
        const response = await apiClient.joinSyncPlayGroup({ GroupId: launch.groupId });
        if (response && !response.ok) throw new Error('Join failed');
    } catch {
        sendStatus(window, launch.nonce, 'error');
    } finally {
        joinPending = false;
    }
}

export async function finishDiscordBootstrap() {
    const stopQueueFailures = observeQueueFailures(Events, apiClient, launch.baseUrl, window.location.origin,
        text => toast({ text }));
    onDocumentExit(window, stopQueueFailures);
    Events.on(SyncPlay.Manager, 'enabled', (_event, enabled) => {
        sendStatus(window, launch.nonce, enabled ? 'connected' : 'disconnected', { groupId: launch.groupId });
    });
    Events.on(SyncPlay.Manager, 'group-state-update', (_event, state) => {
        sendStatus(window, launch.nonce, 'playback', { state: String(state).slice(0, 32) });
    });
    Events.on(apiClient, 'websocketopen', () => { clearTimeout(reconnectTimer); void joinParty(); });
    Events.on(apiClient, 'websocketclose', () => {
        sendStatus(window, launch.nonce, 'reconnecting');
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => sendStatus(window, launch.nonce, 'reauthorize'), 40000);
    });
    onDocumentExit(window, () => clearTimeout(reconnectTimer));
    Events.on(ServerConnections, 'localusersignedout', () => sendStatus(window, launch.nonce, 'signed-out'));
    const stopObserving = observeMediaPlaying(document, value => value instanceof HTMLMediaElement, () => {
        document.querySelector('.discordPlaybackPermission')?.remove();
        sendStatus(window, launch.nonce, 'playing');
    });
    onDocumentExit(window, stopObserving);
    const videoPresentation = observeVideoPresentation(document, value => value instanceof HTMLVideoElement,
        active => sendVideoState(window, launch.nonce, active));
    onDocumentExit(window, videoPresentation.dispose);
    Events.on(playbackManager, 'playbackstop', () => {
        videoPresentation.stop();
        sendStatus(window, launch.nonce, 'browsing');
    });
    const stopPlaybackPermission = installPlaybackPermission(window, () => SyncPlay.Manager.getLastPlaybackCommand());
    onDocumentExit(window, stopPlaybackPermission);
    apiClient.ensureWebSocket();
    if (apiClient.isWebSocketOpen()) await joinParty();
}

export function failDiscordBootstrap() {
    if (launch) sendStatus(window, launch.nonce, 'error');
    document.body.replaceChildren();
    const error = document.createElement('p');
    error.className = 'discordNativeError';
    error.textContent = 'Jellyfin could not connect. Return to the Activity and try again.';
    document.body.appendChild(error);
}
