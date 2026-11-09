// End-to-end checks in real Chromium (run with `npm run e2e`, which builds first):
//  - microphone takes (Chromium's fake mic plays a synthetic singer) -> notes -> MIDI download
//  - audio files: upload, drop anywhere, a 5-minute take
//  - editing, playback, shortcuts, settings, the claude.ai artifact mode, a phone layout
//  - the ScriptProcessor fallback and a stereo input with the voice on one channel
//  - the synth envelope and lazy note scheduling (OfflineAudioContext)
// Needs Playwright with Chromium: `npm i -D playwright && npx playwright install chromium`.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}
const { Midi } = require('@tonejs/midi');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e/out');
await mkdir(out, { recursive: true });

// Fixtures (TypeScript) -> a temporary ES module; the player probe -> a script for a test page.
const fx = join(out, 'fixtures.mjs');
await build({ entryPoints: [join(root, 'e2e/fixtures.ts')], bundle: true, format: 'esm', platform: 'node', outfile: fx, logLevel: 'warning' });
const probe = await build({ entryPoints: [join(root, 'e2e/player-probe.ts')], bundle: true, format: 'iife', write: false, logLevel: 'warning' });
const probeJs = probe.outputFiles[0].text;
const { micWav, fileWav, longWav, micWavRightOnly, noteName, MIC_MELODY, FILE_MELODY, FILE_BPM } = await import(pathToFileURL(fx).href);

const micPath = join(out, 'mic-take.wav');
const rightPath = join(out, 'mic-right-only.wav');
const filePath = join(out, 'phone-memo.wav');
const longPath = join(out, 'long-take.wav');
// Count-in at 100 BPM is 2.4 s; the fake mic starts when the page opens the device.
await writeFile(micPath, micWav(48000, 2.55));
await writeFile(rightPath, micWavRightOnly(48000, 2.55));
await writeFile(filePath, fileWav(44100));
await writeFile(longPath, longWav(16000, 300));

const html = await readFile(join(root, 'dist/index.html'));
// "/frame" embeds the app cross-origin (localhost -> 127.0.0.1) like the claude.ai viewer, without microphone access.
const frameHtml = (port) =>
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe src="http://127.0.0.1:${port}/"></iframe>`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (req.url === '/frame') res.end(frameHtml(server.address().port));
  else if (req.url === '/probe') res.end(`<!doctype html><meta charset="utf-8"><script>${probeJs}</script>`);
  else res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;

const expectNames = (melody) => melody.map(([p]) => noteName(p)).join(' ');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const fakeMic = (file) => [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${file}%noloop`,
  '--autoplay-policy=no-user-gesture-required',
];

// Count microphone tracks the page opens, to check that each take releases the mic.
const trackMic = () => {
  const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__tracks = [];
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await open(c);
    window.__tracks.push(...s.getTracks());
    return s;
  };
};
const liveTracks = (page) => page.evaluate(() => window.__tracks.filter((t) => t.readyState === 'live').length);

async function newApp(browser, options = {}, initScript = null) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true, ...options });
  await context.grantPermissions(['microphone'], { origin: url });
  await context.addInitScript(trackMic);
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => window.__mt?.take()?.source === 'sample' && window.__mt.phase === 'idle');
  return { context, page };
}

async function recordTake(page, ms) {
  await page.click('#btn-rec');
  await page.waitForFunction(() => window.__mt.phase === 'count', null, { timeout: 10000 });
  await page.waitForFunction(() => window.__mt.phase === 'rec', null, { timeout: 10000 });
  await page.waitForTimeout(ms);
  await page.click('#btn-rec');
  await page.waitForFunction(() => window.__mt.take()?.source === 'mic' && window.__mt.phase === 'idle', null, { timeout: 20000 });
}

const counter = (page) => page.textContent('#ctr-pos');

