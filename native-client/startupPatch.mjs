/** The Activity's native configuration is compiled and served in one release.
 * Resolve its packaged defaults locally instead of fetching that identical
 * config before appHost initialization, plugins and the first native page.
 */
export async function patchNativeStartup(replace) {
    await replace('src/hooks/useWebConfig.tsx',
        "import React, { type FC, type PropsWithChildren, createContext, useContext, useEffect, useState } from 'react';",
        "import React, { type FC, type PropsWithChildren, createContext, useContext } from 'react';");
    await replace('src/hooks/useWebConfig.tsx', "import fetchLocal from '../utils/fetchLocal';\n", '');
    await replace('src/hooks/useWebConfig.tsx',
        `    const [ config, setConfig ] = useState<WebConfig>(defaultConfig);

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const response = await fetchLocal('config.json', { cache: 'no-store' });

                if (!response.ok) {
                    throw new Error('network response was not ok');
                }

                const configData = await response.json();
                setConfig(configData);
            } catch (err) {
                console.warn('[WebConfigProvider] failed to fetch config file', err);
            }
        };

        fetchConfig()
            .catch(() => {
                // This should never happen since fetchConfig catches errors internally
            });
    }, [ setConfig ]);`,
        '    const config = defaultConfig;');
    await replace('src/scripts/settings/webSettings.js',
        "import fetchLocal from '../../utils/fetchLocal.ts';\n", '');
    await replace('src/scripts/settings/webSettings.js',
        `let data;

async function getConfig() {
    if (data) return Promise.resolve(data);
    try {
        const response = await fetchLocal('config.json', {
            cache: 'no-store'
        });

        if (!response.ok) {
            throw new Error('network response was not ok');
        }

        data = await response.json();

        return data;
    } catch (error) {
        console.warn('failed to fetch the web config file:', error);
        data = DefaultConfig;
        return data;
    }
}`,
        `function getConfig() {
    return Promise.resolve(DefaultConfig);
}`);
    // Jellyfin 12 defaults to the modern app; the Activity uses its retained
    // native legacy player and controls on both desktop and mobile.
    await replace('src/components/layoutManager.js',
        "import { LayoutMode, LegacyLayoutModes } from 'constants/layoutMode';",
        "import { LayoutMode } from 'constants/layoutMode';");
    await replace('src/components/layoutManager.js',
        "    setLayout(layout = '', save = true) {",
        `    setLayout(layout = '', save = true) {
        if (layout === LayoutMode.Modern) layout = browser.mobile ? LayoutMode.MobileLegacy : LayoutMode.DesktopLegacy;
        if (layout === LayoutMode.Desktop) layout = LayoutMode.DesktopLegacy;
        if (layout === LayoutMode.Mobile) layout = LayoutMode.MobileLegacy;`);
    await replace('src/components/layoutManager.js',
        '        const isLegacyLayout = LegacyLayoutModes.has(layoutValue);\n', '');
    await replace('src/components/layoutManager.js',
        '        this.modern = !isLegacyLayout;',
        '        this.modern = false; // Activity integration uses upstream 12 legacy controls.');

    // A gateway capability and account-scoped DTO cache must never be restored
    // from IndexedDB into another Discord Activity document or account.
    await replace('src/RootApp.tsx',
        "import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';",
        "import { QueryClientProvider } from '@tanstack/react-query';");
    await replace('src/RootApp.tsx',
        "import { persister, queryClient } from 'utils/query/queryClient';",
        "import { queryClient } from 'utils/query/queryClient';");
    await replace('src/RootApp.tsx',
        `    <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
            buster: __JF_BUILD_VERSION__,
            persister
        }}
    >`,
        '    <QueryClientProvider client={queryClient}>');
    await replace('src/RootApp.tsx', '    </PersistQueryClientProvider>', '    </QueryClientProvider>');
    await replace('src/utils/query/queryClient.ts',
        "import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';\n", '');
    await replace('src/utils/query/queryClient.ts', "import { get, set, del } from 'idb-keyval';\n", '');
    await replace('src/utils/query/queryClient.ts',
        `/** Create an IndexedDB persister for react-query-persist-client. Uses idb-keyval for simplicity. */
const createIDBPersister = (idbValidKey: IDBValidKey = 'query-cache') => ({
    persistClient: async (client: PersistedClient) => {
        await set(idbValidKey, client);
    },
    restoreClient: () => {
        return get<PersistedClient>(idbValidKey);
    },
    removeClient: async () => {
        await del(idbValidKey);
    }
} satisfies Persister);

export const persister = createIDBPersister('jellyfin-query-cache');`,
        '// Activity query data stays in this document and is cleared on account replacement.');

}
