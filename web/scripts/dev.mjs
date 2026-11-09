// Dev server: rebuilds on change and serves dist/ on http://localhost:5173
// (localhost counts as a secure context, so the microphone works).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPages } from './build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 5173);

async function rebuild() {
  try {
    await buildPages({ minify: false });
    console.log(`[${new Date().toLocaleTimeString()}] built`);
  } catch (e) {
    console.error(e.message ?? e);
  }
}

await rebuild();
let timer;
watch(join(root, 'src'), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 80);
});

createServer(async (req, res) => {
  try {
    const html = await readFile(join(root, 'dist/index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch {
    res.writeHead(500);
    res.end('build failed');
  }
}).listen(port, '127.0.0.1', () => console.log(`musictool → http://localhost:${port}`));
