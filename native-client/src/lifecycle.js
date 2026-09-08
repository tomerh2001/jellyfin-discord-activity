/** Jellyfin also bubbles CustomEvent('pagehide') from each departing SPA view. */
export function onDocumentExit(host, cleanup) {
    const remove = () => host.removeEventListener('pagehide', receive);
    const receive = event => {
        if (event.target !== host || !(event instanceof host.PageTransitionEvent) || event.persisted) return;
        remove();
        cleanup();
    };
    // Do not use once: a filtered bubbling event would still consume it.
    host.addEventListener('pagehide', receive);
    return remove;
}
