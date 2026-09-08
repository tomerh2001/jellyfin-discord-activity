export const CHANNEL = 'jellyfin-watch-native';

export function validLaunch(value, origin) {
    if (!value || typeof value !== 'object') return false;
    const fields = ['accessToken', 'userId', 'serverId', 'deviceId', 'groupId'];
    if (!fields.every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length < 1024)) return false;
    if (typeof value.baseUrl !== 'string' || !/^\/jf\/[a-zA-Z0-9_-]+$/.test(value.baseUrl)) return false;
    return new URL(value.baseUrl, origin).origin === origin;
}

/** Bootstrap credentials are delivered only to this child, never in its URL. */
export function waitForParent(host, timeoutMs = 60000) {
    if (host.parent === host) return Promise.reject(new Error('Open Jellyfin Watch from Discord.'));
    const nonce = host.crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            host.removeEventListener('message', receive);
            host.clearTimeout(timeout);
        };
        const receive = event => {
            if (event.source !== host.parent || event.origin !== host.location.origin) return;
            const data = event.data;
            if (data?.channel !== CHANNEL || data.type !== 'bootstrap' || data.nonce !== nonce) return;
            if (!validLaunch(data.launch, host.location.origin)) {
                cleanup();
                reject(new Error('Invalid Jellyfin connection.'));
                return;
            }
            cleanup();
            resolve({ ...data.launch, nonce });
        };
        const timeout = host.setTimeout(() => {
            cleanup();
            reject(new Error('The Discord connection timed out. Reopen the Activity.'));
        }, timeoutMs);
        host.addEventListener('message', receive);
        host.parent.postMessage({ channel: CHANNEL, type: 'ready', nonce }, host.location.origin);
    });
}

export function sendStatus(host, nonce, status, extra = {}) {
    host.parent.postMessage({ channel: CHANNEL, type: 'status', nonce, status, ...extra }, host.location.origin);
}
