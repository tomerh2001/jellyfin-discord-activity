/** Cancel native imperative view work when its route or account is replaced. */
export async function patchNativeViewLifecycle(replace) {
    // Apply after integrationPatch, which supplies this route's isCurrent callback.
    await replace('src/components/viewManager/ViewManagerPage.tsx',
        '            const viewOptions = {\n                url:',
        '            const viewOptions = {\n                get cancel() { return !isCurrent(); },\n                url:');
    // Object spread evaluates getters; preserve route ownership on the actual load.
    await replace('src/components/viewManager/ViewManagerPage.tsx',
        '        ...viewOptions,\n        controllerFactory,',
        '        ...viewOptions,\n        get cancel() { return !isCurrent(); },\n        controllerFactory,');

    const container = 'src/components/viewContainer.js';
    await replace(container,
        'export function loadView(options) {\n    if (!options.cancel) {',
        'export function loadView(options) {\n    if (options.cancel) return Promise.resolve();\n    if (!options.cancel) {\n        const generation = ++viewGeneration;');
    await replace(container,
        "        view.classList.add('mainAnimatedPage');",
        "        view.classList.add('mainAnimatedPage', 'hide');");
    await replace(container,
        "            console.warn('[viewContainer] main animated pages element is not present');\n            return;",
        "            console.warn('[viewContainer] main animated pages element is not present');\n            return Promise.resolve();");
    await replace(container,
        '        allPages[pageIndex] = view;\n\n        return setControllerClass(view, options)',
        `        allPages[pageIndex] = view;
        currentUrls[pageIndex] = undefined;
        const isCurrent = () => generation === viewGeneration && !options.cancel && allPages[pageIndex] === view;
        options.isViewCurrent = isCurrent;
        const discard = () => {
            if (allPages[pageIndex] === view) {
                allPages[pageIndex] = undefined;
                currentUrls[pageIndex] = undefined;
                view.remove();
            }
            if (view.initComplete) triggerDestroy(view);
        };

        return setControllerClass(view, options)`);
    await replace(container,
        `            .then(() => {
                if (onBeforeChange) {
                    onBeforeChange(view, false, options);
                }

                beforeAnimate(allPages, pageIndex, selected);`,
        `            .then(() => {
                if (!isCurrent()) { discard(); return; }
                view.classList.remove('hide');
                if (onBeforeChange) {
                    onBeforeChange(view, false, options);
                }
                if (!isCurrent()) { discard(); return; }
                beforeAnimate(allPages, pageIndex, selected);`);
    await replace(container,
        '                return view;\n            });\n    }\n}\n\nfunction parseHtml',
        '                return view;\n            }).catch(error => {\n                if (!isCurrent()) { discard(); return; }\n                throw error;\n            });\n    }\n}\n\nfunction parseHtml');
    for (const name of ['beforeAnimate', 'afterAnimate']) {
        const next = name === 'beforeAnimate' ? 'function afterAnimate' : 'export function setOnBeforeChange';
        // Each helper may encounter a slot discarded before it became visible.
        await replace(container,
            `            allPages[index].classList.add('hide');\n        }\n    }\n}\n\n${next}`,
            `            allPages[index]?.classList.add('hide');\n        }\n    }\n}\n\n${next}`);
    }
    await replace(container,
        'export function tryRestoreView(options) {',
        'export function tryRestoreView(options) {\n    if (options.cancel) return Promise.reject({ cancelled: true });\n    const generation = ++viewGeneration;');
    await replace(container,
        `            return setControllerClass(view, options).then(() => {
                if (onBeforeChange) {
                    onBeforeChange(view, true, options);
                }

                beforeAnimate(allPages, index, selected);`,
        `            const isCurrent = () => generation === viewGeneration && !options.cancel && allPages[index] === view;
            options.isViewCurrent = isCurrent;
            return setControllerClass(view, options).then(() => {
                if (!isCurrent()) return;
                if (onBeforeChange) {
                    onBeforeChange(view, true, options);
                }
                if (!isCurrent()) return;

                beforeAnimate(allPages, index, selected);`);
    await replace(container, 'export function reset() {', 'export function reset() {\n    viewGeneration++;\n    const previousPages = allPages;');
    await replace(container,
        '    selectedPageIndex = -1;\n}',
        '    selectedPageIndex = -1;\n    previousPages.forEach(view => { if (view?.initComplete) triggerDestroy(view); });\n}');
    await replace(container,
        'function triggerDestroy(view) {',
        'function triggerDestroy(view) {\n    if (view.activityDestroyed) return;\n    view.activityDestroyed = true;');
    await replace(container, 'let onBeforeChange;', 'let viewGeneration = 0;\nlet onBeforeChange;');
    await replace(container,
        'export default {\n    loadView,',
        `export default {
    isCurrentView: (view, options) => Boolean(view && !options.cancel && options.isViewCurrent?.() !== false && allPages[selectedPageIndex] === view && view.isConnected),
    loadView,`);

    const manager = 'src/components/viewManager/viewManager.js';
    await replace(manager,
        'viewContainer.setOnBeforeChange(function (newView, isRestored, options) {\n    const lastView = currentView;\n    if (lastView) {',
        'viewContainer.setOnBeforeChange(function (newView, isRestored, options) {\n    if (options.cancel || options.isViewCurrent?.() === false || !newView.isConnected) return;\n    const lastView = currentView;\n    if (lastView?.isConnected) {');
    await replace(manager,
        '    const eventDetail = getViewEventDetail(newView, options, isRestored);',
        '    if (options.cancel || options.isViewCurrent?.() === false || !newView.isConnected) return;\n    const eventDetail = getViewEventDetail(newView, options, isRestored);');
    await replace(manager,
        '        if (!options.controllerFactory || dispatchPageEvents) {',
        '        if (options.cancel || options.isViewCurrent?.() === false || !newView.isConnected) return;\n        if (!options.controllerFactory || dispatchPageEvents) {');
    await replace(manager,
        "    dispatchViewEvent(newView, eventDetail, 'viewbeforeshow');",
        "    if (options.cancel || options.isViewCurrent?.() === false || !newView.isConnected) return;\n    dispatchViewEvent(newView, eventDetail, 'viewbeforeshow');");
    await replace(manager,
        'function onViewChange(view, options, isRestore) {\n    const lastView = currentView;\n    if (lastView) {',
        'function onViewChange(view, options, isRestore) {\n    if (!viewContainer.isCurrentView(view, options)) return;\n    const lastView = currentView;\n    if (lastView?.isConnected) {');
    await replace(manager, '    currentView = view;', '    if (!viewContainer.isCurrentView(view, options)) return;\n    currentView = view;');
    await replace(manager,
        "    if (dispatchPageEvents) {\n        view.dispatchEvent(new CustomEvent('pageshow', eventDetail));",
        "    if (dispatchPageEvents && viewContainer.isCurrentView(view, options)) {\n        view.dispatchEvent(new CustomEvent('pageshow', eventDetail));");
    await replace(manager,
        '        viewContainer.loadView(options).then(function (view) {\n            onViewChange(view, options);',
        '        return viewContainer.loadView(options).then(function (view) {\n            if (!viewContainer.isCurrentView(view, options)) return;\n            onViewChange(view, options);');
    await replace(manager,
        '        return viewContainer.tryRestoreView(options).then(function (view) {\n            if (onViewChanging) onViewChanging();',
        '        return viewContainer.tryRestoreView(options).then(function (view) {\n            if (!viewContainer.isCurrentView(view, options)) throw { cancelled: true };\n            if (onViewChanging) onViewChanging();');
    await replace(manager,
        '    hideView() {\n        if (currentView) {',
        '    hideView() {\n        if (currentView?.isConnected) {');

    // An account transition cancels viewshow as well as the view itself. Release
    // that navigation wait and invalidate queued calls before replacing views.
    const router = 'src/components/router/appRouter.js';
    await replace(router, '    resolveOnNextShow;', '    resolveOnNextShow;\n    showTimer;\n    navigationGeneration = 0;');
    await replace(router,
        '    async show(path, options) {\n        if (this.promiseShow) await this.promiseShow;',
        '    async show(path, options) {\n        const generation = this.navigationGeneration;\n        if (this.promiseShow) await this.promiseShow;\n        if (generation !== this.navigationGeneration) return;');
    await replace(router,
        '            setTimeout(() => history.push(path, options), 0);',
        `            this.showTimer = setTimeout(() => {
                if (generation !== this.navigationGeneration) return;
                this.showTimer = undefined;
                history.push(path, options);
            }, 0);`);
    await replace(router,
        '    onViewShow() {',
        `    cancelPendingNavigation() {
        this.navigationGeneration++;
        clearTimeout(this.showTimer);
        this.showTimer = undefined;
        this.onViewShow();
    }

    onViewShow() {`);
}
