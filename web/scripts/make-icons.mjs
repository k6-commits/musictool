// Draws the app icons (assets/*.png) from the logo in src/body.html: the voice curve and the note on a dark tile.
// Run once after changing the logo: `node scripts/make-icons.mjs` (needs Playwright with Chromium). The PNGs are
// committed, so the build does not need a browser.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'assets');

const TILE = '#15181E';
// The logo's marks in its 28-unit box, centered on (13.65, 14): what they cover with the stroke's round caps.
const MARK = `<path d="M5 17 C 8 17, 9 11, 12 11 S 14 15, 16 15" fill="none" stroke="#FF6B4A" stroke-width="2.4" stroke-linecap="round"/><rect x="17" y="12.5" width="6.5" height="5" rx="1.5" fill="#56C2FF"/>`;
const MARK_WIDTH = 19.7;

/** An icon: the tile (rounded with `radius`, or full bleed) and the marks `width` % of the icon wide. */
function svg(size, { width, radius }) {
  const scale = (width / 100) * (100 / MARK_WIDTH);
  const tile = radius ? `<rect x="2" y="2" width="96" height="96" rx="${radius}" fill="${TILE}"/>` : `<rect width="100" height="100" fill="${TILE}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${tile}<g transform="translate(50 50) scale(${scale.toFixed(4)}) translate(-13.65 -14)">${MARK}</g></svg>`;
}

const ICONS = [
  // Shown as it is (browser tabs, install dialogs): a rounded tile on transparent corners.
  { file: 'icon-192.png', size: 192, width: 62, radius: 22 },
  { file: 'icon-512.png', size: 512, width: 62, radius: 22 },
  // Android cuts its own shape out of a maskable icon: full bleed, marks inside the central safe circle.
  { file: 'icon-maskable-512.png', size: 512, width: 52 },
  // iOS rounds the corners itself.
  { file: 'apple-touch-icon.png', size: 180, width: 58 },
];

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const icon of ICONS) {
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg(icon.size, icon)}</body></html>`);
    await page.screenshot({ path: join(out, icon.file), omitBackground: true, clip: { x: 0, y: 0, width: icon.size, height: icon.size } });
    console.log(`assets/${icon.file}`);
  }
} finally {
  await browser.close();
}
