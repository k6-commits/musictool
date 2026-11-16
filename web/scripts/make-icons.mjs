// Draws the app icons (assets/*.png, listed in scripts/icons.mjs) from the logo in src/body.html: its first <svg>,
// a tile (the first <rect>) with the marks on it. The marks are measured in the browser and centred on a tile of
// the same colour. Run after changing the logo: `node scripts/make-icons.mjs` (needs Playwright with Chromium).
// The PNGs are committed, so the build does not need a browser.
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS } from './icons.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const body = await readFile(join(root, 'src/body.html'), 'utf8');
const logo = body.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1];
const tile = logo?.match(/^\s*<rect[^>]*\bfill="([^"]+)"[^>]*\/>/);
if (!logo || !tile) throw new Error('src/body.html: the first <svg> should start with its tile, a <rect fill="...">');
const marks = logo.slice(tile[0].length);

await mkdir(join(root, 'assets'), { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  // The marks' extent in the logo's units, including half of any stroke (round caps reach that far).
  await page.setContent(`<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280" viewBox="0 0 28 28"><g id="m">${marks}</g></svg>`);
  const box = await page.evaluate(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of document.querySelectorAll('#m > *')) {
      const b = el.getBBox();
      const pad = el.getAttribute('stroke') ? Number(el.getAttribute('stroke-width') ?? 1) / 2 : 0;
      x0 = Math.min(x0, b.x - pad);
      y0 = Math.min(y0, b.y - pad);
      x1 = Math.max(x1, b.x + b.width + pad);
      y1 = Math.max(y1, b.y + b.height + pad);
    }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: x1 - x0 };
  });
  for (const icon of ICONS) {
    const scale = icon.width / box.width;
    const back = icon.radius ? `<rect x="2" y="2" width="96" height="96" rx="${icon.radius}" fill="${tile[1]}"/>` : `<rect width="100" height="100" fill="${tile[1]}"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${icon.size}" height="${icon.size}" viewBox="0 0 100 100">${back}<g transform="translate(50 50) scale(${scale.toFixed(4)}) translate(${(-box.x).toFixed(3)} ${(-box.y).toFixed(3)})">${marks}</g></svg>`;
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
    await page.screenshot({ path: join(root, 'assets', icon.file), omitBackground: true, clip: { x: 0, y: 0, width: icon.size, height: icon.size } });
    console.log(`assets/${icon.file}`);
  }
} finally {
  await browser.close();
}
