// Bundles a TypeScript entry with esbuild and runs it in Node: node scripts/run-ts.mjs <entry.ts> [args...]
// (eval/eval.ts, eval/real.ts, eval/real/check-swiftf0.ts). The entry sees its own arguments in process.argv.slice(2).
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [entry, ...rest] = process.argv.slice(2);
if (!entry) {
  console.error('usage: node scripts/run-ts.mjs <entry.ts> [args...]');
  process.exit(2);
}
const outfile = join(root, 'e2e/out', `${basename(entry, '.ts')}.mjs`);
await mkdir(dirname(outfile), { recursive: true });
await build({ entryPoints: [resolve(root, entry)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'warning' });
process.argv = [process.argv[0], outfile, ...rest];
await import(pathToFileURL(outfile).href);
