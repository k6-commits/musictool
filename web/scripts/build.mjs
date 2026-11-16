// Bundles the app into one self-contained HTML file (dist/index.html) and an
// artifact fragment for claude.ai (dist/artifact.html: no html/head/body wrapper).
// With `pwa` (the default) the page can also be installed as an app: dist/ gets a web app manifest, a service
// worker for offline use (src/pwa/sw.js, versioned by the content) and the icons from assets/ (scripts/make-icons.mjs).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TITLE = 'musictool 試作';
/** The page background (--bg in styles.css): the status bar and the splash screen of the installed app. */
const THEME = '#08090c';
const ICONS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
const MANIFEST = {
  name: TITLE,
  short_name: 'musictool',
  description: '歌・ハミング・口笛をノートにして、MIDI に書き出す',
  lang: 'ja',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: THEME,
  theme_color: THEME,
  categories: ['music'],
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
const FONTS =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap';

export async function buildPages({ minify = true, pwa = true } = {}) {
  const result = await build({
    entryPoints: [join(root, 'src/main.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify,
    write: false,
    // Keep /*! */ notices (the SwiftF0 weights' MIT license) at the end of the script.
    legalComments: 'eof',
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const css = (await readFile(join(root, 'src/styles.css'), 'utf8')).replace(/<\/style/gi, '<\\/style');
  const body = await readFile(join(root, 'src/body.html'), 'utf8');

  // The installed app's files sit next to the page (relative URLs, so it works under any path, as GitHub Pages').
  const pwaHead = pwa
    ? `
<meta name="theme-color" content="${THEME}">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="apple-touch-icon.png">`
    : '';
  const standalone = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${TITLE}</title>${pwaHead}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS}" rel="stylesheet" crossorigin>
<style>${css}</style>
</head>
<body>
${body}
<script>${js}</script>
</body>
</html>
`;

  const fragment = `<title>${TITLE}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link href="${FONTS}" rel="stylesheet">
<style>${css}</style>
${body}
<script>${js}</script>
`;

  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist/index.html'), standalone);
  await writeFile(join(root, 'dist/artifact.html'), fragment);
  if (pwa) {
    const manifest = `${JSON.stringify(MANIFEST, null, 2)}\n`;
    await writeFile(join(root, 'dist/manifest.webmanifest'), manifest);
    const version = createHash('sha256').update(standalone).update(manifest);
    for (const icon of ICONS) {
      const data = await readFile(join(root, 'assets', icon));
      version.update(data);
      await writeFile(join(root, 'dist', icon), data);
    }
    const sw = (await readFile(join(root, 'src/pwa/sw.js'), 'utf8')).replace('__VERSION__', version.digest('hex').slice(0, 12));
    await writeFile(join(root, 'dist/sw.js'), sw);
  }
  return { bytes: standalone.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { bytes } = await buildPages({ minify: !process.argv.includes('--dev') });
  console.log(`dist/index.html  ${(bytes / 1024).toFixed(1)} KiB`);
  console.log('dist/artifact.html');
}
