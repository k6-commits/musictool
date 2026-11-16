// End-to-end checks in real Chromium (run with `npm run e2e`, which builds first):
//  - microphone takes (Chromium's fake mic plays a synthetic singer) -> notes -> MIDI download
//  - audio files: upload, drop anywhere, a 5-minute take
//  - editing, playback, shortcuts, settings, the claude.ai artifact mode, a phone layout
//  - the ScriptProcessor fallback and a stereo input with the voice on one channel
//  - the latency measurement: through a loopback microphone (then a take whose clicks must land on the beats),
//    through one that does not hear the speakers, and stopped halfway; the share sheet on iPhone and Android
//  - the installable app: Chrome's installability check, the offline start, error pages, the install button, sheets
//    on close requests, the exit warning for an unsaved take on a phone, a sandboxed frame
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
let devices;
try {
  ({ chromium, devices } = require('playwright'));
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
// The claude.ai fragment in the document the viewer wraps it in.
const artifactHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${await readFile(join(root, 'dist/artifact.html'), 'utf8')}</body></html>`;
// The site as GitHub Pages serves it: the page and the files the build wrote next to it, 404 for anything else.
// While `serverDown` is set every request fails as with no network; `pageStatus` makes the page answer an error.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
let serverDown = false;
let pageStatus = 200;
// "/frame" embeds the claude.ai fragment cross-origin (localhost -> 127.0.0.1) like the viewer, without microphone
// access; "/sandboxed" embeds the standalone page in a sandbox without allow-same-origin.
const frameHtml = (src, sandbox = '') =>
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe src="${src}"${sandbox ? ` sandbox="${sandbox}"` : ''}></iframe>`;
const server = createServer(async (req, res) => {
  if (serverDown) {
    req.socket.destroy();
    return;
  }
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  const path = req.url.split('?')[0];
  const other = `http://127.0.0.1:${server.address().port}`;
  if (path === '/frame') return send(200, TYPES['.html'], frameHtml(`${other}/artifact`));
  if (path === '/sandboxed') return send(200, TYPES['.html'], frameHtml(`${other}/`, 'allow-scripts'));
  if (path === '/artifact') return send(200, TYPES['.html'], artifactHtml);
  if (path === '/probe') return send(200, TYPES['.html'], `<!doctype html><meta charset="utf-8"><script>${probeJs}</script>`);
  if (path === '/' || path === '/index.html') return send(pageStatus, TYPES['.html'], pageStatus === 200 ? html : 'Service Unavailable');
  const type = TYPES[path.slice(path.lastIndexOf('.'))];
  const file = type && /^\/[\w.-]+$/.test(path) && path !== '/artifact.html' ? await readFile(join(root, 'dist', path)).catch(() => null) : null;
  if (file) send(200, type, file);
  else send(404, 'text/plain; charset=utf-8', 'Not Found');
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

// A share sheet whose canShare() says yes to any files, as real ones do (they check types and sizes only in share());
// it records what it was given, or refuses everything once __shareFails is set.
const shareSheet = () => {
  navigator.canShare = (data) => Array.isArray(data?.files) && data.files.length > 0;
  navigator.share = async (data) => {
    if (window.__shareFails) throw new DOMException('Permission denied', 'NotAllowedError');
    window.__shared = data.files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
  };
};

// A loopback microphone: whatever the page sends to its speakers comes back as microphone input 120 ms later.
const loopbackMic = () => {
  const DELAY = 0.12;
  const connect = AudioNode.prototype.connect;
  let tap = null;
  window.AudioContext = class extends window.AudioContext {
    constructor(...args) {
      super(...args);
      const line = this.createDelay(1);
      line.delayTime.value = DELAY;
      const out = this.createMediaStreamDestination();
      connect.call(line, out);
      tap = { ctx: this, line, out };
    }
  };
  AudioNode.prototype.connect = function (target, ...rest) {
    const result = connect.call(this, target, ...rest);
    if (tap && target === tap.ctx.destination) connect.call(this, tap.line);
    return result;
  };
  navigator.mediaDevices.getUserMedia = async () => {
    const stream = new MediaStream(tap.out.stream.getAudioTracks().map((t) => t.clone()));
    window.__tracks.push(...stream.getTracks());
    return stream;
  };
};

// The samples of a 16-bit mono WAV as written by the app (44-byte header).
const readWav = (buf) => {
  const x = new Float32Array((buf.length - 44) / 2);
  for (let i = 0; i < x.length; i++) x[i] = buf.readInt16LE(44 + 2 * i) / 32768;
  return { sr: buf.readUInt32LE(24), x };
};
// Where the click near `t` (seconds) starts: the first sample at 20 % of its peak.
const clickOnset = ({ sr, x }, t) => {
  const from = Math.max(0, Math.round((t - 0.03) * sr));
  const to = Math.min(x.length, Math.round((t + 0.08) * sr));
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = from; i < to; i++) if (Math.abs(x[i]) >= 0.2 * peak) return i / sr;
  return NaN;
};

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

/** Wait until the app has loaded and analyzed its sample (true), or `timeout` ms have passed (false). */
const sampleReady = (target, timeout = 30000) =>
  target.waitForFunction(() => window.__mt?.take()?.source === 'sample' && window.__mt.phase === 'idle', null, { timeout }).then(
    () => true,
    () => false,
  );

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
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  const undoneAgain = (await page.evaluate(() => window.__mt.notes()))[8];
  check('the fix can still be undone after re-analysis', undoneAgain?.name === 'F4' && undoneAgain.flagged, `${undoneAgain?.name}${undoneAgain?.flagged ? ' (flagged)' : ''}`);
  await page.click('#btn-settings');
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
  check('no share button without a share sheet', await page.isHidden('#btn-share'));
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
  await page.mouse.click(roll.x + roll.width * 0.6, roll.y + roll.height - 80);
  const moved2 = await counter(page);
  const balance = await page.inputValue('#balance');
  await page.locator('.fader svg').first().click();
  await page.keyboard.press('Home');
  check('Home rewinds after a click on the fader card without moving the fader', moved2 !== '1.1' && (await counter(page)) === '1.1' && (await page.inputValue('#balance')) === balance, `cursor ${moved2} → ${await counter(page)}, balance ${balance} → ${await page.inputValue('#balance')}`);
  const altArrow = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, label: document.getElementById('now-label').textContent };
  });
  check('Alt+← is left to the browser (Back)', !altArrow.prevented, `prevented ${altArrow.prevented}, ${altArrow.label}`);

  // ---- a file dropped anywhere is loaded (not opened by the browser), even onto an open sheet
  const bytes = Array.from(await readFile(filePath));
  const dropOn = (selector) =>
    page.evaluate(
      ({ data, selector }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(data)], 'dropped.wav', { type: 'audio/wav' }));
        const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
        document.querySelector(selector).dispatchEvent(ev);
        return ev.defaultPrevented;
      },
      { data: bytes, selector },
    );
  const prevented = await dropOn('.inspector');
  await page.waitForFunction(() => window.__mt.take()?.name === 'dropped' && window.__mt.phase === 'idle', null, { timeout: 20000 });
  check('a file dropped outside the roll is loaded', prevented);
  await page.click('#btn-settings');
  await page.click('#btn-sample');
  await page.waitForFunction(() => window.__mt.take()?.source === 'sample' && window.__mt.phase === 'idle');
  await page.click('#btn-export');
  await dropOn('#export');
  await page.waitForFunction(() => window.__mt.take()?.name === 'dropped' && window.__mt.phase === 'idle', null, { timeout: 20000 });
  const sheetClosed = await page.evaluate(() => document.getElementById('export').hidden);
  await page.click('#btn-export');
  const exportName = await page.inputValue('#export-name');
  await page.keyboard.press('Escape');
  check('a file dropped on the export sheet is exported under its own name', sheetClosed && exportName === 'dropped', `sheet ${sheetClosed ? 'closed' : 'open'}, name ${exportName}`);

  // ---- a 5-minute take: the roll canvas stays viewport-sized and draws at both ends; playback stays smooth
  await page.setInputFiles('#file', longPath);
  await page.waitForFunction(() => window.__mt.take()?.name === 'long-take' && window.__mt.phase === 'idle', null, { timeout: 60000 });
  // Pixels in the note color and in the voice curve's color, over the background or over a note
  // (everything else on the roll is dark grey or the dim waveform lane).
  const drawn = () =>
    page.evaluate(() => {
      const c = document.querySelector('canvas.roll');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const near = (i, r, g, b) => Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 60;
      let notes = 0;
      let voice = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (near(i, 86, 194, 255)) notes++;
        else if (near(i, 219, 93, 65) || near(i, 230, 120, 101)) voice++;
      }
      return { width: c.width, notes, voice };
    });
  await page.waitForTimeout(1600); // the notes' fade-in after loading (at most about 1.4 s)
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
  const draws = (v) => v.notes > 2000 && v.voice > 200;
  check('long take: roll canvas stays viewport-sized and draws notes and voice at both ends', startView.width <= 1400 && draws(startView) && draws(endView), `canvas ${startView.width}px, ${(await page.evaluate(() => window.__mt.notes().length))} notes; note/voice pixels ${startView.notes}/${startView.voice} at the start, ${endView.notes}/${endView.voice} at the end`);
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
  // Wait for the fling to end: a tap while it runs only stops the scrolling.
  await phone.page
    .waitForFunction(() => new Promise((resolve) => {
      const scroller = document.querySelector('.scroller');
      const before = scroller.scrollLeft;
      setTimeout(() => resolve(scroller.scrollLeft === before), 250);
    }), null, { timeout: 5000 })
    .catch(() => {});
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

  // ---- share sheet: an iPhone takes the .mid and the voice as separate files; Android gets no 共有 for MIDI
  const iphone = await newApp(browser, { ...devices['iPhone 13'], deviceScaleFactor: 1 }, shareSheet);
  await iphone.page.click('#btn-export');
  await iphone.page.click('.tile[data-kind="both"]');
  await iphone.page.click('#btn-share');
  await iphone.page.waitForFunction(() => window.__shared);
  const shared = await iphone.page.evaluate(() => window.__shared);
  check('iPhone: share hands over the .mid and the voice .wav', shared.length === 2 && shared[0].name === 'musictool-sample.mid' && shared[0].type === 'audio/midi' && shared[1].name === 'musictool-sample-voice.wav' && shared.every((f) => f.size > 40) && (await iphone.page.isHidden('#export')), shared.map((f) => `${f.name} ${f.type} ${f.size} B`).join(', '));
  await iphone.page.evaluate(() => (window.__shareFails = true));
  await iphone.page.click('#btn-export');
  const [fallbackDl] = await Promise.all([iphone.page.waitForEvent('download'), iphone.page.click('#btn-share')]);
  check('a refused share downloads the files instead', fallbackDl.suggestedFilename() === 'musictool-sample.zip' && /ダウンロード/.test(await iphone.page.textContent('#toast')), `${fallbackDl.suggestedFilename()}: ${await iphone.page.textContent('#toast')}`);
  check('no page errors (iPhone share)', iphone.page.errors.length === 0, iphone.page.errors.join(' | '));
  await iphone.context.close();
  const android = await newApp(browser, { ...devices['Pixel 7'], deviceScaleFactor: 1 }, shareSheet);
  await android.page.click('#btn-export');
  const shareFor = async (kind) => {
    await android.page.click(`.tile[data-kind="${kind}"]`);
    return android.page.isVisible('#btn-share');
  };
  const androidShare = { both: await shareFor('both'), midi: await shareFor('midi'), wav: await shareFor('wav') };
  check('Android: 共有 only for the voice .wav (its share sheet refuses .mid)', !androidShare.both && !androidShare.midi && androidShare.wav, JSON.stringify(androidShare));
  await android.context.close();

  // ---- the installable app on Android: Chrome's own check, the offline start, error pages, the install button,
  // sheets on close requests without history entries, the build in the settings
  const pwa = await newApp(browser, { ...devices['Pixel 7'], deviceScaleFactor: 1 });
  const swActive = await pwa.page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 15000))]));
  // Reloaded, the page is under the service worker's control.
  await pwa.page.reload();
  const controlled = (await sampleReady(pwa.page)) && (await pwa.page.evaluate(() => !!navigator.serviceWorker.controller));
  const pwaCdp = await pwa.context.newCDPSession(pwa.page);
  const { installabilityErrors } = await pwaCdp.send('Page.getInstallabilityErrors');
  const appManifest = await pwaCdp.send('Page.getAppManifest');
  check('installable: the worker takes over, Chrome reports no installability errors and a clean manifest', swActive && controlled && installabilityErrors.length === 0 && appManifest.errors.length === 0, JSON.stringify({ swActive, controlled, installabilityErrors, errors: appManifest.errors }));
  // Another file of the site opened in the tab does not replace the app; then with no network the app still opens.
  await pwa.page.goto(`${url}sw.js`);
  serverDown = true;
  const offlineOk = await pwa.page.goto(url).then(() => sampleReady(pwa.page, 20000), () => false);
  const offlineNotes = offlineOk ? (await pwa.page.evaluate(() => window.__mt.notes())).length : 0;
  serverDown = false;
  check('offline: the app opens from the service worker (another site file opened before) and analyzes the sample', offlineOk && offlineNotes === 12, `opened ${offlineOk}, ${offlineNotes} notes`);
  pageStatus = 503;
  const errorOk = await pwa.page.reload().then(() => sampleReady(pwa.page, 20000), () => false);
  pageStatus = 200;
  check('a server error does not replace the installed app', errorOk);
  // The browser's install prompt arrives as an event; the settings offer it once and keep the focus in the sheet.
  const historyLength = await pwa.page.evaluate(() => history.length);
  await pwa.page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = async () => {
      window.__prompted = (window.__prompted ?? 0) + 1;
      return { outcome: 'accepted' };
    };
    window.dispatchEvent(e);
  });
  await pwa.page.click('#btn-settings');
  const installShown = await pwa.page.isVisible('#btn-install');
  await pwa.page.focus('#btn-install');
  await pwa.page.keyboard.press('Enter');
  const afterInstall = await pwa.page.evaluate(() => ({ prompted: window.__prompted, rowHidden: document.querySelector('#field-install').hidden, focusInSheet: !!document.activeElement?.closest('#settings') }));
  check('the install button shows the browser prompt once and keeps the focus in the sheet', installShown && afterInstall.prompted === 1 && afterInstall.rowHidden && afterInstall.focusInSheet, JSON.stringify(afterInstall));
  const build = await pwa.page.evaluate(() => [...document.querySelectorAll('#measure dt')].find((dt) => dt.textContent === '版')?.nextElementSibling?.textContent ?? '');
  check('the settings show the build', /^([0-9a-f]{7,}\+?|dev)$/.test(build), build);
  // Esc is a close request, as the back gesture on Android: the sheets close through their close watchers.
  const watchers = await pwa.page.evaluate(() => typeof CloseWatcher === 'function');
  await pwa.page.keyboard.press('Escape');
  const settingsClosed = await pwa.page.isHidden('#settings');
  await pwa.page.click('#btn-export');
  const exportOpened = await pwa.page.isVisible('#export');
  await pwa.page.keyboard.press('Escape');
  const sheets = { watchers, settingsClosed, exportOpened, exportClosed: await pwa.page.isHidden('#export'), historyAdded: (await pwa.page.evaluate(() => history.length)) - historyLength };
  check('sheets close on a close request and leave no history entries', Object.values(sheets).every((v) => v === true || v === 0), JSON.stringify(sheets));
  check('no page errors (installable app)', pwa.page.errors.length === 0, pwa.page.errors.join(' | '));
  await pwa.context.close();

  // ---- on a phone, back on the main screen warns once while a recorded take is not saved; sheets come first
  const guard = await newApp(browser, { ...devices['Pixel 7'], deviceScaleFactor: 1 });
  await guard.page.fill('#bpm', '100');
  await guard.page.press('#bpm', 'Enter');
  await recordTake(guard.page, 3000);
  const toastShown = async () => {
    await guard.page.waitForTimeout(150);
    return guard.page.evaluate(() => (document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent));
  };
  const toastGone = () => guard.page.waitForFunction(() => document.querySelector('#toast').hidden, null, { timeout: 6000 }).catch(() => {});
  await toastGone();
  await guard.page.keyboard.press('Escape');
  const firstBack = await toastShown();
  await toastGone();
  await guard.page.keyboard.press('Escape');
  const secondBack = await toastShown();
  await guard.page.click('#btn-settings');
  await guard.page.keyboard.press('Escape');
  const sheetFirst = (await guard.page.isHidden('#settings')) && (await toastShown()) === '';
  await guard.page.keyboard.press('Escape');
  const rearmed = await toastShown();
  await toastGone();
  await guard.page.click('#btn-export');
  await guard.page.click('.tile[data-kind="midi"]');
  await Promise.all([guard.page.waitForEvent('download'), guard.page.click('#btn-download')]);
  await toastGone();
  await guard.page.keyboard.press('Escape');
  const afterSave = await toastShown();
  const guardState = { firstBack, secondBack, sheetFirst, rearmed, afterSave };
  check('unsaved take: the first back warns, the next leaves, a sheet closes first, saving ends the warning', /もう一度戻ると閉じます/.test(firstBack) && secondBack === '' && sheetFirst && /もう一度戻ると閉じます/.test(rearmed) && afterSave === '', JSON.stringify(guardState));
  check('no page errors (exit guard)', guard.page.errors.length === 0, guard.page.errors.join(' | '));
  await guard.context.close();

  // ---- the standalone page in a sandboxed frame (no service worker, no storage there) still starts
  const sandboxed = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const sp = await sandboxed.newPage();
  await sp.goto(`${url}sandboxed`);
  const inner = await (await sp.waitForSelector('iframe')).contentFrame();
  check('the page starts in a sandboxed frame', await sampleReady(inner));
  await sandboxed.close();

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

  // ---- latency measurement through a loopback "microphone" that hears the speakers 120 ms late
  const loop = await newApp(browser, {}, loopbackMic);
  await loop.page.click('#btn-settings');
  await loop.page.click('#btn-measure');
  check('the measurement locks recording and the input mode, and offers to stop', (await loop.page.isDisabled('#btn-rec')) && (await loop.page.isDisabled('.seg[data-setting="mode"] button[data-v="hum"]')) && (await loop.page.textContent('#btn-measure')) === 'やめる' && (await loop.page.isEnabled('#btn-measure')));
  await loop.page.waitForFunction(() => window.__mt.phase === 'idle', null, { timeout: 20000 });
  const measured = await loop.page.evaluate(() => ({ m: window.__mt.measured(), latencyMs: window.__mt.latencyMs, note: document.querySelector('#latency-note').textContent }));
  check('loopback: the round trip is measured', measured.m && measured.m.ms >= 120 && measured.m.ms < 200 && measured.m.heard === measured.m.covered && measured.m.covered >= 9 && measured.latencyMs !== 0, JSON.stringify(measured));
  check('loopback: the measurement is kept', (await loop.page.evaluate(() => JSON.parse(localStorage.getItem('musictool.prefs.v1')))).measured?.ms === measured.m?.ms);
  check('loopback: the measurement releases the microphone', (await liveTracks(loop.page)) === 0);
  // A take with the metronome: the loopback records the clicks late; with the correction they land on the beats.
  await loop.page.keyboard.press('Escape');
  await loop.page.fill('#bpm', '100');
  await loop.page.press('#bpm', 'Enter');
  await recordTake(loop.page, 2600);
  await loop.page.click('#btn-export');
  await loop.page.click('.tile[data-kind="wav"]');
  const [takeDl] = await Promise.all([loop.page.waitForEvent('download'), loop.page.click('#btn-download')]);
  const takePath = join(out, 'loopback-take.wav');
  await takeDl.saveAs(takePath);
  const takeWav = readWav(await readFile(takePath));
  const onsets = [0.6, 1.2, 1.8].map((t) => clickOnset(takeWav, t) - t);
  check('loopback: the clicks in the take start on the beats', onsets.every((d) => Math.abs(d) <= 0.003), onsets.map((d) => `${(d * 1000).toFixed(1)} ms`).join(', '));
  check('no page errors (loopback)', loop.page.errors.length === 0, loop.page.errors.join(' | '));
  await loop.context.close();

  // ---- a microphone that does not hear the speakers (Chromium's fake one plays a singer): no change; then a
  // measurement stopped halfway changes nothing either
  const deaf = await newApp(browser);
  await deaf.page.click('#btn-settings');
  await deaf.page.click('#btn-measure');
  await deaf.page.waitForFunction(() => window.__mt.phase === 'idle', null, { timeout: 20000 });
  const deafState = await deaf.page.evaluate(() => ({ m: window.__mt.measured(), latencyMs: window.__mt.latencyMs, warn: document.querySelector('#latency-note').classList.contains('warn') }));
  check('chirps not heard: a warning and no correction', deafState.m === null && deafState.latencyMs === 0 && deafState.warn, JSON.stringify(deafState));
  check('the measurement releases the microphone', (await liveTracks(deaf.page)) === 0);
  await deaf.page.click('#btn-measure');
  await deaf.page.waitForTimeout(1200);
  await deaf.page.click('#btn-measure');
  const stopped = await deaf.page.evaluate(() => ({ phase: window.__mt.phase, latencyMs: window.__mt.latencyMs, label: document.querySelector('#btn-measure').textContent, focus: document.activeElement?.id }));
  await deaf.page.waitForTimeout(400);
  check('やめる stops the measurement at once, keeps focus and changes nothing', stopped.phase === 'idle' && stopped.latencyMs === 0 && stopped.label === '測る' && stopped.focus === 'btn-measure', JSON.stringify(stopped));
  check('a stopped measurement releases the microphone', (await liveTracks(deaf.page)) === 0);
  check('no page errors (measurement)', deaf.page.errors.length === 0, deaf.page.errors.join(' | '));
  await deaf.context.close();

  // ---- claude.ai artifact mode (the fragment the viewer shows): no microphone, files are saved through the viewer as .zip
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
  await sampleReady(app);
  check('artifact mode (no manifest, no service worker) hides REC and highlights "open file"', !(await app.evaluate(() => !!document.querySelector('link[rel="manifest"]') || !!navigator.serviceWorker?.controller)) && (await app.isHidden('#btn-rec')) && (await app.getAttribute('#btn-open', 'class')).includes('accent'));
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
