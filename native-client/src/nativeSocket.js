/** One Jellyfin 12 SDK socket serves both SDK subscriptions and legacy controls. */
export function installNativeSocket(client, events, isCurrent) {
    const sdk = client._sdk;
    const nativeSubscribe = sdk.subscribe.bind(sdk);
    const nativeUpdate = sdk.update.bind(sdk);
    const subscriptions = new Set();
    let closed = false;
    let observedSocket;
    let stopStatus;
    let hold;

    function observeStatus() {
        if (observedSocket === sdk.webSocket) return;
        stopStatus?.();
        observedSocket = sdk.webSocket;
        stopStatus = observedSocket.onStatusChange(status => {
            if (!closed && isCurrent()) events.trigger(client, status === 1 ? 'websocketopen' : 'websocketclose');
        });
    }

    function subscribe(types, callback) {
        if (closed) return () => {};
        let active = true;
        const stop = nativeSubscribe(types, message => {
            // Native callbacks can remain queued after another account replaces
            // this object, even when both accounts use the same server ID.
            if (active && !closed && isCurrent()) callback(message);
        });
        observeStatus();
        const unsubscribe = () => {
            if (!subscriptions.delete(unsubscribe)) return;
            active = false;
            stop();
        };
        subscriptions.add(unsubscribe);
        return unsubscribe;
    }

    sdk.subscribe = client.subscribe = subscribe;
    sdk.update = data => {
        if (closed) return;
        const next = { ...data };
        // Jellyfin's connection handshake repeats the same capability. The SDK
        // would otherwise close/reopen an existing socket for an unchanged URL.
        if (next.basePath === sdk.basePath) delete next.basePath;
        if (next.accessToken === sdk.accessToken) delete next.accessToken;
        return nativeUpdate(next);
    };
    client.isWebSocketOpen = () => !closed && isCurrent() && sdk.webSocket?.socketStatus === 1;
    client.ensureWebSocket = client.openWebSocket = () => {
        if (!closed && !hold) hold = subscribe(['KeepAlive'], () => {});
    };
    client.closeWebSocket = () => {
        if (closed) return;
        closed = true;
        stopStatus?.();
        for (const stop of [...subscriptions]) stop();
        sdk.webSocket?.disconnect();
        hold = undefined;
    };
}
