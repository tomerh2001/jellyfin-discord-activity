const messages = {
    native_invalid_queue: 'Jellyfin could not prepare this selection. Open a movie or an individual episode and try again.',
    native_queue_empty: 'This selection has no playable items. Open an individual movie or episode and try again.',
    native_queue_too_large: 'This selection has more than 500 items. Choose a season or a smaller selection.'
};

export function nativeQueueFailureMessage(failure, baseUrl, origin) {
    if (!failure || failure.status !== 400 || !Object.hasOwn(messages, failure.errorCode)) return;
    if (typeof failure.url !== 'string' || !/^\/jf\/[A-Za-z0-9_-]+$/.test(baseUrl)) return;
    let url;
    try { url = new URL(failure.url, origin); } catch { return; }
    if (url.origin !== origin || !url.pathname.startsWith(`${baseUrl}/`)) return;
    if (!/^\/SyncPlay\/(?:SetNewQueue|Queue)$/i.test(url.pathname.slice(baseUrl.length))) return;
    return messages[failure.errorCode];
}

export function observeQueueFailures(events, apiClient, baseUrl, origin, notify) {
    const listener = (_event, failure) => {
        const message = nativeQueueFailureMessage(failure, baseUrl, origin);
        if (message) notify(message);
    };
    events.on(apiClient, 'requestfail', listener);
    return () => events.off(apiClient, 'requestfail', listener);
}
