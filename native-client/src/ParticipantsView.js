// A native Jellyfin/MUI roster. Discord names describe Activity presence, not
// Jellyfin credentials or whether someone has started the same media stream.
export function createParticipantsView(React, mui) {
    const { createElement: h } = React;
    const { Alert, Avatar, Box, CircularProgress, List, ListItem, ListItemAvatar, ListItemText, Typography } = mui;
    return function ParticipantsView({ snapshot }) {
        const { participants = [], loading = false, error } = snapshot || {};
        return h(Box, null,
            h(Typography, { variant: 'body2', color: 'text.secondary', sx: { mb: 1 } }, 'People in this Activity'),
            error ? h(Alert, { severity: 'warning', sx: { mb: 1 } }, error) : null,
            loading && !participants.length ? h(Box, { role: 'status', sx: { display: 'flex', alignItems: 'center', gap: 1.5, py: 2 } },
                h(CircularProgress, { size: 20, 'aria-hidden': true }), 'Loading participants…') : null,
            h(List, { 'aria-label': 'Activity participants', 'aria-busy': loading, disablePadding: true },
                ...participants.map(person => h(ListItem, { key: person.id, disableGutters: true },
                    h(ListItemAvatar, null, h(Avatar, { src: person.avatarUrl, alt: '', imgProps: { referrerPolicy: 'no-referrer' } },
                        Array.from(person.displayName || '?')[0]?.toLocaleUpperCase())),
                    h(ListItemText, { primary: person.displayName, secondary: person.isSelf ? 'You' : undefined,
                        primaryTypographyProps: { sx: { overflowWrap: 'anywhere' } } })))),
            !loading && !error && !participants.length ? h(Typography, { color: 'text.secondary', sx: { py: 2 } }, 'No one is in this Activity.') : null
        );
    };
}
