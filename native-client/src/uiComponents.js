// Components are rendered in Jellyfin's own theme. Dependencies are supplied by
// ui.js so the account and cancellation logic can also run in isolated tests.
export function createModernComponents(React, mui) {
    const { createElement: h, useLayoutEffect, useRef, useSyncExternalStore } = React;
    const { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent,
        DialogContentText, DialogTitle, Divider, Icon, List, ListItem, ListItemButton,
        ListItemIcon, ListItemText, Menu, MenuItem, Stack, TextField, Typography } = mui;
    const text = value => h(DialogContentText, { sx: { overflowWrap: 'anywhere' } }, value);
    const action = (label, onClick, props = {}) => h(Button, { onClick, ...props }, label);

    function Frame({ model, title, children, actions, ...props }) {
        const titleId = `discord-modern-title-${model.id}`;
        return h(Dialog, {
            open: true, fullWidth: true, maxWidth: 'sm', onClose: model.dismiss,
            transitionDuration: 0,
            'aria-labelledby': title ? titleId : undefined,
            'aria-label': title ? undefined : model.text,
            'aria-busy': model.kind === 'loading' || Boolean(model.pending),
            className: `discordModernDialog${model.kind === 'loading' ? ' discordNativeLoading' : ''}`,
            PaperProps: { 'aria-busy': model.kind === 'loading' || Boolean(model.pending), 'aria-label': title ? undefined : model.text, sx: { m: { xs: 1, sm: 4 }, width: { xs: 'calc(100% - 16px)', sm: '100%' }, maxHeight: 'calc(100dvh - 16px)' } },
            ...props
        }, title && h(DialogTitle, { id: titleId }, title),
        h(DialogContent, null, children),
        actions && h(DialogActions, { sx: { flexWrap: 'wrap', gap: 1, p: 2 } }, actions));
    }

    function Accounts({ model }) {
        const { data, party, canCancel, pending, quick, actions } = model;
        const formRef = useRef(null);
        const urlRef = useRef(null);
        const disabled = pending || Boolean(quick);
        useLayoutEffect(() => {
            const clear = () => {
                const form = formRef.current;
                for (const name of ['password', 'username']) if (form?.elements.namedItem(name)) form.elements.namedItem(name).value = '';
            };
            actions.bindCredentials(clear);
            return clear;
        }, [actions]);
        const submit = event => {
            event.preventDefault();
            const form = formRef.current;
            // Validate before pending state disables the controls.
            if (disabled || !form.reportValidity()) return;
            void actions.signIn({ serverUrl: form.elements.namedItem('serverUrl').value,
                username: form.elements.namedItem('username').value,
                password: form.elements.namedItem('password').value });
        };
        const saved = data.connections.length ? h(List, { 'aria-label': 'Saved Jellyfin accounts', disablePadding: true },
            data.connections.map(connection => h(ListItem, { key: connection.id, disablePadding: true,
                secondaryAction: actions.remove && action('Remove', () => { void actions.remove(connection.id); }, {
                    disabled, 'aria-label': `Remove ${connection.jellyfinUsername} from ${connection.serverName}` }) },
            h(ListItemButton, { className: 'discordModernAccount', disabled: disabled || !actions.matches(connection),
                onClick: () => actions.select(connection), sx: { pr: actions.remove ? 12 : 2, borderRadius: 1 } },
            h(ListItemText, { primary: connection.serverName,
                secondary: `${connection.jellyfinUsername}${connection.kind === 'community' ? ' · Community account' : ''}${!actions.matches(connection) ? ' · Another server — this party is already running' : ''}`,
                sx: { overflowWrap: 'anywhere' } }))))) : null;
        const community = data.communityAvailable && actions.community && (!party || party.serverUrl === data.defaultServerUrl);
        return h(Frame, { model, title: model.changingServer ? 'Change the party’s server' : 'Your Jellyfin',
            actions: [actions.refresh && action('Refresh saved accounts', () => { void actions.refresh(); }, { key: 'refresh', disabled }),
                canCancel && action('Back to watching', model.dismiss, { key: 'cancel', disabled: pending })] },
        h(Stack, { spacing: 2 },
            text(model.changingServer ? 'Choose another server for everyone. You will confirm before the current watch party ends.'
                : party ? 'Sign in to this party’s Jellyfin server to watch together.' : 'Connect your Jellyfin server to watch together.'),
            model.notice && h(Alert, { severity: 'info' }, model.notice),
            model.error && h(Alert, { severity: 'error', role: 'alert' }, model.error),
            pending && h(Stack, { direction: 'row', spacing: 1, alignItems: 'center', role: 'status', 'aria-live': 'polite' },
                h(CircularProgress, { size: 20, 'aria-hidden': true }), h(Typography, null, model.status)),
            saved,
            h(Box, { component: 'form', ref: formRef, onSubmit: submit }, h(Stack, { spacing: 2 },
                h(TextField, { name: 'serverUrl', label: 'Server URL', type: 'url', required: true, fullWidth: true,
                    autoComplete: 'url', placeholder: 'https://jellyfin.example.com', inputRef: urlRef,
                    defaultValue: party?.serverUrl || data.defaultServerUrl || '', disabled,
                    slotProps: { htmlInput: { readOnly: Boolean(party) } } }),
                h(TextField, { name: 'username', label: 'Username', required: true, fullWidth: true, autoComplete: 'username', disabled }),
                h(TextField, { name: 'password', label: 'Password', type: 'password', fullWidth: true, autoComplete: 'current-password', disabled }),
                action('Sign in', undefined, { type: 'submit', variant: 'contained', disabled }))),
            actions.quickStart && !quick && action('Use Quick Connect', () => {
                if (!disabled && urlRef.current.reportValidity()) void actions.quickStart(urlRef.current.value);
            }, { disabled }),
            quick && h(Stack, { spacing: 1, alignItems: 'flex-start' },
                text('Enter this code in Jellyfin → Settings → Quick Connect:'),
                h(Typography, { component: 'strong', variant: 'h4', className: 'discordModernQuickCode', role: 'status', 'aria-live': 'polite', sx: { letterSpacing: '.12em' } }, quick.code),
                action('Cancel Quick Connect', actions.quickCancel, { disabled: pending })),
            community && h(Stack, { spacing: 1 }, h(Divider),
                action('Use community account', () => { void actions.community(); }, { disabled }),
                h(Typography, { variant: 'body2', color: 'text.secondary' }, 'Use the community’s shared Jellyfin account instead of signing in to your own account.'))));
    }

    function WatchMenu({ model }) {
        const anchor = model.anchor?.isConnected ? model.anchor : undefined;
        return h(Menu, { open: true, anchorEl: anchor, anchorReference: anchor ? 'anchorEl' : 'anchorPosition',
            anchorPosition: anchor ? undefined : { top: 64, left: 16 }, onClose: model.dismiss,
            transitionDuration: 0, MenuListProps: { 'aria-label': 'Watch party' },
            slotProps: { paper: { sx: { maxWidth: 'calc(100vw - 16px)', minWidth: 240 } } } },
        h(Box, { sx: { px: 2, py: 1 } }, h(Typography, { variant: 'subtitle1' }, 'Watch party'),
            model.status && h(Typography, { variant: 'body2', color: 'text.secondary' }, model.status)),
        h(Divider),
        model.actions.map(([id, label, icon]) => h(MenuItem, { key: id, onClick: () => model.select(id), sx: { minHeight: 48, whiteSpace: 'normal' } },
            h(ListItemIcon, null, h(Icon, { fontSize: 'small' }, icon)), h(ListItemText, null, label))));
    }

    function PlaybackPermission({ model }) {
        return h(Frame, { model, title: 'Join playback' }, h(Stack, { spacing: 2 },
            text('Your device needs a tap before it can play this video.'),
            // React invokes this callback in the original button click stack.
            // It must call the actual media element's play() before any await.
            action(model.label, model.onActivate, { variant: 'contained', disabled: model.disabled })));
    }

    function DialogView({ model }) {
        switch (model.kind) {
            case 'accounts': return h(Accounts, { model });
            case 'menu': return h(WatchMenu, { model });
            case 'playbackPermission': return h(PlaybackPermission, { model });
            case 'confirm': return h(Frame, { model, title: 'Change server for everyone?', actions: [
                action('Keep current server', model.cancel, { key: 'cancel' }),
                action('Change server', model.confirm, { key: 'confirm', variant: 'contained' })]
            }, text(`This ends the current watch party and opens ${model.connection.serverName}. Everyone will need to reconnect with an account on that server.`));
            case 'loading': return h(Frame, { model }, h(Stack, { direction: 'row', spacing: 2, alignItems: 'center', role: 'status', sx: { pt: 2 } },
                h(CircularProgress, { size: 24, 'aria-hidden': true }), h(Typography, null, model.text)));
            case 'startupError': return h(Frame, { model, title: 'Could not connect', actions: [
                model.leave && action('Leave watch party', model.leave, { key: 'leave', disabled: model.pending }),
                model.retry && action(model.pending ? 'Connecting…' : 'Try again', model.retry, { key: 'retry', variant: 'contained', disabled: model.pending })]
            }, h(Alert, { severity: 'error', role: 'alert' }, model.error));
            case 'closed': return h(Frame, { model, title: 'You left the watch party', actions: model.exit &&
                action('Close Activity', model.exit, { variant: 'contained', disabled: model.pending })
            }, text('Open Jellyfin Watch from Discord to join again.'));
            default: return null;
        }
    }

    return function ActivityDialogs({ controller }) {
        const models = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
        return models.map(model => h(DialogView, { key: model.id, model }));
    };
}
