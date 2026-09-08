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
}
