/** Keep Back within the Activity and let it cancel unfinished page loads. */
export async function patchBackNavigation(replace) {
    const router = 'src/components/router/appRouter.js';
    await replace(router, "import { history } from 'RootAppRouter';", "import { history } from 'RootAppRouter';\nimport { playbackManager } from 'components/playback/playbackmanager';");
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
        // Coalesce duplicate clicks and video-stop callbacks until one route commits.
        if (this.cancelBack) return this.promiseShow;
        // Back also cancels a page that is still loading. Waiting for its
        // viewshow first can leave the visible control unresponsive forever.
        this.cancelPendingNavigation();
        if (START_PAGE_PATHS.includes(history.location.pathname) && !document.querySelector('.dialogContainer')) return;
        if (!history.location.state?.dialogs?.length) playbackManager.activityPlayback?.cancelPendingPreparation();

        // The browser's joint history includes Discord's own route changes.
        // Use only committed entries recorded inside this Activity.
        const index = history.activityIndex;
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
        try {
            const navigation = history.back();
            if (navigation?.then) { await navigation; complete(); }
        } catch (error) { complete(); throw error; }
        return pending;
    }`);
    await replace(router, '        return window.history.length > 1;', `        // A restored non-root page can always return to Home.
        return true;`);
    await replace(router, '        this.navigationGeneration++;', '        this.navigationGeneration++;\n        this.cancelBack?.();');
    await replace(router,
        '    async show(path, options) {\n        const generation = this.navigationGeneration;',
        '    async show(path, options) {\n        if (this.cancelBack) this.cancelPendingNavigation();\n        const generation = this.navigationGeneration;');
    await patchActivityHistory(replace);
    await replace('src/apps/modern/components/AppToolbar/index.tsx',
        `    // Only show the back button in apps when appropriate
    const isBackButtonAvailable = window.NativeShell && appRouter.canGoBack(location.pathname);`,
        `    // Discord supplies no browser toolbar inside the Activity.
    const isBackButtonAvailable = appRouter.canGoBack(location.pathname);`);
}

async function patchActivityHistory(replace) {
    const file = 'src/components/router/routerHistory.ts';
    await replace(file, '    _router: Router;', `    _router: Router;
    private activityEntries: RouterState['location'][] = [];
    private activityPosition = 0;
    private activityAction?: RouterState['historyAction'];
    private activityTraversal?: { index: number; location: RouterState['location'] };
    private activityPending?: Promise<void>;

    get activityIndex() { return this.activityPosition; }`);
    await replace(file, '        this._router.subscribe(state => {', `        const capture = (location: RouterState['location']) => ({ ...location, state: structuredClone(location.state) });
        const samePath = (a: RouterState['location'], b: RouterState['location']) => a.pathname === b.pathname && a.search === b.search && a.hash === b.hash;
        let lastLocation = this._router.state.location;
        this.activityEntries = [capture(lastLocation)];
        this._router.subscribe(state => {
            const location = state.location;
            if (state.navigation.state !== 'idle' || (location.key === lastLocation.key && samePath(location, lastLocation))) return;
            lastLocation = location;
            const traversal = this.activityTraversal;
            if (traversal && state.historyAction === 'REPLACE' && samePath(location, traversal.location)) {
                this.activityPosition = traversal.index;
                this.activityEntries[this.activityPosition] = capture(location);
                this.activityTraversal = undefined;
                state = { ...state, historyAction: 'POP' as RouterState['historyAction'] };
            } else if (state.historyAction === 'PUSH') {
                this.activityEntries.splice(this.activityPosition + 1);
                this.activityEntries.push(capture(location));
                this.activityPosition++;
            } else if (state.historyAction === 'REPLACE') {
                this.activityEntries[this.activityPosition] = capture(location);
            } else {
                const index = this.activityEntries.findIndex(entry => entry.key === location.key);
                if (index >= 0) this.activityPosition = index;
                else { this.activityEntries = [capture(location)]; this.activityPosition = 0; }
            }
            // Root pages and account changes are Activity history boundaries.
            if (['/home', '/login', '/selectserver'].includes(location.pathname) && !location.state?.dialogs?.length) {
                this.activityEntries = [capture(location)]; this.activityPosition = 0;
            }
            this.activityAction = state.historyAction;`);
    await replace(file, '        return this._router.state.historyAction;', '        return this.activityAction ?? this._router.state.historyAction;');
    await replace('src/components/viewManager/ViewManagerPage.tsx',
        "import { useLocation, useNavigationType } from 'react-router-dom';",
        "import { useLocation } from 'react-router-dom';\nimport { history } from 'RootAppRouter';");
    await replace('src/components/viewManager/ViewManagerPage.tsx',
        '    const navigationType = useNavigationType();', '    const navigationType = history.action;');
    await replace(file, `    back() {
        void this._router.navigate(-1);
    }`, `    back() {
        if (this.activityPending) return this.activityPending;
        if (this.activityPosition <= 0) return Promise.resolve();
        const index = this.activityPosition - 1;
        const location = this.activityEntries[index];
        const traversal = { index, location };
        this.activityTraversal = traversal;
        let operation;
        try {
            operation = this._router.navigate({ pathname: location.pathname, search: location.search, hash: location.hash },
                { state: structuredClone(location.state), replace: true });
        } catch (error) { this.activityTraversal = undefined; throw error; }
        const pending = Promise.resolve(operation).finally(() => {
            if (this.activityTraversal === traversal) this.activityTraversal = undefined;
            if (this.activityPending === pending) this.activityPending = undefined;
        });
        this.activityPending = pending;
        return pending;
    }`);
    for (const signature of ['    push(to: To, state?: any) {', '    replace(to: To, state?: any): void {']) {
        await replace(file, signature, signature + '\n        this.activityTraversal = undefined;');
    }
}
