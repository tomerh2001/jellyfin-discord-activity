/** Keep Back within the Activity and let it cancel unfinished page loads. */
export async function patchBackNavigation(replace) {
    const router = 'src/components/router/appRouter.js';
    await replace(router, '    navigationGeneration = 0;', '    navigationGeneration = 0;\n    cancelBack;');
    await replace(router, `    async back() {
        if (this.promiseShow) await this.promiseShow;

        this.promiseShow = new Promise((resolve) => {
            const unlisten = history.listen(() => {
                unlisten();
                this.promiseShow = null;
                resolve();
            });
            history.back();
        });

        return this.promiseShow;
    }`, `    async back() {
        // Back also cancels a page that is still loading. Waiting for its
        // viewshow first can leave the visible control unresponsive forever.
        this.cancelPendingNavigation();
        if (START_PAGE_PATHS.includes(history.location.pathname)) return;

        // history.length includes Discord's enclosing browsing context. Only
        // the HashRouter index proves that this Activity has a previous entry.
        const index = window.history.state?.idx;
        if (!Number.isInteger(index) || index <= 0) return this.show('/home');

        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        const unlisten = history.listen(() => complete());
        const complete = () => {
            unlisten();
            if (this.cancelBack === complete) {
                this.cancelBack = undefined;
                this.promiseShow = null;
            }
            finish();
        };
        this.cancelBack = complete;
        this.promiseShow = pending;
        try { history.back(); }
        catch (error) { complete(); throw error; }
        return pending;
    }`);
    await replace(router, '        return window.history.length > 1;', `        // A restored non-root page can always return to Home.
        return true;`);
    await replace(router, '        this.navigationGeneration++;', '        this.navigationGeneration++;\n        this.cancelBack?.();');
    await replace('src/apps/modern/components/AppToolbar/index.tsx',
        `    // Only show the back button in apps when appropriate
    const isBackButtonAvailable = window.NativeShell && appRouter.canGoBack(location.pathname);`,
        `    // Discord supplies no browser toolbar inside the Activity.
    const isBackButtonAvailable = appRouter.canGoBack(location.pathname);`);
}
