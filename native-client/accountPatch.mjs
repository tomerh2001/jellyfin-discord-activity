export async function patchAccountView(replace) {
    await replace('src/RootApp.tsx',
        "import RootAppRouter from 'RootAppRouter';",
        "import RootAppRouter from 'RootAppRouter';\nimport AccountView from 'discordActivity/AccountView';\nimport AppHeader from 'components/AppHeader';");
    await replace('src/RootApp.tsx', '        <ApiProvider>', '        <AppHeader isHidden />\n        <AccountView><ApiProvider>');
    await replace('src/RootApp.tsx', '        </ApiProvider>', '        </ApiProvider></AccountView>');
    // Legacy shared controllers initialize their hidden header once and retain
    // its DOM. Keep it outside account-owned providers so Home tabs keep working.
    await replace('src/RootAppRouter.tsx', "import AppHeader from 'components/AppHeader';\n", '');
    await replace('src/RootAppRouter.tsx', "import layoutManager from 'components/layoutManager';\n", '');
    await replace('src/RootAppRouter.tsx', '    Outlet,\n    useLocation', '    Outlet');
    await replace('src/RootAppRouter.tsx', 'DASHBOARD_APP_PATHS, DASHBOARD_APP_ROUTES', 'DASHBOARD_APP_ROUTES');
    await replace('src/RootAppRouter.tsx', `    const location = useLocation();
    const isNewLayoutPath = Object.values(DASHBOARD_APP_PATHS)
        .some(path => location.pathname.startsWith(\`/\${path}\`));

`, '');
    await replace('src/RootAppRouter.tsx', '            <AppHeader isHidden={layoutManager.modern || isNewLayoutPath} />\n', '');
    // The Modern Home page shares asynchronously loaded native controllers.
    // A removed account subtree must not create one after its import finishes.
    await replace('src/apps/modern/routes/home.tsx',
        "        return import(/* webpackChunkName: \"[request]\" */ `../../../apps/legacy/controllers/${depends}`).then(({ default: ControllerFactory }) => {",
        "        const page = element.current;\n        return import(/* webpackChunkName: \"[request]\" */ `../../../apps/legacy/controllers/${depends}`).then(({ default: ControllerFactory }) => {\n            if (!page?.isConnected || element.current !== page) return undefined;");
    await replace('src/apps/modern/routes/home.tsx',
        '        getTabController(index).then((controller) => {',
        '        getTabController(index).then((controller) => {\n            if (!controller || !element.current?.isConnected) return;');
    for (const action of ['add', 'remove']) {
        await replace('src/apps/modern/routes/home.tsx',
            `(documentRef.current.querySelector('.skinHeader') as HTMLDivElement).classList.${action}('noHomeButtonHeader');`,
            `(documentRef.current.querySelector('.skinHeader') as HTMLDivElement | null)?.classList.${action}('noHomeButtonHeader');`);
    }
}