const browser = await chromium.launch({ args: fakeMic(micPath) });
try {
  const { context, page } = await newApp(browser);
  const sample = await page.evaluate(() => window.__mt.notes());
  check('sample melody is transcribed', sample.map((n) => n.name).join(' ') === 'E4 D4 C4 D4 E4 G4 A4 G4 F4 E4 D4 C4', sample.map((n) => n.name).join(' '));
  check('the in-between note is flagged', sample.filter((n) => n.flagged).map((n) => n.name).join(' ') === 'F4');

  // ---- fix the flagged note from the check list, then undo
  await page.click('.flag-row');
  await page.waitForSelector('#note-edit:not([hidden])');
  await page.click('.cand[aria-label="F♯4 にする"]');
  const fixedNotes = await page.evaluate(() => window.__mt.notes());
  check('picking a candidate changes the note and clears the flag', fixedNotes[8].name === 'F♯4' && fixedNotes.every((n) => !n.flagged), fixedNotes[8].name);
  check('all-clear card appears', await page.isVisible('#all-ok'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => window.__mt.notes());
  check('undo restores the original note', undone[8].name === 'F4' && undone[8].flagged, undone[8].name);
  await page.screenshot({ path: join(out, 'sample.png') });

  // ---- keyboard only: Enter on a check-list row keeps focus on a control; arrows select any note
  await page.focus('.flag-row');
  await page.keyboard.press('Enter');
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  check('focus stays on a control after Enter in the inspector', /flag-row|cand/.test(focused), focused || 'body');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  const viaKeys = (await page.isVisible('#note-edit')) && (await page.textContent('#now-label')) === 'NOTE';
  await page.keyboard.press('Escape');
  check('arrow keys select notes without a mouse', viaKeys);

  // ---- playback moves the playhead; settings switch the note names
  await page.click('#btn-play');
  await page.waitForTimeout(1500);
  const pos = await counter(page);
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

  // ---- switching the input mode re-analyzes but keeps hand edits
  await page.click('.flag-row');
  await page.click('.cand[aria-label="F♯4 にする"]');
  await page.keyboard.press('Escape');
  await page.click('#btn-settings');
  await page.click('.seg[data-setting="mode"] button[data-v="hum"]');
  await page.waitForFunction(() => window.__mt.phase === 'idle' && window.__mt.notes().length > 0);
  const hummed = await page.evaluate(() => window.__mt.notes());
  await page.click('.seg[data-setting="mode"] button[data-v="sing"]');
  await page.waitForFunction(() => window.__mt.phase === 'idle' && window.__mt.notes().length > 0);
  const sungAgain = await page.evaluate(() => window.__mt.notes());
  check('a hand-fixed note survives re-analysis in another mode', hummed[8]?.name === 'F♯4' && sungAgain[8]?.name === 'F♯4' && !sungAgain[8].flagged, `${hummed[8]?.name} / ${sungAgain[8]?.name}`);
  await page.click('#btn-sample');
  await page.waitForFunction(() => window.__mt.phase === 'idle' && window.__mt.notes()[8]?.flagged);

  // ---- REC pressed twice quickly: the second press cancels and no microphone stays open
  await page.keyboard.press('r');
  await page.keyboard.press('r');
  await page.waitForTimeout(1500);
  check('a double REC press cancels cleanly', (await page.evaluate(() => window.__mt.phase)) === 'idle' && (await liveTracks(page)) === 0, `phase ${await page.evaluate(() => window.__mt.phase)}, live mic tracks ${await liveTracks(page)}`);

  // ---- microphone take
  await page.fill('#bpm', '100');
  await page.press('#bpm', 'Enter');
  await page.click('#btn-rec');
  await page.waitForFunction(() => window.__mt.phase === 'count', null, { timeout: 10000 });
  await page.click('#btn-settings');
  check('sample and input mode are locked while recording', (await page.isDisabled('#btn-sample')) && (await page.isDisabled('.seg[data-setting="mode"] button[data-v="hum"]')));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__mt.phase === 'rec', null, { timeout: 10000 });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(out, 'recording.png') });
  const live = await page.evaluate(() => window.__mt.liveFrames());
  check('live pitch frames arrive while recording', live > 50, `${live} frames`);
  check('undo is ignored while recording', (await page.evaluate(() => window.__mt.bpm)) === 100);
  await page.waitForTimeout(3200);
  await page.click('#btn-rec');
  await page.waitForFunction(() => window.__mt.take()?.source === 'mic' && window.__mt.phase === 'idle', null, { timeout: 20000 });
  check('the microphone is released after the take', (await liveTracks(page)) === 0);
  const take = await page.evaluate(() => window.__mt.take());
  const micNotes = await page.evaluate(() => window.__mt.notes());
  const micNames = micNotes.map((n) => n.name).join(' ');
  check('mic take notes match the sung melody', micNames === expectNames(MIC_MELODY), micNames);
  check('tuning offset is detected (sung -18 cents)', Math.abs(take.tuningCents + 18) <= 8, `${take.tuningCents} cents`);
  check('first note lands near bar 1', Math.abs(micNotes[0]?.startBeat ?? 99) < 0.75, `beat ${micNotes[0]?.startBeat.toFixed(2)}`);
  check('the take keeps the click tempo', (await page.evaluate(() => window.__mt.bpm)) === 100);
  check('analysis is faster than real time', take.millisPerFrame < 16, `${take.millisPerFrame.toFixed(2)} ms per 16 ms frame`);

  // ---- Space after stopping with the REC button plays the take (it must not start a new recording)
  await page.keyboard.press(' ');
  await page.waitForTimeout(400);
  const spacePlays = (await page.getAttribute('#btn-play', 'class')).includes('on') && (await page.evaluate(() => window.__mt.phase)) === 'idle';
  await page.keyboard.press(' ');
  check('Space plays after stopping with REC', spacePlays);
  await page.waitForTimeout(500);
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
  check('MIDI has 4/4 and a key signature', midi.header.timeSignatures[0]?.timeSignature?.join('/') === '4/4' && midi.header.keySignatures.length === 1);
  check('MIDI resolution is 480 PPQ', midi.header.ppq === 480);
  const ons = track ? track.notes.map((n) => n.ticks) : [];
  check('MIDI notes never start together', new Set(ons).size === ons.length);

  // ---- export MIDI + voice (zip)
  await page.click('#btn-export');
  await page.click('.tile[data-kind="both"]');
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-download')]);
  await zipDl.saveAs(join(out, zipDl.suggestedFilename()));
  const exp = await page.evaluate(() => window.__mt.lastExport());
  check('zip holds .mid and -voice.wav', exp.files.length === 2 && exp.files[0].name.endsWith('.mid') && exp.files[1].name.endsWith('-voice.wav'), exp.files.map((f) => `${f.name} ${f.size} B`).join(', '));

  // ---- audio file upload
  await page.setInputFiles('#file', filePath);
  await page.waitForFunction(() => window.__mt.take()?.source === 'file' && window.__mt.phase === 'idle', null, { timeout: 20000 });
  const fileNotes = await page.evaluate(() => window.__mt.notes());
  const fileNames = fileNotes.map((n) => n.name).join(' ');
  const fileBpm = await page.evaluate(() => window.__mt.bpm);
  check('uploaded file notes match', fileNames === expectNames(FILE_MELODY), fileNames);
  check('tempo guess is close', Math.abs(fileBpm - FILE_BPM) <= 3, `${fileBpm} BPM (sung at ${FILE_BPM})`);
  check('key guess is A minor or C major', ['Am', 'C'].includes(await page.evaluate(() => window.__mt.key)));
  check('first note starts bar 1', Math.abs(fileNotes[0]?.startBeat ?? 99) < 0.1);

  // ---- 原音 plays the voice under the selected note (the file starts with 0.73 s of silence)
  const listenAt = async (i) => {
    await page.evaluate((k) => window.__mt.select(k), i);
    const note = await page.textContent('#now-sub'); // the app's bar.beat of the selected note
    await page.click('#btn-listen');
    await page.waitForTimeout(120);
    const at = await counter(page);
    await page.waitForFunction(() => !document.querySelector('#btn-play').classList.contains('on'), null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    return { note, at, after: await counter(page) };
  };
  const first = await listenAt(0);
  const fifth = await listenAt(4);
  check('原音 plays from the selected note', first.at === first.note && fifth.at === fifth.note, `first ${first.at} (note at ${first.note}), fifth ${fifth.at} (note at ${fifth.note})`);
  check('the playhead returns after 原音', first.after === '1.1' && fifth.after === '1.1', `${first.after} / ${fifth.after}`);
  await page.keyboard.press('Escape');

  // ---- after dragging a knob, Home still rewinds and the knob keeps its value
  const roll = await page.locator('.scroller').boundingBox();
  await page.mouse.click(roll.x + roll.width * 0.6, roll.y + roll.height - 80);
  const moved = await counter(page);
  const knob = await page.locator('#knob-snap input').boundingBox();
  await page.mouse.move(knob.x + 20, knob.y + knob.height / 2);
  await page.mouse.down();
  await page.mouse.move(knob.x + 40, knob.y + knob.height / 2, { steps: 4 });
  await page.mouse.up();
  const scale = await page.textContent('#knob-snap text');
  await page.keyboard.press('Home');
  check('Home rewinds after a knob drag without moving the knob', moved !== '1.1' && (await counter(page)) === '1.1' && (await page.textContent('#knob-snap text')) === scale, `cursor ${moved} → ${await counter(page)}, SCALE ${scale} → ${await page.textContent('#knob-snap text')}`);

  // ---- a file dropped anywhere is loaded (not opened by the browser)
  const bytes = Array.from(await readFile(filePath));
  const prevented = await page.evaluate((data) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], 'dropped.wav', { type: 'audio/wav' }));
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('.inspector').dispatchEvent(ev);
    return ev.defaultPrevented;
  }, bytes);
  await page.waitForFunction(() => window.__mt.take()?.name === 'dropped' && window.__mt.phase === 'idle', null, { timeout: 20000 });
  check('a file dropped outside the roll is loaded', prevented);

  // ---- a 5-minute take: the roll canvas stays viewport-sized and draws at both ends; playback stays smooth
  await page.setInputFiles('#file', longPath);
  await page.waitForFunction(() => window.__mt.take()?.name === 'long-take' && window.__mt.phase === 'idle', null, { timeout: 60000 });
  const drawn = () =>
    page.evaluate(() => {
      const c = document.querySelector('canvas.roll');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) lit++;
      return { width: c.width, lit };
    });
  const startView = await drawn();
  await page.evaluate(() => {
    const s = document.querySelector('.scroller');
    s.scrollLeft = s.scrollWidth;
  });
  await page.waitForTimeout(150);
  const endView = await drawn();
  await page.evaluate(() => {
    document.querySelector('.scroller').scrollLeft = 0;
  });
  check('long take: roll canvas stays viewport-sized and draws', startView.width <= 1400 && startView.lit > 100 && endView.lit > 100, `canvas ${startView.width}px, ${(await page.evaluate(() => window.__mt.notes().length))} notes`);
  await page.click('#btn-play');
  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
          else resolve((n * 1000) / (performance.now() - t0));
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.click('#btn-play');
  check('long take: playback keeps the frame rate', fps > 30, `${fps.toFixed(0)} fps`);

  await page.screenshot({ path: join(out, 'desktop.png') });
  check('no page errors (main run)', page.errors.length === 0, page.errors.join(' | '));
  await context.close();

  // ---- phone: swiping the roll scrolls it without moving the cursor; a tap still moves it
  const phone = await newApp(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await phone.page.setInputFiles('#file', longPath);
  await phone.page.waitForFunction(() => window.__mt.take()?.name === 'long-take' && window.__mt.phase === 'idle', null, { timeout: 60000 });
  const box = await phone.page.locator('.scroller').boundingBox();
  const cdp = await phone.context.newCDPSession(phone.page);
  // A vertical swipe on the roll scrolls the page (the roll only takes horizontal scrolling).
  const vtouch = (type, yy) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: box.x + box.width / 2, y: yy }] });
  await vtouch('touchStart', box.y + box.height * 0.7);
  for (let i = 1; i <= 10; i++) await vtouch('touchMove', box.y + box.height * 0.7 - i * 15);
  await vtouch('touchEnd');
  await phone.page.waitForTimeout(400);
  const pageScrolled = await phone.page.evaluate(() => window.scrollY);
  await phone.page.evaluate(() => window.scrollTo(0, 0));
  await phone.page.waitForTimeout(200);
  check('phone: a vertical swipe on the roll scrolls the page', pageScrolled > 50, `${pageScrolled}px`);
  const y = box.y + box.height * 0.4;
  const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', box.x + box.width - 30);
  for (let i = 1; i <= 10; i++) await touch('touchMove', box.x + box.width - 30 - i * 18);
  await touch('touchEnd');
  await phone.page.waitForTimeout(400);
  const scrolled = await phone.page.evaluate(() => document.querySelector('.scroller').scrollLeft);
  const afterSwipe = await counter(phone.page);
  await phone.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 70);
  await phone.page.waitForTimeout(200);
  const afterTap = await counter(phone.page);
  check('phone: a swipe scrolls without moving the cursor, a tap moves it', scrolled > 50 && afterSwipe === '1.1' && afterTap !== '1.1', `scrolled ${scrolled}px, cursor ${afterSwipe} → ${afterTap}`);
  await phone.page.evaluate(() => document.querySelector('#btn-sample').click());
  await phone.page.waitForFunction(() => window.__mt.take()?.source === 'sample' && window.__mt.phase === 'idle');
  await phone.page.screenshot({ path: join(out, 'phone.png'), fullPage: true });
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone: no horizontal page scroll', overflow <= 0, `${overflow}px`);
  check('no page errors (phone)', phone.page.errors.length === 0, phone.page.errors.join(' | '));
  await phone.context.close();

  // ---- AudioWorklet unavailable: the ScriptProcessor fallback keeps the timeline
  const fallback = await newApp(browser, {}, () => {
    AudioWorklet.prototype.addModule = () => Promise.reject(new Error('blocked for the test'));
  });
  await fallback.page.fill('#bpm', '100');
  await fallback.page.press('#bpm', 'Enter');
  await recordTake(fallback.page, 5700);
  const fbNotes = await fallback.page.evaluate(() => window.__mt.notes());
  const lastStart = fbNotes[fbNotes.length - 1]?.startBeat ?? -1;
  check('ScriptProcessor fallback: notes match and stay on the grid', fbNotes.map((n) => n.name).join(' ') === expectNames(MIC_MELODY) && Math.abs(lastStart - 6) < 0.35, `${fbNotes.map((n) => n.name).join(' ')}; last note at beat ${lastStart.toFixed(2)}`);
  check('ScriptProcessor fallback: the microphone is released', (await liveTracks(fallback.page)) === 0);
  check('no page errors (fallback)', fallback.page.errors.length === 0, fallback.page.errors.join(' | '));
  await fallback.context.close();

  // ---- claude.ai artifact mode: no microphone, files are saved through the viewer as .zip
  const art = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await art.addInitScript(() => {
    window.claude = {
      use: async (name) =>
        name === 'downloads' ? { save: async ({ filename, data }) => ((window.__saved = { filename, size: data.size }), { status: 'saved' }) } : null,
    };
  });
  const ap = await art.newPage();
  const artErrors = [];
  ap.on('pageerror', (e) => artErrors.push(e.message));
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
  check('no page errors (artifact)', artErrors.length === 0, artErrors.join(' | '));
  await art.close();

  // ---- synth: short notes release before the next one; long takes start playing without a stall
  const pp = await browser.newPage();
  await pp.goto(`${url}probe`);
  const env = await pp.evaluate(async () => {
    const ctx = new OfflineAudioContext(1, 48000 * 1.2, 48000);
    new window.Player(ctx).preview(60, 'piano');
    const buf = await ctx.startRendering();
    const x = buf.getChannelData(0);
    const rms = (a, b) => {
      let s = 0;
      for (let i = Math.round(a * 48000); i < Math.round(b * 48000); i++) s += x[i] * x[i];
      return Math.sqrt(s / (Math.round(b * 48000) - Math.round(a * 48000)));
    };
    return { held: rms(0.05, 0.3), tail: rms(0.36 + 0.4, 0.36 + 0.48) };
  });
  check('a short piano note releases', env.tail < env.held * 0.02, `tail ${(env.tail / env.held * 100).toFixed(2)} % of the held level`);
  const playMs = await pp.evaluate(() => {
    const ctx = new AudioContext();
    const p = new window.Player(ctx);
    const notes = Array.from({ length: 750 }, (_, i) => ({ pitch: 60 + (i % 12), start: i * 0.4, dur: 0.35, velocity: 90 }));
    const t0 = performance.now();
    p.play({ notes, voice: null, voiceZero: 0, from: 0, balance: 1, instrument: 'piano' });
    const ms = performance.now() - t0;
    p.stop();
    return ms;
  });
  check('playback of 750 notes starts without a stall', playMs < 40, `${playMs.toFixed(1)} ms`);
  await pp.close();
} finally {
  await browser.close();
}

// ---- stereo input with the voice on the right channel only
const stereo = await chromium.launch({ args: fakeMic(rightPath) });
try {
  const { page } = await newApp(stereo);
  await page.fill('#bpm', '100');
  await page.press('#bpm', 'Enter');
  await recordTake(page, 5700);
  const names = (await page.evaluate(() => window.__mt.notes())).map((n) => n.name).join(' ');
  check('stereo input with the voice on one channel is transcribed', names === expectNames(MIC_MELODY), names);
} finally {
  await stereo.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
