export async function patchAccountView(replace) {
    await replace('src/RootApp.tsx',
        "import RootAppRouter from 'RootAppRouter';",
        "import RootAppRouter from 'RootAppRouter';\nimport AccountView from 'discordActivity/AccountView';");
    await replace('src/RootApp.tsx', '        <ApiProvider>', '        <AccountView><ApiProvider>');
    await replace('src/RootApp.tsx', '        </ApiProvider>', '        </ApiProvider></AccountView>');
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
