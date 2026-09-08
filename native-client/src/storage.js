(function installActivityStorage(host) {
    'use strict';

    function memoryStorage() {
        const values = new Map();
        const prototype = Object.create(null);
        Object.defineProperties(prototype, {
            length: { get: () => values.size },
            key: { value: index => Array.from(values.keys())[Number(index) >>> 0] ?? null },
            getItem: { value: key => values.get(String(key)) ?? null },
            setItem: { value: (key, value) => { values.set(String(key), String(value)); } },
            removeItem: { value: key => { values.delete(String(key)); } },
            clear: { value: () => values.clear() },
            [Symbol.toStringTag]: { value: 'Storage' }
        });
        return new Proxy(Object.create(prototype), {
            get(target, key) {
                if (typeof key === 'symbol' || key in target) return Reflect.get(target, key);
                return values.get(String(key));
            },
            set(_target, key, value) { values.set(String(key), String(value)); return true; },
            deleteProperty(_target, key) { values.delete(String(key)); return true; },
            has(target, key) { return key in target || values.has(String(key)); },
            ownKeys() { return Array.from(values.keys()); },
            getOwnPropertyDescriptor(_target, key) {
                return values.has(String(key)) ? { configurable: true, enumerable: true, writable: true, value: values.get(String(key)) } : undefined;
            },
            defineProperty(_target, key, descriptor) {
                if (!('value' in descriptor) || descriptor.configurable === false) return false;
                values.set(String(key), String(descriptor.value));
                return true;
            }
        });
    }

    // Never read the browser's storage getters: Discord's third-party frame can
    // deny even reading localStorage/sessionStorage before native modules start.
    // Preferences and gateway metadata belong only to this Activity document.
    for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(host, name, { configurable: true, enumerable: true, value: memoryStorage() });
    }
    // jellyfin-apiclient opens its optional persistent response cache at import
    // time and does not catch an asynchronous policy rejection. Disable caching
    // rather than persist authenticated Jellyfin responses outside this session.
    Object.defineProperty(host, 'caches', { configurable: true, enumerable: true, value: undefined });
})(window);
