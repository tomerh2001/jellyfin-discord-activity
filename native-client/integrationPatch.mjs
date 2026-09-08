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

    await replace('src/scripts/libraryMenu.js',
        "import groupSelectionMenu from '../plugins/syncPlay/ui/groupSelectionMenu';\n", '');
    await replace('src/scripts/libraryMenu.js',
        "        headerSyncButton.title = globalize.translate('ButtonSyncPlay');",
        "        headerSyncButton.title = 'Watch party';");
    await replace('src/scripts/libraryMenu.js',
        "${globalize.translate('ButtonSignOut')}", 'Jellyfin accounts');
    await replace('src/scripts/libraryMenu.js',
        `function onSyncButtonClicked() {
    const btn = this;
    groupSelectionMenu.show(btn);
}`,
        `function onSyncButtonClicked() {
    const btn = this;
    return import('discordActivity/runtime').then(module => module.openWatchMenu(btn));
}`);

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
        appHost.supports(AppFeature.MultiServer) ?
            navigate('selectserver') : navigate('login');
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
    await replace('src/apps/stable/routes/routes.tsx',
        "import AppLayout from '../AppLayout';",
        "import AppLayout from '../AppLayout';\nimport NativeAccountsRoute, { ACCOUNT_ROUTE_PATHS } from 'discordActivity/accountsRoute';");
    await replace('src/apps/stable/routes/routes.tsx',
        "            { index: true, element: <Navigate replace to='/home' /> },",
        "            { index: true, element: <Navigate replace to='/home' /> },\n            ...ACCOUNT_ROUTE_PATHS.map(path => ({ path, Component: NativeAccountsRoute })),");
    for (const [collection, mapper] of [['ASYNC_PUBLIC_ROUTES', 'toAsyncPageRoute'], ['LEGACY_PUBLIC_ROUTES', 'toViewManagerPageRoute']]) {
        await replace('src/apps/stable/routes/routes.tsx',
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

    await replace('src/scripts/serverNotifications.js',
        'function onMessageReceived(e, msg) {\n    const apiClient = this;',
        `function onMessageReceived(e, msg) {
    // A replaced same-server client may have a final queued WebSocket message.
    // Only the current object can affect this account's native player and UI.
    if (this !== ServerConnections.currentApiClient()) return;
    const apiClient = this;`);
}
