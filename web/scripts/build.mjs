// Bundles the app into one self-contained HTML file (dist/index.html) and an
// artifact fragment for claude.ai (dist/artifact.html: no html/head/body wrapper).
// With `pwa` (the default) the page can also be installed as an app: dist/ gets a web app manifest, a service
// worker for offline use (src/pwa/sw.js, versioned by the content) and the icons from assets/ (scripts/icons.mjs,
// drawn by scripts/make-icons.mjs). Everything in dist/ except artifact.html is the site GitHub Pages serves.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS } from './icons.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TITLE = 'musictool 試作';
const FONTS =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap';
/** Where the fonts come from: the stylesheet's host and the font files' host. */
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/** The commit the page is built from, shown in the settings ('+' when the working tree has changes). */
function buildId() {
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain') ? '+' : '');
  } catch {
    return 'dev';
  }
}

export async function buildPages({ minify = true, pwa = true } = {}) {
  const result = await build({
    entryPoints: [join(root, 'src/main.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify,
    write: false,
    define: { __BUILD__: JSON.stringify(buildId()) },
    // Keep /*! */ notices (the SwiftF0 weights' MIT license) at the end of the script.
    legalComments: 'eof',
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const css = (await readFile(join(root, 'src/styles.css'), 'utf8')).replace(/<\/style/gi, '<\\/style');
  const body = await readFile(join(root, 'src/body.html'), 'utf8');
  // The page background: also the installed app's status bar and splash screen.
  const theme = css.match(/--bg:\s*([^;]+);/)?.[1].trim() ?? '#000000';
  const icon = (purpose) => ICONS.find((i) => i.purpose === purpose);

  // The installed app's files sit next to the page (relative URLs, so it works under any path, as GitHub Pages').
  const pwaHead = pwa
    ? `
<meta name="theme-color" content="${theme}">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="${icon('any').file}" sizes="${icon('any').size}x${icon('any').size}">
<link rel="apple-touch-icon" href="${icon('apple').file}">`
    : '';
  // The stylesheet is fetched in CORS mode (the service worker can then keep it), so its preconnect is too.
  const standalone = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${TITLE}</title>${pwaHead}
${FONT_HOSTS.map((host) => `<link rel="preconnect" href="https://${host}" crossorigin>`).join('\n')}
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
    const manifest = {
      name: TITLE,
      short_name: 'musictool',
      description: '歌・ハミング・口笛をノートにして、MIDI に書き出す',
      lang: 'ja',
      start_url: './',
      scope: './',
      display: 'standalone',
      background_color: theme,
      theme_color: theme,
      categories: ['music'],
      icons: ICONS.filter((i) => i.purpose !== 'apple').map((i) => ({ src: i.file, sizes: `${i.size}x${i.size}`, type: 'image/png', purpose: i.purpose })),
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(root, 'dist/manifest.webmanifest'), manifestText);
    const version = createHash('sha256').update(standalone).update(manifestText);
    for (const { file } of ICONS) {
      const data = await readFile(join(root, 'assets', file));
      version.update(data);
      await writeFile(join(root, 'dist', file), data);
    }
    // The worker precaches exactly the files written here.
    const assets = ['./', 'manifest.webmanifest', ...ICONS.map((i) => i.file)];
    const sw = (await readFile(join(root, 'src/pwa/sw.js'), 'utf8'))
      .replace('__VERSION__', version.digest('hex').slice(0, 12))
      .replace('__ASSETS__', JSON.stringify(assets))
      .replace('__FONT_HOSTS__', JSON.stringify(FONT_HOSTS));
    await writeFile(join(root, 'dist/sw.js'), sw);
  }
  return { bytes: standalone.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { bytes } = await buildPages({ minify: !process.argv.includes('--dev') });
  console.log(`dist/index.html  ${(bytes / 1024).toFixed(1)} KiB`);
  console.log('dist/artifact.html');
}
