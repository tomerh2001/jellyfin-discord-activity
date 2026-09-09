import assert from 'node:assert/strict';
import test from 'node:test';
import { installNativeSocket } from '../src/nativeSocket.js';

function fixture() {
    const callbacks = new Set(); const status = new Set(); const notifications = [];
    let current = true; let physicalSockets = 0; let disconnects = 0;
    const updates = [];
    const sdk = { basePath: 'https://activity.test/jf/synthetic', accessToken: 'synthetic',
        subscribe(types, callback) {
            if (!this.webSocket) {
                physicalSockets++;
                this.webSocket = { socketStatus: 'disconnected',
                    onStatusChange: callback => { status.add(callback); return () => status.delete(callback); },
                    disconnect: () => { disconnects++; this.webSocket.socketStatus = 'disconnected'; } };
            }
            const subscription = { types, callback }; callbacks.add(subscription);
            return () => callbacks.delete(subscription);
        },
        update(data) { updates.push(data); if (data.basePath || data.accessToken) physicalSockets++; }
    };
    const client = { _sdk: sdk, openWebSocket: assert.fail, ensureWebSocket: assert.fail, closeWebSocket: assert.fail };
    installNativeSocket(client, { trigger: (target, event) => { assert.equal(target, client); notifications.push(event); } }, () => current);
    return { client, sdk, callbacks, status, notifications, updates, current: value => { current = value; },
        sockets: () => physicalSockets, disconnects: () => disconnects,
        connection(value) { sdk.webSocket.socketStatus = value; for (const callback of status) callback(value); } };
}

test('legacy lifecycle and native SDK subscribers share one physical transport and reconnect status', () => {
    const f = fixture(); const messages = [];
    const unsubscribe = f.client.subscribe(['SyncPlayCommand'], value => messages.push(value));
    f.sdk.subscribe(['UserDataChanged'], () => {});
    f.client.ensureWebSocket(); f.client.openWebSocket(); f.client.ensureWebSocket();
    assert.equal(f.sockets(), 1); assert.equal(f.status.size, 1);
    assert.equal(f.client.isWebSocketOpen(), false);
    f.connection(1); assert.equal(f.client.isWebSocketOpen(), true);
    const callback = [...f.callbacks][0].callback; callback({ Data: 'play' }); assert.deepEqual(messages, [{ Data: 'play' }]);
    unsubscribe(); callback({ Data: 'late' }); assert.equal(messages.length, 1);
    f.connection('disconnected'); assert.equal(f.client.isWebSocketOpen(), false);
    f.connection(1); assert.deepEqual(f.notifications, ['websocketopen', 'websocketclose', 'websocketopen']);
    f.client.closeWebSocket(); assert.equal(f.callbacks.size, 0); assert.equal(f.status.size, 0); assert.equal(f.disconnects(), 1);
});

test('repeated native authentication metadata does not reconnect an unchanged capability', () => {
    const f = fixture(); f.client.ensureWebSocket();
    f.sdk.update({ basePath: f.sdk.basePath, accessToken: f.sdk.accessToken, clientInfo: { name: 'Jellyfin Watch' } });
    assert.equal(f.sockets(), 1); assert.deepEqual(f.updates, [{ clientInfo: { name: 'Jellyfin Watch' } }]);
    f.sdk.update({ accessToken: 'replacement' }); assert.equal(f.sockets(), 2);
    f.client.closeWebSocket();
});

test('replaced and disposed clients cannot publish messages, reopen sockets or reuse subscriptions', () => {
    const f = fixture(); let messages = 0;
    f.client.subscribe(['SyncPlayCommand'], () => messages++);
    const message = [...f.callbacks][0].callback;
    const change = [...f.status][0];
    f.current(false); message({ Data: 'old' }); f.connection(1);
    assert.equal(messages, 0); assert.equal(f.notifications.length, 0); assert.equal(f.client.isWebSocketOpen(), false);
    f.client.closeWebSocket(); f.current(true); message({ Data: 'closed' }); change(1);
    f.client.ensureWebSocket(); f.client.openWebSocket(); f.sdk.subscribe(['UserDataChanged'], () => {});
    f.sdk.update({ basePath: 'https://activity.test/jf/replaced', accessToken: 'replacement' });
    f.client.closeWebSocket();
    assert.equal(messages, 0); assert.equal(f.notifications.length, 0); assert.equal(f.sockets(), 1);
    assert.equal(f.updates.length, 0); assert.equal(f.disconnects(), 1); assert.equal(f.callbacks.size, 0);
});
