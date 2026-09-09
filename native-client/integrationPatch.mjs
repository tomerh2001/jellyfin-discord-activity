/** Adapt native controls at pinned source anchors; keep their elements and routes. */
export async function patchNativeIntegration(replace) {
    const videoPlayer = 'src/plugins/htmlVideoPlayer/plugin.js';
    await replace(videoPlayer,
        "import Screenfull from 'screenfull';",
        "import Screenfull from 'screenfull';\nimport toast from 'components/toast/toast';\nimport { isVideoFullscreen, toggleVideoFullscreen } from 'discordActivity/videoFullscreen';");
    await replace(videoPlayer,
        '    static onPictureInPictureError(err) {',
        `    isFullscreen() {
        return isVideoFullscreen(this.#mediaElement, Screenfull);
    }

    toggleFullscreen() {
        return toggleVideoFullscreen(this.#mediaElement, Screenfull, toast);
    }

    onNativeFullscreenChange = () => {
        Events.trigger(this, 'fullscreenchange');
    };

    static onPictureInPictureError(err) {`);
    for (const [operation, indent] of [['add', '                '], ['remove', '            ']]) {
        const anchor = `${indent}videoElement.${operation}EventListener('waiting', this.onWaiting);`;
        await replace(videoPlayer, anchor,
            anchor + `\n${indent}for (const event of ['webkitbeginfullscreen', 'webkitendfullscreen', 'webkitpresentationmodechanged']) {
${indent}    videoElement.${operation}EventListener(event, this.onNativeFullscreenChange);
${indent}}`);
    }

    // The Modern toolbar and video OSD share this native MUI control. Group
    // membership belongs to the verified Discord party, not a public group list.
    const syncButton = 'src/apps/modern/components/AppToolbar/SyncPlayButton.tsx';
    for (const statement of [
        "import { QUERY_KEY, useSyncPlayGroups } from 'apps/modern/features/syncPlay/hooks/api/useSyncPlayGroups';\n",
        "import globalize from 'lib/globalize';\n",
        "import { queryClient } from 'utils/query/queryClient';\n",
        "import AppSyncPlayMenu, { ID } from './menus/SyncPlayMenu';\n"
    ]) await replace(syncButton, statement, '');
    await replace(syncButton, "import React, { useCallback, useState } from 'react';", "import React, { useCallback } from 'react';");
    await replace(syncButton,
        `    const { data: groups } = useSyncPlayGroups();
    const isAvailable = Boolean(groups && groups.length > 0);

    const [ syncPlayMenuAnchorEl, setSyncPlayMenuAnchorEl ] = useState<null | HTMLElement>(null);
    const isSyncPlayMenuOpen = Boolean(syncPlayMenuAnchorEl);

    const onSyncPlayButtonClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
        // Refresh SyncPlay groups when opening the menu
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        setSyncPlayMenuAnchorEl(event.currentTarget);
    }, [ setSyncPlayMenuAnchorEl ]);

    const onSyncPlayMenuClose = useCallback(() => {
        setSyncPlayMenuAnchorEl(null);
    }, [ setSyncPlayMenuAnchorEl ]);`,
        `    const onSyncPlayButtonClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
        const anchor = event.currentTarget;
        return import('discordActivity/runtime').then(module => module.openWatchMenu(anchor));
    }, []);`);
    await replace(syncButton, "<Tooltip title={globalize.translate('ButtonSyncPlay')}>", "<Tooltip title='Watch party'>");
    await replace(syncButton, "aria-label={globalize.translate('ButtonSyncPlay')}", "aria-label='Watch party'");
    await replace(syncButton, '                    aria-controls={ID}\n', '');
    await replace(syncButton, 'invisible={!isActive && !isAvailable}', 'invisible={!isActive}');
    await replace(syncButton,
        `
            <AppSyncPlayMenu
                open={isSyncPlayMenuOpen}
                anchorEl={syncPlayMenuAnchorEl}
                onMenuClose={onSyncPlayMenuClose}
            />`, '');
    await replace('src/components/toolbar/AppUserMenu.tsx',
        "{globalize.translate('ButtonSignOut')}", 'Jellyfin accounts');
    // This native shortcut authorizes another device; Activity account login
    // already provides broker Quick Connect without a forbidden server probe.
    for (const statement of [
        "import PhonelinkLock from '@mui/icons-material/PhonelinkLock';\n",
        "import { useQuickConnectEnabled } from 'hooks/useQuickConnect';\n",
        '    const { data: isQuickConnectEnabled } = useQuickConnectEnabled();\n'
    ]) await replace('src/components/toolbar/AppUserMenu.tsx', statement, '');
    await replace('src/components/toolbar/AppUserMenu.tsx',
        `            {isQuickConnectEnabled && (
                <MenuItem
                    component={Link}
                    to='/quickconnect'
                    onClick={onMenuClose}
                >
                    <ListItemIcon>
                        <PhonelinkLock />
                    </ListItemIcon>
                    <ListItemText>
                        {globalize.translate('QuickConnect')}
                    </ListItemText>
                </MenuItem>
            )}

`, '');

    // Unsupported remote playback must not bypass the Activity's local player.
    for (const [path, statement, indent] of [
        ['src/apps/modern/components/AppToolbar/index.tsx', "import RemotePlayButton from './RemotePlayButton';\n", '                    '],
        ['src/apps/modern/routes/video/index.tsx', "import RemotePlayButton from 'apps/modern/components/AppToolbar/RemotePlayButton';\n", '                                ']
    ]) {
        await replace(path, statement, '');
        await replace(path, `${indent}<RemotePlayButton />\n`, '');
    }

    await replace('src/components/router/appRouter.js',
        `    showLocalLogin(serverId) {
        return this.show('login?serverid=' + serverId);
    }`,
        `    showLocalLogin() {
        return import('discordActivity/runtime').then(module => module.openAccounts());
    }`);
    await replace('src/components/router/appRouter.js',
        `    showSelectServer() {
        return this.show('selectserver');
    }`,
        `    showSelectServer() {
        return import('discordActivity/runtime').then(module => module.openAccounts());
    }`);

    await replace('src/utils/dashboard.js',
        `export function logout() {
    ServerConnections.logout().then(function () {
        // Clear the query cache
        queryClient.clear();
        // Reset cached views
        viewContainer.reset();

        if (appHost.supports(AppFeature.MultiServer)) {
            selectServer();
        } else {
            navigate('login');
        }
    });
}`,
        `export function logout() {
    // Account selection stays in this document; explicit broker actions own
    // saved-account disconnection and leaving the Discord Activity.
    return import('discordActivity/runtime').then(module => module.openAccounts());
}`);
    await replace('src/utils/dashboard.js',
        `export function selectServer() {
    if (window.NativeShell && typeof window.NativeShell.selectServer === 'function') {
        window.NativeShell.selectServer();
    } else {
        navigate('selectserver');
    }
}`,
        `export function selectServer() {
    return import('discordActivity/runtime').then(module => module.openAccounts());
}`);
    for (const statement of [
        "import { appHost } from 'components/apphost';\n",
        "import viewContainer from 'components/viewContainer';\n",
        "import { AppFeature } from 'constants/appFeature';\n",
        "import { queryClient } from './query/queryClient';\n"
    ]) await replace('src/utils/dashboard.js', statement, '');

    // Direct native links must use the broker too; helper-method interception
    // alone does not cover HashRouter navigation to login or server selection.
    await replace('src/RootAppRouter.tsx',
        "import { APP_ROUTES as LEGACY_APP_ROUTES } from 'apps/legacy/routes/routes';\n", '');
    await replace('src/RootAppRouter.tsx',
        '            ...(layoutManager.modern ? MODERN_APP_ROUTES : LEGACY_APP_ROUTES),',
        '            ...MODERN_APP_ROUTES,');
    await replace('src/apps/modern/routes/routes.tsx',
        "import VideoPage from './video';",
        "import VideoPage from './video';\nimport NativeAccountsRoute, { ACCOUNT_ROUTE_PATHS } from 'discordActivity/accountsRoute';");
    await replace('src/apps/modern/routes/routes.tsx',
        "            { index: true, element: <Navigate replace to='/home' /> },",
        "            { index: true, element: <Navigate replace to='/home' /> },\n            ...ACCOUNT_ROUTE_PATHS.map(path => ({ path, Component: NativeAccountsRoute })),");
    for (const [collection, mapper] of [['ASYNC_PUBLIC_ROUTES', 'toAsyncPageRoute'], ['LEGACY_PUBLIC_ROUTES', 'toViewManagerPageRoute']]) {
        await replace('src/apps/modern/routes/routes.tsx',
            `...${collection}.map(${mapper})`,
            `...${collection}.filter(route => !ACCOUNT_ROUTE_PATHS.includes(route.path)).map(${mapper})`);
    }

    // Resetting the native view cache while already on Home leaves an empty
    // page unless its React effect also observes a replacement ApiClient.
    await replace('src/components/viewManager/ViewManagerPage.tsx',
        "import globalize from 'lib/globalize';",
        "import globalize from 'lib/globalize';\nimport { useApi } from 'hooks/useApi';");
    await replace('src/components/viewManager/ViewManagerPage.tsx',
        '    const location = useLocation();',
        '    const location = useLocation();\n    const { __legacyApiClient__: legacyApiClient } = useApi();');
    await replace('src/components/viewManager/ViewManagerPage.tsx',
        '        location.pathname,\n        location.search',
        '        location.pathname,\n        location.search,\n        legacyApiClient');

    await replace('src/lib/jellyfin-apiclient/ServerConnections.js',
        "import { createApiClient } from 'utils/jellyfin-apiclient/createApiClient';",
        "import { createApiClient } from 'utils/jellyfin-apiclient/createApiClient';\nimport { installNativeSocket } from 'discordActivity/nativeSocket';");
    await replace('src/lib/jellyfin-apiclient/ServerConnections.js',
        '            apiClient.subscribe = apiClient._sdk.subscribe.bind(apiClient._sdk);',
        '            installNativeSocket(apiClient, Events, () => this.currentApiClient() === apiClient);');
    await replace('src/scripts/serverNotifications.js',
        '    return () => subscriptions.get(apiClient.serverId()).forEach((unsub) => {',
        '    return () => subscriptions.forEach((unsub) => {');
}
