// Controller state for the Modern Jellyfin dialogs. Rendering belongs to the
// single React host so bootstrap and account transitions share the same UI.
export function createNativeUi({ onChange = () => {}, toast = () => {} } = {}) {
    let sequence = 0;
    let snapshot = [];
    const listeners = new Set();
    const publish = () => { onChange(); for (const listener of listeners) listener(); };
    const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
    const getSnapshot = () => snapshot;
    const safeError = (cause, fallback = 'Could not connect. Try again.') =>
        cause instanceof Error && cause.message ? cause.message.slice(0, 500) : fallback;

    function handleCommand(event) {
        const top = snapshot.at(-1);
        if (!top || event.detail?.command !== 'back') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        top.dismiss();
    }

    function open(kind, state, canDismiss = () => true, cleanup = () => {}) {
        const id = ++sequence;
        let closed = false;
        let resolve;
        const result = new Promise(done => { resolve = done; });
        const dialog = {
            result,
            get closed() { return closed; },
            update(patch) {
                if (closed) return;
                snapshot = snapshot.map(item => item.id === id ? { ...item, ...patch } : item);
                publish();
            },
            close(value) {
                if (closed) return;
                closed = true;
                cleanup();
                snapshot = snapshot.filter(item => item.id !== id);
                publish();
                resolve(value);
            },
            dismiss() { if (canDismiss()) dialog.close(); }
        };
        snapshot = [...snapshot, { id, kind, ...state, dismiss: dialog.dismiss }];
        publish();
        return dialog;
    }

    function showParticipants(participants) {
        const dialog = open('participants', { participants });
        return {
            result: dialog.result,
            update: value => dialog.update({ participants: value }),
            close: () => dialog.close()
        };
    }

    function showLoading(text = 'Connecting to Discord…') {
        const dialog = open('loading', { text }, () => false);
        return { close: () => dialog.close() };
    }

    async function showStartupError({ message, onRetry, onLeave }) {
        let pending = false;
        const dialog = open('startupError', { error: message || 'The connection was interrupted. Try again.', pending }, () => false);
        const perform = async callback => {
            if (pending || dialog.closed) return;
            pending = true; dialog.update({ pending });
            try { await callback(); dialog.close(); }
            catch (cause) { dialog.update({ error: safeError(cause) }); }
            finally { pending = false; dialog.update({ pending }); }
        };
        dialog.update({ retry: onRetry ? () => perform(onRetry) : undefined, leave: onLeave ? () => perform(onLeave) : undefined });
        await dialog.result;
    }

    async function showClosed({ onClose } = {}) {
        let pending = false;
        const dialog = open('closed', { pending }, () => Boolean(onClose) && !pending);
        if (onClose) dialog.update({ exit: async () => {
            if (pending || dialog.closed) return;
            pending = true; dialog.update({ pending });
            try { await onClose(); dialog.close(); }
            catch { toast('You are signed out. Close this Activity in Discord.'); }
            finally { pending = false; dialog.update({ pending }); }
        } });
        await dialog.result;
    }

    function mountPlaybackPermission({ onActivate, label, disabled = false }) {
        const dialog = open('playbackPermission', { onActivate, label, disabled }, () => false);
        return { update: patch => dialog.update(patch), close: () => dialog.close() };
    }

    return { subscribe, getSnapshot, handleCommand, showParticipants, showLoading,
        showStartupError, showClosed, mountPlaybackPermission };
}
