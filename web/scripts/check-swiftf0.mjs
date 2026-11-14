// Runs eval/real/check-swiftf0.ts (bundled with esbuild): the TypeScript SwiftF0 against reference frames.
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'e2e/out/check-swiftf0.mjs');
await mkdir(dirname(outfile), { recursive: true });
await build({ entryPoints: [join(root, 'eval/real/check-swiftf0.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'warning' });
await import(pathToFileURL(outfile).href);
