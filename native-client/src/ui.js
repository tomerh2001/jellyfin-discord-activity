import React from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent,
    DialogContentText, DialogTitle, Divider, Icon, List, ListItem, ListItemButton,
    ListItemIcon, ListItemText, Menu, MenuItem, Snackbar, Stack, TextField, Typography } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import appTheme from 'themes';
import { on as onInputCommand } from 'scripts/inputManager';
import { ThemeStorageManager } from 'themes/themeStorageManager';
import { createNativeUi } from './uiCore';
import { createModernComponents } from './uiComponents';
import './ui.css';

const ActivityDialogs = createModernComponents(React, { Alert, Box, Button, CircularProgress,
    Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Divider, Icon,
    List, ListItem, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, TextField, Typography });
let host;
let notice = '';
const noticeListeners = new Set();
const subscribeNotice = listener => { noticeListeners.add(listener); return () => noticeListeners.delete(listener); };
const getNotice = () => notice;
function showNotice(value) { notice = value; for (const listener of noticeListeners) listener(); }

function ModernUiHost() {
    const message = React.useSyncExternalStore(subscribeNotice, getNotice, getNotice);
    return React.createElement(ThemeProvider, { theme: appTheme, defaultMode: 'dark', storageManager: ThemeStorageManager },
        React.createElement(ActivityDialogs, { controller }),
        React.createElement(Snackbar, { open: Boolean(message), message, autoHideDuration: 6000,
            onClose: (_event, reason) => { if (reason !== 'clickaway') showNotice(''); } }));
}
function ensureHost() {
    if (host) return;
    // Bootstrap asks for an account before RootApp exists. This native theme
    // root lives in the same document and survives account subtree remounts.
    const element = document.createElement('div');
    element.id = 'discord-modern-dialogs';
    document.body.appendChild(element);
    // Register with Jellyfin so it emits native Back commands, and contain them
    // before underlying page/player handlers can navigate during a dialog.
    onInputCommand(window, controller.handleCommand);
    window.addEventListener('command', controller.handleCommand, true);
    host = createRoot(element);
    host.render(React.createElement(ModernUiHost));
}
const controller = createNativeUi({ onChange: ensureHost, toast: showNotice });
export const { chooseAccount, confirmServerChange, showWatchMenu, showLoading,
    showStartupError, showClosed, mountPlaybackPermission } = controller;
