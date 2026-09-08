/** Remember browsing only. SyncPlay remains the authority for media and position. */
export function observeNavigation(host, normalize, save, initialRoute = '#/home') {
    let route = normalize(initialRoute) || '#/home';
    let sequence = 0;
    let disposed = false;
    const capture = () => {
        const next = normalize(host.location.hash);
        if (next) route = next;
    };
    const flush = (keepalive = false) => {
        if (disposed) return;
        capture();
        // Sequence is scoped to the launched viewer. A late older request must
        // not replace the final page saved while Discord moves the document.
        try { void Promise.resolve(save(route, ++sequence, keepalive)).catch(() => {}); }
        catch { /* A checkpoint failure must not interrupt browsing/playback. */ }
    };
    const changed = () => { capture(); flush(true); };
    host.addEventListener('hashchange', changed);
    // Native history.pushState does not necessarily emit hashchange.
    host.document.addEventListener('viewshow', changed);
    const timer = host.setInterval(() => flush(), 30_000);
    flush();
    return {
        get route() { capture(); return route; },
        flush,
        dispose() {
            if (disposed) return;
            disposed = true;
            host.clearInterval(timer);
            host.removeEventListener('hashchange', changed);
            host.document.removeEventListener('viewshow', changed);
        }
    };
}

export function restoredNavigation(normalize, { sameAccount, currentRoute, restoreRoute, initialHash, ready }) {
    if (sameAccount) return normalize(currentRoute) || '#/home';
    if (!ready) return normalize(restoreRoute) || normalize(initialHash) || '#/home';
    return '#/home';
}
