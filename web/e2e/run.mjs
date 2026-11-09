// End-to-end check in real Chromium:
//  1. microphone take (Chromium's fake mic plays a synthetic singer) -> notes -> MIDI download
//  2. audio file upload -> tempo guess -> notes
//  3. screenshots (desktop + phone) for a visual check
// Run with `npm run e2e` (builds first).
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { Midi } = require('@tonejs/midi');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e/out');
await mkdir(out, { recursive: true });

// Fixtures (TypeScript) -> a temporary ES module.
const fx = join(out, 'fixtures.mjs');
await build({ entryPoints: [join(root, 'e2e/fixtures.ts')], bundle: true, format: 'esm', platform: 'node', outfile: fx, logLevel: 'warning' });
const { micWav, fileWav, MIC_MELODY, FILE_MELODY, FILE_BPM } = await import(pathToFileURL(fx).href);

const micPath = join(out, 'mic-take.wav');
const filePath = join(out, 'phone-memo.wav');
// Count-in at 100 BPM is 2.4 s; the fake mic starts when the page opens the device.
await writeFile(micPath, micWav(48000, 2.55));
await writeFile(filePath, fileWav(44100));

const html = await readFile(join(root, 'dist/index.html'));
// "/frame" embeds the app in an iframe without microphone permission, like the claude.ai artifact viewer.
// The frame is cross-origin (localhost -> 127.0.0.1), as on claude.ai, so it does not inherit microphone access.
const frameHtml = (port) =>
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe src="http://127.0.0.1:${port}/"></iframe>`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/frame' ? frameHtml(server.address().port) : html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const nameOf = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const expectNames = (melody) => melody.map(([p]) => nameOf(p)).join(' ');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${micPath}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
  await context.grantPermissions(['microphone'], { origin: url });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(url);
  await page.waitForFunction(() => window.__mt?.take()?.source === 'sample' && window.__mt.phase === 'idle');
  const sample = await page.evaluate(() => window.__mt.notes());
  check('sample melody is transcribed', sample.map((n) => n.name).join(' ') === 'E4 D4 C4 D4 E4 G4 A4 G4 F4 E4 D4 C4', sample.map((n) => n.name).join(' '));
  check('the in-between note is flagged', sample.filter((n) => n.flagged).map((n) => n.name).join(' ') === 'F4');

  // ---- fix the flagged note from the check list, then undo
  await page.click('.flag-row');
  await page.waitForSelector('#note-edit:not([hidden])');
  await page.click('.cand[aria-label="F♯4 にする"]');
  const fixedNotes = await page.evaluate(() => window.__mt.notes());
  check('picking a candidate changes the note and clears the flag', fixedNotes[8].name === 'F♯4' && !fixedNotes[8].flagged && fixedNotes.every((n) => !n.flagged), fixedNotes[8].name);
  check('all-clear card appears', await page.isVisible('#all-ok'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => window.__mt.notes());
  check('undo restores the original note', undone[8].name === 'F4' && undone[8].flagged, undone[8].name);
  await page.screenshot({ path: join(out, 'sample.png') });

  // ---- playback moves the playhead; settings switch the note names
  await page.click('#btn-play');
  await page.waitForTimeout(1500);
  const pos = await page.textContent('#ctr-pos');
  await page.click('#btn-play');
  check('playback moves the playhead', pos !== '1.1', `at ${pos}`);
  await page.click('#btn-settings');
  await page.click('.seg[data-setting="notation"] button[data-v="doremi"]');
  await page.keyboard.press('Escape');
  check('ドレミ notation is applied', (await page.textContent('.flag-row .lab')) === 'ファ', await page.textContent('.flag-row .lab'));
  await page.click('#btn-settings');
  await page.click('.seg[data-setting="notation"] button[data-v="letter"]');
  await page.click('.seg[data-setting="middleC"] button[data-v="3"]');
  await page.keyboard.press('Escape');
  check('middle C = C3 renames F4 to F3', (await page.textContent('.flag-row .lab')) === 'F3', await page.textContent('.flag-row .lab'));
  await page.click('#btn-settings');
  await page.click('.seg[data-setting="middleC"] button[data-v="4"]');
  await page.keyboard.press('Escape');

  // ---- 1. microphone take
  await page.fill('#bpm', '100');
  await page.press('#bpm', 'Enter');
  await page.click('#btn-rec');
  await page.waitForFunction(() => window.__mt.phase === 'count', null, { timeout: 10000 });
  await page.waitForFunction(() => window.__mt.phase === 'rec', null, { timeout: 10000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(out, 'recording.png') });
  const live = await page.evaluate(() => window.__mt.liveFrames());
  check('live pitch frames arrive while recording', live > 50, `${live} frames`);
  await page.waitForTimeout(3200);
  await page.click('#btn-rec');
  await page.waitForFunction(() => window.__mt.take()?.source === 'mic' && window.__mt.phase === 'idle', null, { timeout: 20000 });
  const take = await page.evaluate(() => window.__mt.take());
  const micNotes = await page.evaluate(() => window.__mt.notes());
  const micNames = micNotes.map((n) => n.name).join(' ');
  check('mic take notes match the sung melody', micNames === expectNames(MIC_MELODY), micNames);
  check('tuning offset is detected (sung -18 cents)', Math.abs(take.tuningCents + 18) <= 8, `${take.tuningCents} cents`);
  check('first note lands near bar 1', Math.abs(micNotes[0]?.startBeat ?? 99) < 0.75, `beat ${micNotes[0]?.startBeat.toFixed(2)}`);
  check('analysis is faster than real time', take.millisPerFrame < 16, `${take.millisPerFrame.toFixed(2)} ms per 16 ms frame`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, 'after-recording.png') });

  // ---- export MIDI
  await page.click('#btn-export');
  await page.click('.tile[data-kind="midi"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-download')]);
  const midPath = join(out, download.suggestedFilename());
  await download.saveAs(midPath);
  const midi = new Midi(await readFile(midPath));
  const track = midi.tracks.find((t) => t.notes.length);
  const midiNames = track ? track.notes.map((n) => n.name.replace('#', '♯')).join(' ') : '';
  check('MIDI file has the same notes', midiNames === micNames, `${download.suggestedFilename()}: ${midiNames}`);
  check('MIDI tempo is 100 BPM', Math.round(midi.header.tempos[0]?.bpm ?? 0) === 100, `${midi.header.tempos[0]?.bpm}`);
  check('MIDI has 4/4 and a key signature', midi.header.timeSignatures[0]?.timeSignature?.join('/') === '4/4' && midi.header.keySignatures.length === 1, `${midi.header.keySignatures[0]?.key} ${midi.header.keySignatures[0]?.scale}`);
  check('MIDI resolution is 480 PPQ', midi.header.ppq === 480);

  // ---- export MIDI + voice (zip)
  await page.click('#btn-export');
  await page.click('.tile[data-kind="both"]');
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-download')]);
  const zipPath = join(out, zipDl.suggestedFilename());
  await zipDl.saveAs(zipPath);
  const exp = await page.evaluate(() => window.__mt.lastExport());
  check('zip holds .mid and -voice.wav', exp.files.length === 2 && exp.files[0].name.endsWith('.mid') && exp.files[1].name.endsWith('-voice.wav'), exp.files.map((f) => `${f.name} ${f.size} B`).join(', '));

  // ---- 2. audio file upload
  await page.setInputFiles('#file', filePath);
  await page.waitForFunction(() => window.__mt.take()?.source === 'file' && window.__mt.phase === 'idle', null, { timeout: 20000 });
  const fileNotes = await page.evaluate(() => window.__mt.notes());
  const fileNames = fileNotes.map((n) => n.name).join(' ');
  const fileBpm = await page.evaluate(() => window.__mt.bpm);
  const fileKey = await page.evaluate(() => window.__mt.key);
  check('uploaded file notes match', fileNames === expectNames(FILE_MELODY), fileNames);
  check('tempo guess is close', Math.abs(fileBpm - FILE_BPM) <= 3, `${fileBpm} BPM (sung at ${FILE_BPM})`);
  check('key guess is A minor or C major', fileKey === 'Am' || fileKey === 'C', fileKey);
  check('first note starts bar 1', Math.abs(fileNotes[0]?.startBeat ?? 99) < 0.1);

  const box = await page.locator('canvas.roll').boundingBox();
  check('roll canvas is laid out', !!box && box.width > 300 && box.height > 300, box ? `${Math.round(box.width)}×${Math.round(box.height)}` : '');

  await page.screenshot({ path: join(out, 'desktop.png') });

  // ---- 3. claude.ai artifact mode: no microphone, files are saved through the viewer as .zip
  const art = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await art.addInitScript(() => {
    window.claude = {
      use: async (name) =>
        name === 'downloads'
          ? { save: async ({ filename, data }) => ((window.__saved = { filename, size: data.size }), { status: 'saved' }) }
          : null,
    };
  });
  const ap = await art.newPage();
  ap.on('pageerror', (e) => errors.push(`artifact: ${e.message}`));
  await ap.goto(`${url}frame`);
  const app = ap.frames().find((f) => f !== ap.mainFrame()) ?? (await (await ap.waitForSelector('iframe')).contentFrame());
  await app.waitForFunction(() => window.__mt?.take()?.source === 'sample' && window.__mt.phase === 'idle');
  check('artifact mode hides REC and highlights "open file"', (await app.isHidden('#btn-rec')) && (await app.getAttribute('#btn-open', 'class')).includes('accent'));
  await app.setInputFiles('#file', filePath);
  await app.waitForFunction(() => window.__mt.take()?.source === 'file' && window.__mt.phase === 'idle', null, { timeout: 20000 });
  await app.click('#btn-export');
  await app.click('.tile[data-kind="midi"]');
  await app.click('#btn-download');
  await app.waitForFunction(() => window.__saved);
  const saved = await app.evaluate(() => window.__saved);
  const artExp = await app.evaluate(() => window.__mt.lastExport());
  check('artifact export saves a .zip holding the .mid', saved.filename === 'phone-memo.zip' && artExp.files.length === 1 && artExp.files[0].name === 'phone-memo.mid', `${saved.filename} ${saved.size} B`);
  await ap.screenshot({ path: join(out, 'artifact-mode.png') });
  await art.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, 'phone.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal page scroll on a phone', overflow <= 0, `${overflow}px`);
  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
