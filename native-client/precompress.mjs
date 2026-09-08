import { readdir, readFile, writeFile } from 'node:fs/promises';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Build-only compression; no runtime CPU cost or change to asset contents. */
export async function precompress(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { await precompress(file); continue; }
        if (!entry.isFile() || !/\.(?:html|js|mjs|css|json|svg|wasm)$/i.test(entry.name)) continue;
        const contents = await readFile(file);
        if (contents.length < 1024) continue;
        const [br, gzipFile] = await Promise.all([
            brotli(contents, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
            gz(contents, { level: 6 })
        ]);
        if (br.length < contents.length) await writeFile(`${file}.br`, br);
        if (gzipFile.length < contents.length) await writeFile(`${file}.gz`, gzipFile);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    for (const directory of process.argv.slice(2)) await precompress(path.resolve(directory));
}
