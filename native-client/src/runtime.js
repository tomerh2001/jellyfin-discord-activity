import { ApiClient } from 'jellyfin-apiclient';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { appHost } from 'components/apphost';
import { playbackManager } from 'components/playback/playbackmanager';
import SyncPlay from 'plugins/syncPlay/core';
import playbackPermissionManager from 'plugins/syncPlay/ui/playbackPermissionManager';
import Events from 'utils/events';
import { waitForParent, sendStatus } from './bridge';
import { observeMediaPlaying } from './mediaEvents';
import './style.css';

let launch;
let apiClient;
let joinPending = false;
let reconnectTimer;

export async function bootstrapDiscord() {
    launch = await waitForParent(window);
    document.documentElement.dataset.discordActivity = 'true';
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
    window.addEventListener('pagehide', () => clearTimeout(reconnectTimer), { once: true });
    Events.on(ServerConnections, 'localusersignedout', () => sendStatus(window, launch.nonce, 'signed-out'));
    const stopObserving = observeMediaPlaying(document, value => value instanceof HTMLMediaElement, () => {
        document.querySelector('.discordPlaybackPermission')?.remove();
        sendStatus(window, launch.nonce, 'playing');
    });
    window.addEventListener('pagehide', stopObserving, { once: true });
    Events.on(playbackManager, 'playbackstop', () => sendStatus(window, launch.nonce, 'browsing'));
    apiClient.ensureWebSocket();
    if (apiClient.isWebSocketOpen()) await joinParty();
    addPlaybackPermissionButton();
}

function addPlaybackPermissionButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'discordPlaybackPermission';
    button.textContent = 'Tap to enable playback';
    button.addEventListener('click', () => {
        // This call must originate in the child's own click handler on mobile.
        playbackPermissionManager.check().then(() => {
            // Native Manager.resumeGroupPlayback only loads this viewer’s queue and
            // sets IgnoreWait=false. It does not send /SyncPlay/Unpause; native
            // playback commands retain the party’s existing paused/playing state.
            if (SyncPlay.Manager.isSyncPlayEnabled()) SyncPlay.Manager.resumeGroupPlayback(apiClient);
            button.remove();
        }).catch(() => { button.textContent = 'Tap again to enable playback'; });
    });
    document.body.appendChild(button);
}

export function failDiscordBootstrap() {
    if (launch) sendStatus(window, launch.nonce, 'error');
    document.body.replaceChildren();
    const error = document.createElement('p');
    error.className = 'discordNativeError';
    error.textContent = 'Jellyfin could not connect. Return to the Activity and try again.';
    document.body.appendChild(error);
}
