import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import test from 'node:test';
import { precompress } from '../precompress.mjs';

test('precompressed build files decode to the original bytes and skip unrelated binaries', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'activity-compression-'));
    const source = Buffer.from('const value = "native client";\n'.repeat(300));
    try {
        await writeFile(path.join(directory, 'client.js'), source);
        await writeFile(path.join(directory, 'icon.png'), source);
        await precompress(directory);
        assert.deepEqual(await readFile(path.join(directory, 'client.js')), source);
        assert.deepEqual(gunzipSync(await readFile(path.join(directory, 'client.js.gz'))), source);
        assert.deepEqual(brotliDecompressSync(await readFile(path.join(directory, 'client.js.br'))), source);
        assert(!(await readdir(directory)).includes('icon.png.br'));
    } finally { await rm(directory, { recursive: true, force: true }); }
});
