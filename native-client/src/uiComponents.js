import { createParticipantsView } from './ParticipantsView.js';

// Components are rendered in Jellyfin's own theme. Dependencies are supplied by
// ui.js so the roster and dialog lifecycle also run in isolated tests.
export function createModernComponents(React, mui) {
    const { createElement: h, useSyncExternalStore } = React;
    const { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent,
        DialogContentText, DialogTitle, Stack, Typography } = mui;
    const ParticipantsView = createParticipantsView(React, mui);
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

    function PlaybackPermission({ model }) {
        return h(Frame, { model, title: 'Join playback' }, h(Stack, { spacing: 2 },
            text('Your device needs a tap before it can play this video.'),
            // React invokes this callback in the original button click stack.
            // It must call the actual media element's play() before any await.
            action(model.label, model.onActivate, { variant: 'contained', disabled: model.disabled })));
    }

    function DialogView({ model }) {
        switch (model.kind) {
            case 'participants': return h(Frame, { model, title: 'Watch party', actions: action('Close', model.dismiss) },
                h(ParticipantsView, { snapshot: model.participants }));
            case 'playbackPermission': return h(PlaybackPermission, { model });
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
