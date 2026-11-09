// Bundles the app into one self-contained HTML file (dist/index.html) and an
// artifact fragment for claude.ai (dist/artifact.html: no html/head/body wrapper).
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TITLE = 'musictool 試作';
const FONTS =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap';

export async function buildPages({ minify = true } = {}) {
  const result = await build({
    entryPoints: [join(root, 'src/main.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify,
    write: false,
    legalComments: 'none',
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const css = (await readFile(join(root, 'src/styles.css'), 'utf8')).replace(/<\/style/gi, '<\\/style');
  const body = await readFile(join(root, 'src/body.html'), 'utf8');

  const standalone = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${TITLE}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS}" rel="stylesheet">
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
  return { bytes: standalone.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { bytes } = await buildPages({ minify: !process.argv.includes('--dev') });
  console.log(`dist/index.html  ${(bytes / 1024).toFixed(1)} KiB`);
  console.log('dist/artifact.html');
}
