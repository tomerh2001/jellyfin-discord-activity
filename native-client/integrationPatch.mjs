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

    // Browser orientation methods require their owning Screen receiver.
    const orientation = 'src/components/playback/playbackorientation.js';
    await replace(orientation, "const promise = lockOrientation('landscape');",
        "const promise = lockOrientation.call(lockOrientation === window.screen.orientation?.lock ? window.screen.orientation : window.screen, 'landscape');");
    await replace(orientation, '                unlockOrientation();',
        '                unlockOrientation.call(unlockOrientation === window.screen.orientation?.unlock ? window.screen.orientation : window.screen);');

    // The Modern toolbar and video OSD share this native MUI control. Group
    // membership belongs to the verified Discord party, not a public group list.
    const syncButton = 'src/apps/modern/components/AppToolbar/SyncPlayButton.tsx';
    for (const statement of [
        "import { SyncPlayUserAccessType } from '@jellyfin/sdk/lib/generated-client/models/sync-play-user-access-type';\n",
        "import Badge from '@mui/material/Badge';\n",
        "import { useSyncPlay } from 'apps/modern/features/syncPlay/hooks/useSyncPlay';\n",
        "import { pluginManager } from 'components/pluginManager';\n",
        "import { PluginType } from 'constants/pluginType';\n",
        '    const { isActive } = useSyncPlay();\n',
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
        `    const onSyncPlayButtonClick = useCallback(() => {
        return import('discordActivity/runtime').then(module => module.openWatchMenu());
    }, []);`);
    await replace(syncButton, "<Tooltip title={globalize.translate('ButtonSyncPlay')}>", "<Tooltip title='Watch party'>");
    await replace(syncButton, "aria-label={globalize.translate('ButtonSyncPlay')}", "aria-label='Watch party'");
    await replace(syncButton, '                    aria-controls={ID}\n', '');
    await replace(syncButton,
        `    if (
        // SyncPlay not enabled for user
        (user?.Policy && user.Policy.SyncPlayAccess === SyncPlayUserAccessType.None)
        // SyncPlay plugin is not loaded
        || pluginManager.ofType(PluginType.SyncPlay).length === 0
    ) {`,
        '    if (!user) {');
    await replace(syncButton,
        `                    <Badge
                        color={isActive ? 'primary' : 'success'}
                        badgeContent={1} // Use visibility of badge to indicate status
                        invisible={!isActive && !isAvailable}
                        variant='dot'
                    >
                        <Groups />
                    </Badge>`,
        '                    <Groups />');
    await replace(syncButton,
        `
            <AppSyncPlayMenu
                open={isSyncPlayMenuOpen}
                anchorEl={syncPlayMenuAnchorEl}
                onMenuClose={onSyncPlayMenuClose}
            />`, '');
    // This shortcut authorizes another device rather than signing into this
    // Activity, so omit it from the native account menu.
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
    return import('discordActivity/runtime').then(module => module.logoutJellyfin());
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

    const viewPage = 'src/components/viewManager/ViewManagerPage.tsx';
    await replace(viewPage, '    viewOptions: ViewOptions\n)', '    viewOptions: ViewOptions,\n    isCurrent: () => boolean\n)');
    await replace(viewPage,
        '    const [ controllerFactory, viewHtml ] = await importController(appType, controller, view);',
        '    const [ controllerFactory, viewHtml ] = await importController(appType, controller, view);\n    if (!isCurrent()) return;');
    await replace(viewPage, '    useEffect(() => {\n        const loadPage', '    useEffect(() => {\n        let active = true;\n        const isCurrent = () => active;\n        const loadPage');
    // Both direct loads and cache-restore fallbacks belong to this mounted route.
    await replace(viewPage, '\n                return loadView(appType, controller, view, viewOptions);', '\n                return loadView(appType, controller, view, viewOptions, isCurrent);');
    await replace(viewPage, '                        return loadView(appType, controller, view, viewOptions);', '                        return loadView(appType, controller, view, viewOptions, isCurrent);');
    await replace(viewPage, '                    if (!result?.cancelled) {', '                    if (active && !result?.cancelled) {');
    await replace(viewPage, '        loadPage();\n    },', '        loadPage();\n        return () => { active = false; };\n    },');

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
