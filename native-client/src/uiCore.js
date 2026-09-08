// Keep the dialog behavior testable without importing Jellyfin's application
// router. ui.js supplies the real upstream dialog, input and menu components.
export function createNativeUi({ document, dialogHelper, actionSheet, toast,
    setTimeout: schedule = globalThis.setTimeout, clearTimeout: unschedule = globalThis.clearTimeout,
    now = Date.now }) {
    let sequence = 0;

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function button(text, onClick, primary = false) {
        // Static markup lets Jellyfin's customized-built-in polyfill upgrade the
        // button on browsers without native customized-built-in support.
        const holder = document.createElement('div');
        holder.innerHTML = '<button is="emby-button" type="button" class="raised"></button>';
        const node = holder.firstElementChild;
        node.textContent = text;
        if (primary) node.classList.add('button-submit');
        if (onClick) node.addEventListener('click', onClick);
        return node;
    }

    function createDialog(title, canDismiss = () => true) {
        const dlg = dialogHelper.createDialog({ removeOnClose: true, scrollY: false, enableHistory: false });
        dlg.classList.add('formDialog', 'discordNativeDialog', 'dialog-fullscreen-lowres');
        dlg.setAttribute('role', 'dialog');
        dlg.setAttribute('aria-modal', 'true');
        const heading = element('h1', 'formDialogHeaderTitle', title);
        heading.id = `discordNativeDialogTitle${++sequence}`;
        dlg.setAttribute('aria-labelledby', heading.id);
        const header = element('div', 'formDialogHeader');
        header.appendChild(heading);
        const scroller = element('div', 'formDialogContent smoothScrollY');
        const content = element('div', 'dialogContentInner discordNativeDialogContent');
        scroller.appendChild(content);
        dlg.append(header, scroller);
        // Startup has no native page to return to. While a request is pending,
        // Back must not leave an orphaned login or discard a later result.
        dlg.addEventListener('command', event => {
            if (event.detail?.command === 'back' && !canDismiss()) {
                event.preventDefault(); event.stopImmediatePropagation();
            }
        }, true);
        dlg.addEventListener('open', () => {
            const container = dlg.dialogContainer;
            if (!container) return;
            for (const type of ['click', 'contextmenu']) container.addEventListener(type, event => {
                if (event.target === container && !canDismiss()) {
                    event.preventDefault(); event.stopImmediatePropagation();
                }
            }, true);
        });
        return { dlg, content };
    }

    function errorText(cause, fallback = 'Could not connect. Try again.') {
        // API callbacks supply their safe, user-facing errors. Never inject them
        // as markup, or show raw response/request objects.
        return cause instanceof Error && cause.message ? cause.message.slice(0, 500) : fallback;
    }

    function messageNode() {
        const node = element('p', 'fieldDescription');
        node.setAttribute('role', 'alert');
        node.hidden = true;
        return node;
    }

    // onRefresh() -> Connections; onConnect({serverUrl, username, password})
    // and onCommunity() -> Connection; onDelete(id) -> void;
    // onQuickStart(serverUrl) -> {id, code, expiresAt};
    // onQuickPoll(id, signal) -> {status: 'pending'|'connected', connection?}.
    async function chooseAccount(options) {
        const { party, changingServer = false, canCancel = true, signal } = options;
        if (signal?.aborted) return null;
        let data = options.data;
        let selected = null;
        let pending = false;
        let closed = false;
        let quick;
        let pollTimer;
        let pollController;
        const { dlg, content } = createDialog(changingServer ? 'Change the party’s server' : 'Your Jellyfin', () => canCancel && !pending);
        content.appendChild(element('p', '', changingServer
            ? 'Choose another server for everyone. You will confirm before the current watch party ends.'
            : party ? 'Sign in to this party’s Jellyfin server to watch together.'
                : 'Connect your Jellyfin server to watch together.'));
        const notice = element('p', 'fieldDescription', options.notice || '');
        notice.hidden = !options.notice;
        const error = messageNode();
        const status = element('p', 'fieldDescription');
        status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.hidden = true;
        const saved = element('div', 'discordNativeSaved');
        saved.setAttribute('aria-label', 'Saved Jellyfin accounts');
        const form = document.createElement('form');
        // Only fixed labels and element definitions are parsed as HTML.
        form.innerHTML = '<div class="inputContainer"><input is="emby-input" name="serverUrl" type="url" label="Server URL" aria-label="Server URL" autocomplete="url" placeholder="https://jellyfin.example.com" required></div>'
            + '<div class="inputContainer"><input is="emby-input" name="username" type="text" label="Username" aria-label="Username" autocomplete="username" required></div>'
            + '<div class="inputContainer"><input is="emby-input" name="password" type="password" label="Password" aria-label="Password" autocomplete="current-password"></div>';
        const serverUrl = form.elements.namedItem('serverUrl');
        const username = form.elements.namedItem('username');
        const password = form.elements.namedItem('password');
        serverUrl.value = party?.serverUrl || data.defaultServerUrl || '';
        serverUrl.readOnly = Boolean(party);
        const signIn = button('Sign in', undefined, true); signIn.type = 'submit';
        form.appendChild(signIn);
        const quickButton = button('Use Quick Connect', () => {
            // Validate before perform disables the form controls; disabled inputs
            // are intentionally excluded from native constraint validation.
            if (!serverUrl.reportValidity()) return;
            void perform(async () => {
            quick = await options.onQuickStart(serverUrl.value.trim());
            if (closed) return;
            quickCode.textContent = quick.code;
            quickPanel.hidden = false;
            schedulePoll();
            }, 'Starting Quick Connect…');
        });
        const quickPanel = element('div', 'discordNativeQuick'); quickPanel.hidden = true;
        quickPanel.appendChild(element('p', '', 'Enter this code in Jellyfin → Settings → Quick Connect:'));
        const quickCode = element('strong', 'discordNativeQuickCode');
        quickCode.setAttribute('role', 'status'); quickCode.setAttribute('aria-live', 'polite');
        const cancelQuick = button('Cancel Quick Connect', () => { stopQuick(); updateControls(); });
        quickPanel.append(quickCode, cancelQuick);
        const community = button('Use community account', () => { void perform(async () => finish(await options.onCommunity()), 'Connecting community account…'); });
        const communityNote = element('p', 'fieldDescription', 'Use the community’s shared Jellyfin account instead of signing in to your own account.');
        const communityPanel = element('div'); communityPanel.append(community, communityNote);
        const refresh = button('Refresh saved accounts', () => { void perform(async () => {
            data = await options.onRefresh(); renderSaved();
        }, 'Loading your accounts…'); });
        const footer = element('div', 'discordNativeDialogActions');
        footer.appendChild(refresh);
        if (canCancel) footer.appendChild(button('Back to watching', () => dialogHelper.close(dlg)));
        content.append(notice, error, status, saved, form, quickButton, quickPanel, communityPanel, footer);

        function matches(connection) {
            return !party || connection.serverId === party.serverId && connection.serverUrl === party.serverUrl;
        }
        function updateControls() {
            for (const control of dlg.querySelectorAll('button, input')) control.disabled = pending;
            for (const control of form.querySelectorAll('input, button')) control.disabled = pending || Boolean(quick);
            quickButton.disabled = pending || Boolean(quick);
            quickButton.hidden = Boolean(quick) || !options.onQuickStart || !options.onQuickPoll;
            communityPanel.hidden = !data.communityAvailable || !options.onCommunity || Boolean(party && party.serverUrl !== data.defaultServerUrl);
            community.disabled = pending || Boolean(quick);
            refresh.disabled = pending || Boolean(quick);
            for (const row of saved.children) {
                row.querySelector('button').disabled = pending || Boolean(quick) || row.dataset.matches === 'false';
                row.lastElementChild.disabled = pending || Boolean(quick);
            }
            status.hidden = !pending;
            dlg.setAttribute('aria-busy', String(pending));
        }
        function renderSaved() {
            saved.replaceChildren();
            for (const connection of data.connections) {
                const row = element('div', 'discordNativeSavedRow');
                row.dataset.matches = String(matches(connection));
                const select = button('', () => finish(connection));
                select.classList.add('discordNativeAccount');
                select.append(element('strong', '', connection.serverName),
                    element('span', 'fieldDescription', `${connection.jellyfinUsername}${connection.kind === 'community' ? ' · Community account' : ''}`));
                if (!matches(connection)) select.appendChild(element('span', 'fieldDescription', 'Another server — this party is already running'));
                const remove = button('Remove', () => { void perform(async () => {
                    await options.onDelete(connection.id);
                    data = await options.onRefresh(); renderSaved();
                }, 'Removing saved account…'); });
                remove.setAttribute('aria-label', `Remove ${connection.jellyfinUsername} from ${connection.serverName}`);
                row.append(select, remove); saved.appendChild(row);
            }
            updateControls();
        }
        function stopQuick() {
            quick = undefined;
            unschedule(pollTimer); pollTimer = undefined;
            pollController?.abort(); pollController = undefined;
            quickCode.textContent = ''; quickPanel.hidden = true;
        }
        function finish(connection) {
            if (closed) return;
            if (!matches(connection)) {
                error.textContent = 'This account belongs to another Jellyfin server. Sign in to the party’s server.';
                error.hidden = false; return;
            }
            selected = connection;
            dialogHelper.close(dlg);
        }
        async function perform(operation, text) {
            if (pending || closed) return;
            pending = true; error.hidden = true; status.textContent = text;
            updateControls();
            try { await operation(); }
            catch (cause) { if (!closed) { error.textContent = errorText(cause); error.hidden = false; } }
            finally { pending = false; if (!closed) updateControls(); }
        }
        function schedulePoll() {
            if (closed || !quick) return;
            pollTimer = schedule(() => { void poll(); }, 2000);
        }
        async function poll() {
            const current = quick;
            if (closed || !current) return;
            if (!Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= now()) {
                stopQuick(); error.textContent = 'This Quick Connect code expired. Request a new code to try again.'; error.hidden = false; updateControls(); return;
            }
            const controller = new AbortController();
            pollController = controller;
            try {
                const result = await options.onQuickPoll(current.id, controller.signal);
                if (closed || quick !== current || controller.signal.aborted) return;
                if (result.status === 'connected') { stopQuick(); finish(result.connection); updateControls(); }
                else schedulePoll();
            } catch (cause) {
                if (closed || quick !== current || controller.signal.aborted) return;
                stopQuick(); error.textContent = errorText(cause, 'Quick Connect was interrupted. Request a new code to try again.'); error.hidden = false; updateControls();
            } finally { if (pollController === controller) pollController = undefined; }
        }
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (!form.reportValidity()) return;
            void perform(async () => {
                const connection = await options.onConnect({ serverUrl: serverUrl.value.trim(), username: username.value.trim(), password: password.value });
                password.value = '';
                finish(connection);
            }, 'Signing in…');
        });
        renderSaved();
        dlg.addEventListener('closing', () => { closed = true; stopQuick(); password.value = ''; username.value = ''; });
        const abort = () => dialogHelper.close(dlg);
        signal?.addEventListener('abort', abort, { once: true });
        try { await dialogHelper.open(dlg); }
        finally {
            closed = true; stopQuick(); password.value = ''; username.value = '';
            signal?.removeEventListener('abort', abort);
        }
        return signal?.aborted ? null : selected;
    }

    async function confirmServerChange(connection) {
        const { dlg, content } = createDialog('Change server for everyone?');
        content.appendChild(element('p', '', `This ends the current watch party and opens ${connection.serverName}. Everyone will need to reconnect with an account on that server.`));
        let confirmed = false;
        const actions = element('div', 'discordNativeDialogActions');
        actions.append(button('Keep current server', () => dialogHelper.close(dlg)), button('Change server', () => { confirmed = true; dialogHelper.close(dlg); }, true));
        content.appendChild(actions);
        await dialogHelper.open(dlg);
        return confirmed;
    }

    async function showWatchMenu({ anchor, status, onInvite, onAccounts, onChangeServer, onLeave,
        onSyncSettings, onResumePlayback, onHaltPlayback }) {
        const actions = [
            ['invite', 'Invite friends', 'person_add', onInvite],
            ['accounts', 'Jellyfin accounts', 'account_circle', onAccounts],
            ['server', 'Change server', 'dns', onChangeServer],
            ['sync', 'SyncPlay settings', 'settings', onSyncSettings],
            ['resume', 'Resume playback', 'play_arrow', onResumePlayback],
            ['halt', 'Stop playback', 'stop', onHaltPlayback],
            ['leave', 'Leave watch party', 'exit_to_app', onLeave]
        ].filter(([, , , callback]) => callback);
        let id;
        try {
            id = await actionSheet.show({ title: 'Watch party', text: status || undefined, positionTo: anchor,
                resolveOnClick: true, items: actions.map(([value, name, icon]) => ({ id: value, name, icon })) });
        } catch { return; } // Native Back/click-away is cancellation.
        try { await actions.find(([value]) => value === id)?.[3](); }
        catch (cause) { toast({ text: errorText(cause, 'Could not complete that action. Try again.') }); }
    }

    function showLoading(text = 'Connecting to Discord…') {
        const { dlg, content } = createDialog('Jellyfin Watch', () => false);
        dlg.setAttribute('aria-busy', 'true');
        const status = element('p', '', text); status.setAttribute('role', 'status');
        content.appendChild(status);
        void dialogHelper.open(dlg);
        let closed = false;
        return { close() { if (!closed) { closed = true; dialogHelper.close(dlg); } } };
    }

    async function showStartupError({ message, onRetry, onLeave }) {
        let pending = false;
        const { dlg, content } = createDialog('Could not connect', () => false);
        const error = messageNode(); error.hidden = false; error.textContent = message || 'The connection was interrupted. Try again.';
        const retry = button('Try again', () => {
            if (pending) return;
            pending = true; retry.disabled = true; retry.textContent = 'Connecting…'; dlg.setAttribute('aria-busy', 'true');
            Promise.resolve().then(onRetry).then(() => dialogHelper.close(dlg)).catch(cause => { error.textContent = errorText(cause); })
                .finally(() => { pending = false; retry.disabled = false; retry.textContent = 'Try again'; dlg.setAttribute('aria-busy', 'false'); });
        }, true);
        const actions = element('div', 'discordNativeDialogActions');
        if (onRetry) actions.appendChild(retry);
        if (onLeave) actions.appendChild(button('Leave watch party', () => {
            if (pending) return;
            pending = true;
            Promise.resolve().then(onLeave).then(() => dialogHelper.close(dlg)).catch(cause => { error.textContent = errorText(cause); }).finally(() => { pending = false; });
        }));
        content.append(error, actions);
        await dialogHelper.open(dlg);
    }

    async function showClosed({ onClose } = {}) {
        const { dlg, content } = createDialog('You left the watch party', () => Boolean(onClose));
        content.appendChild(element('p', '', 'Open Jellyfin Watch from Discord to join again.'));
        if (onClose) content.appendChild(button('Close Activity', () => {
            Promise.resolve().then(onClose).then(() => dialogHelper.close(dlg)).catch(() => toast({ text: 'You are signed out. Close this Activity in Discord.' }));
        }, true));
        await dialogHelper.open(dlg);
    }

    function mountPlaybackPermission(playButton) {
        const { dlg, content } = createDialog('Join playback', () => false);
        content.appendChild(element('p', '', 'Your device needs a tap before it can play this video.'));
        // Keep the actual caller-owned button and its synchronous media.play()
        // handler. A dialog promise or a replacement click would lose activation.
        content.appendChild(playButton);
        void dialogHelper.open(dlg);
        let closed = false;
        return () => { if (!closed) { closed = true; dialogHelper.close(dlg); } };
    }

    return { chooseAccount, confirmServerChange, showWatchMenu, showLoading, showStartupError, showClosed, mountPlaybackPermission };
}
