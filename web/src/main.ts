// musictool prototype: sing (or open a recording) -> pitch -> notes -> edit -> MIDI.
import { buildFiles, packageFiles, safeName, saveWithLink, type ExportKind, type OutFile } from './app/files';
import { MicCapture, TakeRecorder } from './audio/capture';
import { INSTRUMENTS, Player, type Instrument } from './audio/player';
import { analyzePitch, HOP_SEC, LivePitch, type AnalyzeStats, type InputMode, type PitchFrame } from './dsp/pitch';
import { detectKey } from './music/keydetect';
import { centsOff, hzToMidi, isBlackKey, noteName, type MiddleC, type Notation } from './music/notes';
import { ALL_KEYS, keyFromId, keyId, keyShort, type Key } from './music/scale';
import { makeSample, SAMPLE_BPM } from './synth/voice';
import { arrange, type ArrangedNote } from './transcribe/arrange';
import { SEGMENT_PARAMS, transcribe, type RawNote, type Transcription } from './transcribe/segment';
import { estimateTempo } from './transcribe/tempo';
import { Knob } from './ui/knob';
import { PianoRoll, type RollNote, type RollView } from './ui/roll';

// ---------------------------------------------------------------- environment

interface DownloadsApi {
  save(req: { filename: string; data: Blob | ArrayBuffer | ArrayBufferView | string }): Promise<{ status: string }>;
}
interface ClaudeHost {
  use(name: string): Promise<unknown>;
}
const host = (window as unknown as { claude?: ClaudeHost }).claude;
const inArtifact = typeof host?.use === 'function';
const downloadsApi: Promise<DownloadsApi | null> = inArtifact
  ? host!.use('downloads').then((d) => (d as DownloadsApi | null) ?? null, () => null)
  : Promise.resolve(null);

function micAllowed(): boolean {
  if (!MicCapture.supported() || !window.isSecureContext) return false;
  const fp = (document as unknown as { featurePolicy?: { allowsFeature(f: string): boolean } }).featurePolicy;
  if (fp && typeof fp.allowsFeature === 'function') return fp.allowsFeature('microphone');
  return !inArtifact;
}

// ---------------------------------------------------------------- state

type Phase = 'idle' | 'count' | 'rec' | 'analyzing';
type Source = 'mic' | 'file' | 'sample';

interface Take {
  name: string;
  source: Source;
  audio: Float32Array;
  sampleRate: number;
  /** Seconds in `audio` where bar 1 starts. */
  zero: number;
  frames: PitchFrame[];
  trans: Transcription;
  stats: AnalyzeStats;
  buffer: AudioBuffer | null;
}

interface Snapshot {
  fixed: Record<string, number>;
  deleted: string[];
  snap: number;
  quant: number;
  grid: number;
  key: Key;
  keyAuto: boolean;
  bpm: number;
}

interface Prefs {
  notation: Notation;
  middleC: MiddleC;
  mode: InputMode;
  countIn: boolean;
  metronome: boolean;
  latencyMs: number;
  instrument: Instrument;
  balance: number;
}

const PREFS_KEY = 'musictool.prefs.v1';
const defaultPrefs: Prefs = {
  notation: 'letter',
  middleC: 4,
  mode: 'sing',
  countIn: true,
  metronome: true,
  latencyMs: 0,
  instrument: 'piano',
  balance: 0.5,
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...defaultPrefs, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* storage unavailable */
  }
  return { ...defaultPrefs };
}

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(P));
  } catch {
    /* storage unavailable */
  }
}

const P: Prefs = loadPrefs();

const S = {
  phase: 'idle' as Phase,
  take: null as Take | null,
  bpm: SAMPLE_BPM,
  beatsPerBar: 4,
  key: { tonic: 0, mode: 'major' } as Key,
  keyAuto: true,
  detected: [] as Key[],
  snap: 0.6,
  quant: 0.5,
  grid: 0.5,
  fixed: {} as Record<string, number>,
  deleted: new Set<string>(),
  selected: null as string | null,
  notes: [] as ArrangedNote[],
  cursorBeat: 0,
  playheadBeat: null as number | null,
  appearStart: 0,
  undo: [] as Snapshot[],
  undoTag: '',
  undoAt: 0,
  exportKind: 'both' as ExportKind,
  mic: micAllowed(),
};

let ctx: AudioContext | null = null;
let player: Player | null = null;
let mic: MicCapture | null = null;

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

function getPlayer(): Player {
  if (!player) player = new Player(audio());
  return player;
}

// ---------------------------------------------------------------- elements

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  title: $('title'),
  btnStart: $<HTMLButtonElement>('btn-start'),
  btnPlay: $<HTMLButtonElement>('btn-play'),
  btnRec: $<HTMLButtonElement>('btn-rec'),
  ctrPos: $('ctr-pos'),
  ctrTime: $('ctr-time'),
  bpm: $<HTMLInputElement>('bpm'),
  key: $<HTMLSelectElement>('key'),
  btnMetro: $<HTMLButtonElement>('btn-metro'),
  btnCount: $<HTMLButtonElement>('btn-count'),
  btnOpen: $<HTMLButtonElement>('btn-open'),
  file: $<HTMLInputElement>('file'),
  btnSettings: $<HTMLButtonElement>('btn-settings'),
  btnUndo: $<HTMLButtonElement>('btn-undo'),
  btnExport: $<HTMLButtonElement>('btn-export'),
  roll: $('roll'),
  count: $('count'),
  countNum: $('count-num'),
  busy: $('busy'),
  busyBar: $('busy-bar'),
  drop: $('drop'),
  empty: $('empty'),
  btnEmptyOpen: $<HTMLButtonElement>('btn-empty-open'),
  nowLabel: $('now-label'),
  recBadge: $('rec-badge'),
  nowNote: $('now-note'),
  nowSub: $('now-sub'),
  tuner: $('tuner'),
  needle: $('needle'),
  meter: $('meter'),
  meterBar: $('meter-bar'),
  nowInfo: $('now-info'),
  noteEdit: $('note-edit'),
  cands: $('cands'),
  btnListen: $<HTMLButtonElement>('btn-listen'),
  btnDelete: $<HTMLButtonElement>('btn-delete'),
  flags: $('flags'),
  flagCount: $('flag-count'),
  flagList: $('flag-list'),
  allOk: $('all-ok'),
  btnInst: $<HTMLButtonElement>('btn-inst'),
  instLabel: $('inst-label'),
  balance: $<HTMLInputElement>('balance'),
  backdrop: $('backdrop'),
  settings: $('settings'),
  latency: $<HTMLInputElement>('latency'),
  latencyVal: $('latency-val'),
  fieldLatency: $('field-latency'),
  btnSample: $<HTMLButtonElement>('btn-sample'),
  measure: $('measure'),
  exportSheet: $('export'),
  exportName: $<HTMLInputElement>('export-name'),
  exportNote: $('export-note'),
  btnDownload: $<HTMLButtonElement>('btn-download'),
  toast: $('toast'),
};

const roll = new PianoRoll(el.roll);

// ---------------------------------------------------------------- helpers

function label(midi: number): string {
  return noteName(midi, P.notation, P.middleC);
}

function barBeat(beat: number): string {
  const b = Math.max(0, beat);
  return `${Math.floor(b / S.beatsPerBar) + 1}.${Math.floor(b % S.beatsPerBar) + 1}`;
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let toastTimer = 0;
function toast(text: string, tone: '' | 'ok' | 'warn' = ''): void {
  el.toast.textContent = text;
  el.toast.className = `toast ${tone}`;
  el.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), 2400);
}

function stampName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `take-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function snapshot(): Snapshot {
  return {
    fixed: { ...S.fixed },
    deleted: [...S.deleted],
    snap: S.snap,
    quant: S.quant,
    grid: S.grid,
    key: { ...S.key },
    keyAuto: S.keyAuto,
    bpm: S.bpm,
  };
}

/** Record an undo step. Rapid changes from the same control collapse into one step. */
function pushUndo(tag: string): void {
  const now = performance.now();
  if (tag && tag === S.undoTag && now - S.undoAt < 1200) {
    S.undoAt = now;
    return;
  }
  S.undo.push(snapshot());
  if (S.undo.length > 100) S.undo.shift();
  S.undoTag = tag;
  S.undoAt = now;
  el.btnUndo.disabled = false;
}

function undo(): void {
  const s = S.undo.pop();
  if (!s) return;
  S.fixed = s.fixed;
  S.deleted = new Set(s.deleted);
  S.snap = s.snap;
  S.quant = s.quant;
  S.grid = s.grid;
  S.key = s.key;
  S.keyAuto = s.keyAuto;
  S.bpm = s.bpm;
  S.undoTag = '';
  knobSnap.set(S.snap);
  knobQuant.set(S.quant);
  el.btnUndo.disabled = S.undo.length === 0;
  refresh();
}

// ---------------------------------------------------------------- arrangement

function shiftedNotes(t: Take): RawNote[] {
  return t.trans.notes
    .filter((n) => n.end > t.zero + 0.02)
    .map((n) => ({ ...n, start: Math.max(0, n.start - t.zero), end: n.end - t.zero }));
}

function arranged(): ArrangedNote[] {
  const t = S.take;
  if (!t) return [];
  return arrange(shiftedNotes(t), {
    bpm: S.bpm,
    key: S.key,
    snap: S.snap,
    quant: S.quant,
    grid: S.grid,
    fixed: S.fixed,
    deleted: S.deleted,
  });
}

function detectKeys(notes: RawNote[]): Key[] {
  if (notes.length < 4) return [];
  return detectKey(notes.map((n) => ({ pitch: Math.round(n.pitch), duration: n.end - n.start }))).map((g) => g.key);
}

// ---------------------------------------------------------------- loading takes

interface TakeInput {
  name: string;
  source: Source;
  audio: Float32Array;
  sampleRate: number;
  zero?: number;
  bpm?: number;
  /** false = guess the tempo and put the first note on bar 1 (recordings made without a click). */
  keepTempo: boolean;
}

async function loadTake(input: TakeInput): Promise<void> {
  stopPlayback();
  S.phase = 'analyzing';
  el.busy.hidden = false;
  el.empty.hidden = true;
  el.busyBar.style.width = '0%';
  renderTransport();
  try {
    const mode = P.mode;
    const { frames, stats } = await analyzePitch(input.audio, input.sampleRate, mode, (p) => {
      el.busyBar.style.width = `${Math.round(p * 100)}%`;
    });
    const trans = transcribe(frames, SEGMENT_PARAMS[mode]);
    let zero = input.zero ?? 0;
    let bpm = input.bpm ?? S.bpm;
    if (!input.keepTempo) {
      const guess = estimateTempo(trans.notes.map((n) => n.start));
      if (guess) {
        bpm = guess.bpm;
        zero = guess.zero;
      } else if (trans.notes.length) {
        zero = trans.notes[0].start;
      }
    }
    S.take = { ...input, zero, frames, trans, stats, buffer: null };
    S.bpm = Math.max(40, Math.min(240, bpm));
    S.fixed = {};
    S.deleted = new Set();
    S.selected = null;
    S.undo = [];
    S.undoTag = '';
    el.btnUndo.disabled = true;
    S.detected = detectKeys(shiftedNotes(S.take));
    if (S.keyAuto && S.detected.length) S.key = S.detected[0];
    S.cursorBeat = 0;
    S.playheadBeat = null;
    S.appearStart = performance.now() + 120;
    roll.scrollToStart();
    if (!trans.notes.length) toast('声が見つかりませんでした', 'warn');
  } finally {
    S.phase = 'idle';
    el.busy.hidden = true;
  }
  refresh();
  loop();
}

async function loadSample(): Promise<void> {
  const sr = 48000;
  await loadTake({ name: 'サンプル', source: 'sample', audio: makeSample(sr), sampleRate: sr, zero: 0, bpm: SAMPLE_BPM, keepTempo: true });
}

const MAX_SECONDS = 6 * 60;

async function loadFile(file: File): Promise<void> {
  if (S.phase !== 'idle') return;
  let decoded: AudioBuffer;
  try {
    decoded = await audio().decodeAudioData(await file.arrayBuffer());
  } catch {
    toast('この音声は読み込めませんでした', 'warn');
    return;
  }
  if (decoded.duration > MAX_SECONDS) {
    toast('6 分までの音声に対応しています', 'warn');
    return;
  }
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / decoded.numberOfChannels;
  }
  const name = file.name.replace(/\.[^.]+$/, '') || 'voice';
  await loadTake({ name, source: 'file', audio: mono, sampleRate: decoded.sampleRate, keepTempo: false });
}

// ---------------------------------------------------------------- recording

interface Rec {
  recorder: TakeRecorder;
  live: LivePitch;
  frames: PitchFrame[];
  t0: number;
  zeroTime: number;
  latency: number;
  spb: number;
  countBeats: number;
  nextBeat: number;
  shownCount: number;
  lastTranscribe: number;
  notes: ArrangedNote[];
  curveBeats: number[];
  curvePitch: number[];
  pitch: number | null;
  pitchAt: number;
  range: [number, number];
  prevTake: Take | null;
}

let rec: Rec | null = null;

async function startRecording(): Promise<void> {
  if (S.phase !== 'idle' || !S.mic) return;
  stopPlayback();
  const ac = audio();
  await ac.resume();
  if (!mic) {
    try {
      mic = await MicCapture.open(ac);
    } catch {
      S.mic = false;
      renderTransport();
      toast('マイクが使えません。音声ファイルを開いてください', 'warn');
      return;
    }
  }
  getPlayer();
  const spb = 60 / S.bpm;
  const t0 = ac.currentTime + 0.15;
  const countBeats = P.countIn ? S.beatsPerBar : 0;
  const outLatency = (ac as AudioContext & { outputLatency?: number }).outputLatency ?? ac.baseLatency ?? 0;
  const latency = outLatency + mic.inputLatency + P.latencyMs / 1000;
  const r: Rec = {
    recorder: new TakeRecorder(),
    live: new LivePitch(mic.sampleRate, P.mode),
    frames: [],
    t0,
    zeroTime: t0 + countBeats * spb,
    latency,
    spb,
    countBeats,
    nextBeat: 0,
    shownCount: -1,
    lastTranscribe: 0,
    notes: [],
    curveBeats: [],
    curvePitch: [],
    pitch: null,
    pitchAt: 0,
    range: [55, 76],
    prevTake: S.take,
  };
  rec = r;
  const sr = mic.sampleRate;
  mic.listen((data, frame) => {
    r.recorder.push(data, frame);
    const start = r.recorder.firstFrame / sr;
    for (const f of r.live.push(data)) {
      r.frames.push(f);
      const songT = start + f.t - r.zeroTime - r.latency;
      const voiced = f.f0 > 0 && f.conf > 0.6 && f.rms > 0.004;
      if (voiced) {
        r.pitch = hzToMidi(f.f0);
        r.pitchAt = songT;
      } else if (songT - r.pitchAt > 0.15) {
        r.pitch = null;
      }
      if (songT < -0.2) continue;
      const pitch = voiced ? hzToMidi(f.f0) : NaN;
      r.curveBeats.push(songT / r.spb);
      r.curvePitch.push(pitch);
      if (voiced) {
        r.range = [Math.min(r.range[0], Math.floor(pitch) - 2), Math.max(r.range[1], Math.ceil(pitch) + 2)];
      }
    }
  });
  S.selected = null;
  S.phase = countBeats ? 'count' : 'rec';
  S.playheadBeat = 0;
  roll.scrollToStart();
  renderTransport();
  renderInspector();
  loop();
}

function updateRecording(r: Rec): void {
  const ac = audio();
  const now = ac.currentTime;
  const p = getPlayer();
  while (r.t0 + r.nextBeat * r.spb < now + 0.25) {
    const k = r.nextBeat;
    if (k < r.countBeats || P.metronome) p.click(r.t0 + k * r.spb, k % S.beatsPerBar === 0);
    r.nextBeat++;
  }
  if (S.phase === 'count') {
    if (now >= r.zeroTime) {
      S.phase = 'rec';
      el.count.hidden = true;
      renderTransport();
    } else {
      const remaining = r.countBeats - Math.max(0, Math.floor((now - r.t0) / r.spb));
      if (remaining !== r.shownCount && now >= r.t0) {
        r.shownCount = remaining;
        el.count.hidden = false;
        el.countNum.textContent = String(remaining);
        el.countNum.classList.remove('beat');
        void el.countNum.offsetWidth;
        el.countNum.classList.add('beat');
      }
    }
  }
  if (S.phase === 'rec') {
    S.playheadBeat = Math.max(0, (now - r.zeroTime) / r.spb);
    const wall = performance.now();
    if (wall - r.lastTranscribe > 300 && r.frames.length > 10) {
      r.lastTranscribe = wall;
      const t = transcribe(r.frames, SEGMENT_PARAMS[P.mode]);
      const start = r.recorder.firstFrame / (mic?.sampleRate ?? 48000);
      const offset = start - r.zeroTime - r.latency;
      const shifted = t.notes
        .map((n) => ({ ...n, start: n.start + offset, end: n.end + offset }))
        .filter((n) => n.end > 0)
        .map((n) => ({ ...n, start: Math.max(0, n.start) }));
      r.notes = arrange(shifted, { bpm: S.bpm, key: S.key, snap: S.snap, quant: 0, grid: S.grid, fixed: {}, deleted: [] });
    }
  }
}

async function stopRecording(): Promise<void> {
  const r = rec;
  if (!r || !mic) return;
  rec = null;
  mic.listen(null);
  el.count.hidden = true;
  const wasCounting = S.phase === 'count';
  S.phase = 'idle';
  S.playheadBeat = null;
  if (wasCounting) {
    renderTransport();
    refresh();
    return;
  }
  const sr = mic.sampleRate;
  const data = r.recorder.merge();
  const zero = Math.max(0, r.zeroTime + r.latency - r.recorder.firstFrame / sr);
  if (data.length / sr - zero < 0.4) {
    toast('短すぎます', 'warn');
    renderTransport();
    refresh();
    return;
  }
  await loadTake({ name: stampName(), source: 'mic', audio: data, sampleRate: sr, zero, bpm: S.bpm, keepTempo: true });
}

// ---------------------------------------------------------------- playback

function playNotesSec() {
  const spb = 60 / S.bpm;
  return S.notes.map((n) => ({ pitch: n.pitch, start: n.startBeat * spb, dur: (n.endBeat - n.startBeat) * spb, velocity: n.velocity }));
}

function voiceBuffer(t: Take): AudioBuffer {
  if (!t.buffer) {
    t.buffer = new AudioBuffer({ length: Math.max(1, t.audio.length), sampleRate: t.sampleRate, numberOfChannels: 1 });
    t.buffer.copyToChannel(t.audio as Float32Array<ArrayBuffer>, 0);
  }
  return t.buffer;
}

function play(): void {
  const t = S.take;
  if (!t || S.phase !== 'idle') return;
  const ac = audio();
  void ac.resume();
  const spb = 60 / S.bpm;
  getPlayer().play({
    notes: playNotesSec(),
    voice: voiceBuffer(t),
    voiceZero: t.zero,
    from: S.cursorBeat * spb,
    balance: P.balance,
    instrument: P.instrument,
    onEnd: () => {
      S.playheadBeat = null;
      renderTransport();
      renderNow();
      drawRoll();
    },
  });
  renderTransport();
  loop();
}

function stopPlayback(): void {
  if (player?.playing) {
    player.stop();
    S.playheadBeat = null;
    renderTransport();
  }
}

function togglePlay(): void {
  if (S.phase === 'count' || S.phase === 'rec') {
    void stopRecording();
    return;
  }
  if (player?.playing) {
    stopPlayback();
    renderNow();
    drawRoll();
  } else play();
}

function toggleRec(): void {
  if (S.phase === 'count' || S.phase === 'rec') void stopRecording();
  else if (S.phase === 'idle') void startRecording();
}

function listenSelected(): void {
  const t = S.take;
  const n = S.notes.find((x) => x.id === S.selected);
  if (!t || !n) return;
  const ac = audio();
  void ac.resume();
  stopPlayback();
  getPlayer().play({
    notes: [],
    voice: voiceBuffer(t),
    voiceZero: t.zero,
    from: Math.max(0, n.raw.start - t.zero - 0.04),
    to: n.raw.end - t.zero + 0.04,
    balance: 0,
    instrument: P.instrument,
  });
}

function preview(pitch: number): void {
  const ac = audio();
  void ac.resume();
  getPlayer().preview(pitch, P.instrument);
}

// ---------------------------------------------------------------- render

function refresh(): void {
  S.notes = arranged();
  if (S.selected && !S.notes.some((n) => n.id === S.selected)) S.selected = null;
  renderTransport();
  renderInspector();
  drawRoll();
}

function renderTransport(): void {
  const recording = S.phase === 'rec' || S.phase === 'count';
  el.title.textContent = recording ? 'REC' : (S.take?.name ?? '');
  el.btnRec.hidden = !S.mic;
  el.btnRec.classList.toggle('on', S.phase === 'rec');
  el.btnRec.classList.toggle('count', S.phase === 'count');
  el.btnRec.setAttribute('aria-label', recording ? '停止' : '録音をはじめる');
  el.btnRec.title = recording ? '停止（R）' : '録音（R）';
  el.btnMetro.hidden = !S.mic;
  el.btnCount.hidden = !S.mic;
  el.fieldLatency.hidden = !S.mic;
  el.btnOpen.classList.toggle('accent', !S.mic);
  const playing = !!player?.playing;
  el.btnPlay.classList.toggle('on', playing || recording);
  el.btnPlay.setAttribute('aria-label', playing || recording ? '停止' : '再生');
  el.btnPlay.disabled = S.phase === 'analyzing' || (!S.take && !recording);
  el.btnExport.disabled = !S.take || S.phase !== 'idle';
  el.btnOpen.disabled = S.phase !== 'idle';
  el.btnMetro.setAttribute('aria-pressed', String(P.metronome));
  el.btnCount.setAttribute('aria-pressed', String(P.countIn));
  el.bpm.value = String(Math.round(S.bpm));
  el.bpm.disabled = recording;
  renderKeySelect();
  updateCounter();
}

function renderKeySelect(): void {
  const auto = S.detected[0];
  const opts: string[] = [];
  opts.push(`<option value="auto">${auto ? `AUTO · ${keyShort(auto)}` : 'AUTO'}</option>`);
  for (const k of ALL_KEYS) opts.push(`<option value="${keyId(k)}">${keyShort(k)}</option>`);
  const html = opts.join('');
  if (el.key.dataset.html !== html) {
    el.key.innerHTML = html;
    el.key.dataset.html = html;
  }
  el.key.value = S.keyAuto ? 'auto' : keyId(S.key);
  el.key.disabled = S.phase !== 'idle';
}

function updateCounter(): void {
  const beat = S.playheadBeat ?? S.cursorBeat;
  el.ctrPos.textContent = barBeat(beat);
  el.ctrTime.textContent = clock((beat * 60) / S.bpm);
  el.ctrPos.parentElement!.classList.toggle('rec', S.phase === 'rec');
}

function renderNow(): void {
  el.recBadge.hidden = S.phase !== 'rec';
  el.tuner.hidden = S.phase !== 'rec';
  el.meter.hidden = !(S.phase === 'rec' || S.phase === 'count');
  const big = el.nowNote;
  big.className = 'big';
  if (S.phase === 'rec' || S.phase === 'count') {
    const r = rec;
    el.nowLabel.textContent = S.phase === 'count' ? 'READY' : 'NOW';
    if (r?.pitch != null && S.phase === 'rec') {
      big.textContent = label(r.pitch);
      big.classList.add('voice');
      const c = centsOff(r.pitch);
      el.nowSub.textContent = `${c > 0 ? '+' : ''}${c}¢`;
      el.needle.style.left = `${50 + c}%`;
    } else {
      big.textContent = '–';
      el.nowSub.textContent = '';
      el.needle.style.left = '50%';
    }
    el.nowInfo.textContent = '';
    el.meterBar.style.width = `${Math.min(100, Math.round(Math.sqrt(mic?.level ?? 0) * 220))}%`;
    return;
  }
  const sel = S.notes.find((n) => n.id === S.selected);
  if (sel) {
    el.nowLabel.textContent = 'NOTE';
    big.textContent = label(sel.pitch);
    big.classList.add(sel.flagged ? 'warn' : 'note');
    el.nowSub.textContent = barBeat(sel.startBeat);
    const raw = sel.raw.pitch;
    const c = centsOff(raw);
    el.nowInfo.textContent = `${label(Math.round(raw))} ${c > 0 ? '+' : ''}${c}¢`;
    return;
  }
  if (S.playheadBeat !== null) {
    el.nowLabel.textContent = 'NOW';
    const ph = S.playheadBeat;
    const cur = S.notes.find((n) => n.startBeat <= ph && ph < n.endBeat);
    big.textContent = cur ? label(cur.pitch) : '–';
    if (cur) big.classList.add('note');
    el.nowSub.textContent = '';
    el.nowInfo.textContent = '';
    return;
  }
  el.nowLabel.textContent = 'KEY';
  if (S.key.mode === 'chromatic') {
    big.textContent = 'Chr';
    el.nowSub.textContent = '';
  } else {
    big.textContent = keyShort({ tonic: S.key.tonic, mode: 'major' });
    el.nowSub.textContent = S.key.mode === 'major' ? 'Major' : 'Minor';
  }
  const t = S.take;
  el.nowInfo.textContent = t ? `${S.notes.length} notes · ♩${Math.round(S.bpm)}` : '';
}

function renderInspector(): void {
  renderNow();
  const idle = S.phase === 'idle';
  // Selected note: candidate keys.
  const sel = idle ? S.notes.find((n) => n.id === S.selected) : undefined;
  el.noteEdit.hidden = !sel;
  if (sel) {
    const center = Math.round(sel.raw.pitch);
    const auto = arrange([sel.raw], { bpm: S.bpm, key: S.key, snap: S.snap, quant: 0, grid: S.grid, fixed: {}, deleted: [] })[0]?.pitch;
    el.cands.innerHTML = '';
    for (const p of [center - 1, center, center + 1]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cand ${isBlackKey(p) ? 'black' : 'white'}${p === sel.pitch ? ' current' : ''}`;
      b.setAttribute('aria-label', `${label(p)} にする`);
      b.setAttribute('aria-pressed', String(p === sel.pitch));
      b.innerHTML = `${p === auto ? '<span class="rec-dot" aria-hidden="true"></span>' : ''}<span>${label(p)}</span>`;
      b.addEventListener('click', () => setPitch(sel.id, p));
      el.cands.appendChild(b);
    }
  }
  // Notes to check.
  const flagged = S.notes.filter((n) => n.flagged);
  el.flags.hidden = !idle || flagged.length === 0;
  el.allOk.hidden = !idle || flagged.length > 0 || S.notes.length === 0;
  el.flagCount.textContent = String(flagged.length);
  el.flagList.innerHTML = '';
  for (const n of flagged) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `flag-row${n.id === S.selected ? ' sel' : ''}`;
    b.innerHTML = `<span class="pos">${barBeat(n.startBeat)}</span><span class="lab">${label(n.pitch)}</span><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>`;
    b.addEventListener('click', () => select(n.id, true));
    el.flagList.appendChild(b);
  }
  el.instLabel.textContent = INSTRUMENTS.find((i) => i.id === P.instrument)?.label ?? 'PIANO';
  el.balance.value = String(Math.round(P.balance * 100));
  gridChip.textContent = gridLabel(S.grid);
  el.empty.hidden = !!S.take || S.phase !== 'idle';
  renderMeasure();
}

function appearAlpha(index: number): number {
  const t = performance.now() - S.appearStart - index * 50;
  return Math.max(0, Math.min(1, t / 220));
}

function animating(): boolean {
  return performance.now() - S.appearStart < S.notes.length * 50 + 260;
}

function drawRoll(): void {
  const bps = S.bpm / 60;
  const t = S.take;
  const r = rec;
  let notes: RollNote[];
  let curve: RollView['curve'] = null;
  let envelope: RollView['envelope'] = null;
  let total = 16;
  let lit: RollView['lit'] = null;
  let range: [number, number] | null = null;

  if (r && (S.phase === 'rec' || S.phase === 'count')) {
    notes = r.notes.map((n) => ({ id: n.id, pitch: n.pitch, startBeat: n.startBeat, endBeat: n.endBeat, flagged: false, label: label(n.pitch) }));
    curve = { beats: Float32Array.from(r.curveBeats), pitch: Float32Array.from(r.curvePitch) };
    if (r.frames.length) {
      const start = r.recorder.firstFrame / (mic?.sampleRate ?? 48000) - r.zeroTime - r.latency;
      const peaks = new Float32Array(r.frames.length);
      for (let i = 0; i < peaks.length; i++) peaks[i] = Math.min(1, Math.sqrt(Math.max(0, r.frames[i].rms * 6 - 0.01)));
      envelope = { start: (start + r.frames[0].t - HOP_SEC / 2) * bps, step: HOP_SEC * bps, peaks };
    }
    total = Math.max(16, Math.ceil(((S.playheadBeat ?? 0) + 6) / S.beatsPerBar) * S.beatsPerBar);
    if (r.pitch != null && S.phase === 'rec') lit = { pitch: r.pitch, kind: 'voice' };
    range = r.range;
  } else {
    const animate = animating();
    notes = S.notes.map((n, i) => ({
      id: n.id,
      pitch: n.pitch,
      startBeat: n.startBeat,
      endBeat: n.endBeat,
      flagged: n.flagged,
      label: label(n.pitch),
      alpha: animate ? appearAlpha(i) : 1,
    }));
    if (t) {
      const beats = new Float32Array(t.trans.frameTimes.length);
      for (let i = 0; i < beats.length; i++) beats[i] = (t.trans.frameTimes[i] - t.zero) * bps;
      curve = { beats, pitch: t.trans.curve };
      let maxRms = 1e-9;
      for (const f of t.frames) maxRms = Math.max(maxRms, f.rms);
      const peaks = new Float32Array(t.frames.length);
      for (let i = 0; i < peaks.length; i++) peaks[i] = Math.sqrt(Math.max(0, t.frames[i].rms / maxRms - 0.03));
      envelope = { start: ((t.frames[0]?.t ?? 0) - t.zero - HOP_SEC / 2) * bps, step: HOP_SEC * bps, peaks };
      const endBeat = Math.max((t.audio.length / t.sampleRate - t.zero) * bps, ...S.notes.map((n) => n.endBeat));
      total = Math.max(16, Math.ceil((endBeat + 1) / S.beatsPerBar) * S.beatsPerBar);
    }
    if (S.playheadBeat !== null) {
      const ph = S.playheadBeat;
      const cur = S.notes.find((n) => n.startBeat <= ph && ph < n.endBeat);
      if (cur) lit = { pitch: cur.pitch, kind: 'note' };
    } else if (S.selected) {
      const sel = S.notes.find((n) => n.id === S.selected);
      if (sel) lit = { pitch: sel.pitch, kind: 'note' };
    }
  }

  roll.setView({
    notes,
    curve,
    envelope,
    totalBeats: total,
    beatsPerBar: S.beatsPerBar,
    grid: S.grid,
    playhead: S.playheadBeat ?? (S.take ? S.cursorBeat : null),
    selectedId: S.selected,
    lit,
    keyLabel: (m) => label(m),
    range,
  });
}

// ---------------------------------------------------------------- frame loop

let raf = 0;
function loop(): void {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(): void {
  raf = 0;
  let again = false;
  if (rec && (S.phase === 'count' || S.phase === 'rec')) {
    updateRecording(rec);
    renderNow();
    again = true;
  }
  if (player?.playing) {
    const pos = player.position;
    if (pos !== null) S.playheadBeat = (pos * S.bpm) / 60;
    renderNow();
    again = true;
  }
  if (S.playheadBeat !== null) roll.follow(S.playheadBeat);
  if (animating()) again = true;
  drawRoll();
  updateCounter();
  if (again) loop();
}

// ---------------------------------------------------------------- editing

function select(id: string | null, reveal = false): void {
  S.selected = id;
  const n = S.notes.find((x) => x.id === id);
  if (n) {
    preview(n.pitch);
    if (reveal) roll.follow(n.startBeat);
  }
  renderInspector();
  drawRoll();
}

function setPitch(id: string, pitch: number): void {
  pushUndo('');
  S.fixed[id] = Math.max(0, Math.min(127, pitch));
  preview(pitch);
  refresh();
}

function deleteSelected(): void {
  if (!S.selected) return;
  pushUndo('');
  S.deleted.add(S.selected);
  S.selected = null;
  refresh();
}

const GRIDS = [1, 0.5, 0.25];
function gridLabel(g: number): string {
  return `1/${Math.round(4 / g)}`;
}

const knobSnap = new Knob($('knob-snap'), S.snap, (v) => {
  pushUndo('snap');
  S.snap = v;
  refresh();
});
const knobQuant = new Knob($('knob-quant'), S.quant, (v) => {
  pushUndo('quant');
  S.quant = v;
  refresh();
});
const gridChip = document.createElement('button');
gridChip.type = 'button';
gridChip.className = 'grid-size';
gridChip.title = 'グリッド';
gridChip.setAttribute('aria-label', 'グリッドの細かさ');
$('knob-quant').appendChild(gridChip);
gridChip.addEventListener('click', () => {
  pushUndo('');
  S.grid = GRIDS[(GRIDS.indexOf(S.grid) + 1) % GRIDS.length];
  refresh();
});

// ---------------------------------------------------------------- sheets

let openSheet: HTMLElement | null = null;
let sheetReturn: HTMLElement | null = null;

function showSheet(sheet: HTMLElement): void {
  if (openSheet) closeSheet();
  sheetReturn = document.activeElement as HTMLElement | null;
  openSheet = sheet;
  el.backdrop.hidden = false;
  sheet.hidden = false;
  (sheet.querySelector('button.close') as HTMLButtonElement | null)?.focus();
}

function closeSheet(): void {
  if (!openSheet) return;
  openSheet.hidden = true;
  el.backdrop.hidden = true;
  openSheet = null;
  sheetReturn?.focus();
}

function renderSettings(): void {
  for (const seg of el.settings.querySelectorAll<HTMLElement>('.seg')) {
    const key = seg.dataset.setting as 'notation' | 'middleC' | 'mode';
    for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
      b.setAttribute('aria-pressed', String(String(P[key]) === b.dataset.v));
    }
  }
  el.latency.value = String(P.latencyMs);
  el.latencyVal.textContent = `${P.latencyMs > 0 ? '+' : ''}${P.latencyMs} ms`;
  renderMeasure();
}

function renderMeasure(): void {
  if (el.settings.hidden) return;
  const t = S.take;
  const rows: [string, string][] = [];
  if (t) {
    const msPerFrame = t.stats.millisPerFrame;
    rows.push(['解析', `${msPerFrame.toFixed(2)} ms / 16 ms 枠`]);
    rows.push(['速さ', `×${Math.round((HOP_SEC * 1000) / Math.max(0.001, msPerFrame))} 実時間`]);
    rows.push(['有声', `${Math.round(t.trans.voicedRatio * 100)} %`]);
    rows.push(['チューニング', `${t.trans.tuningCents > 0 ? '+' : ''}${t.trans.tuningCents} ¢`]);
    rows.push(['ノート', `${S.notes.length}（確認 ${S.notes.filter((n) => n.flagged).length}）`]);
    rows.push(['音声', `${(t.sampleRate / 1000).toFixed(1)} kHz · ${(t.audio.length / t.sampleRate).toFixed(1)} s`]);
  }
  if (mic) {
    const ac = audio();
    const out = (ac as AudioContext & { outputLatency?: number }).outputLatency ?? ac.baseLatency ?? 0;
    rows.push(['入力', `${mic.kind === 'worklet' ? 'Worklet' : 'ScriptProcessor'}`]);
    rows.push(['遅れ', `${Math.round((out + mic.inputLatency) * 1000 + P.latencyMs)} ms`]);
  }
  el.measure.innerHTML = `<dl style="display:contents">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  el.measure.hidden = rows.length === 0;
}

function renderExport(): void {
  for (const tile of el.exportSheet.querySelectorAll<HTMLButtonElement>('.tile')) {
    tile.setAttribute('aria-checked', String(tile.dataset.kind === S.exportKind));
  }
  for (const small of el.exportSheet.querySelectorAll<HTMLElement>('small[data-ext]')) {
    const kind = small.dataset.ext;
    small.textContent = inArtifact ? '.zip' : kind === 'both' ? '.zip' : kind === 'midi' ? '.mid' : '.wav';
  }
  el.exportNote.hidden = !inArtifact;
  el.exportNote.textContent = inArtifact ? 'ZIP にまとめて保存。展開して DAW へ' : '';
}

async function doExport(): Promise<void> {
  const t = S.take;
  if (!t) return;
  if (S.exportKind !== 'wav' && S.notes.length === 0) {
    toast('ノートがありません', 'warn');
    return;
  }
  const name = safeName(el.exportName.value || t.name);
  const startSample = Math.min(t.audio.length, Math.round(t.zero * t.sampleRate));
  const files = buildFiles(S.exportKind, {
    name,
    bpm: S.bpm,
    key: S.key,
    program: INSTRUMENTS.find((i) => i.id === P.instrument)?.program ?? 0,
    notes: S.notes,
    voice: t.audio.subarray(startSample),
    sampleRate: t.sampleRate,
  });
  const out = packageFiles(files, name, inArtifact);
  lastExport = { filename: out.name, files: files.map((f) => ({ name: f.name, size: f.data.length })), data: out.data };
  if (!inArtifact) {
    saveWithLink(out);
    closeSheet();
    toast(`${out.name} を書き出しました`, 'ok');
    return;
  }
  const dl = await downloadsApi;
  if (!dl) {
    toast('この画面では保存できません', 'warn');
    return;
  }
  try {
    const res = await dl.save({ filename: out.name, data: new Blob([out.data as BlobPart]) });
    closeSheet();
    if (res.status === 'saved') toast(`${out.name} を保存しました`, 'ok');
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'declined') return;
    if (code === 'rate_limited') toast('少し待ってからもう一度どうぞ', 'warn');
    else if (code === 'extension_not_enabled' || code === 'rejected_extension') toast('この画面では ZIP を保存できません', 'warn');
    else toast('保存できませんでした', 'warn');
  }
}

let lastExport: { filename: string; files: { name: string; size: number }[]; data: Uint8Array } | null = null;

// ---------------------------------------------------------------- events

el.btnPlay.addEventListener('click', togglePlay);
el.btnRec.addEventListener('click', toggleRec);
el.btnStart.addEventListener('click', () => {
  const wasPlaying = !!player?.playing;
  stopPlayback();
  S.cursorBeat = 0;
  roll.scrollToStart();
  if (wasPlaying) play();
  else {
    updateCounter();
    drawRoll();
  }
});
el.btnMetro.addEventListener('click', () => {
  P.metronome = !P.metronome;
  savePrefs();
  renderTransport();
});
el.btnCount.addEventListener('click', () => {
  P.countIn = !P.countIn;
  savePrefs();
  renderTransport();
});
el.bpm.addEventListener('change', () => {
  const v = Math.round(Number(el.bpm.value));
  if (!Number.isFinite(v) || v < 40 || v > 240) {
    el.bpm.value = String(Math.round(S.bpm));
    return;
  }
  pushUndo('');
  S.bpm = v;
  refresh();
});
el.key.addEventListener('change', () => {
  pushUndo('');
  if (el.key.value === 'auto') {
    S.keyAuto = true;
    if (S.detected[0]) S.key = S.detected[0];
  } else {
    S.keyAuto = false;
    S.key = keyFromId(el.key.value);
  }
  refresh();
});
el.btnOpen.addEventListener('click', () => el.file.click());
el.btnEmptyOpen.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => {
  const f = el.file.files?.[0];
  el.file.value = '';
  if (f) void loadFile(f);
});
el.btnSettings.addEventListener('click', () => {
  renderSettings();
  showSheet(el.settings);
  renderMeasure();
});
el.btnUndo.addEventListener('click', undo);
el.btnExport.addEventListener('click', openExport);
function openExport(): void {
  if (!S.take || S.phase !== 'idle') return;
  stopPlayback();
  el.exportName.value = S.take.name === 'サンプル' ? 'musictool-sample' : S.take.name;
  renderExport();
  showSheet(el.exportSheet);
}
el.btnDownload.addEventListener('click', () => void doExport());
for (const tile of el.exportSheet.querySelectorAll<HTMLButtonElement>('.tile')) {
  tile.addEventListener('click', () => {
    S.exportKind = tile.dataset.kind as ExportKind;
    renderExport();
  });
}
el.backdrop.addEventListener('click', closeSheet);
for (const b of document.querySelectorAll<HTMLButtonElement>('.sheet button.close')) b.addEventListener('click', closeSheet);
for (const seg of el.settings.querySelectorAll<HTMLElement>('.seg')) {
  seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const key = seg.dataset.setting;
    const v = b.dataset.v ?? '';
    if (key === 'notation') P.notation = v as Notation;
    if (key === 'middleC') P.middleC = Number(v) as MiddleC;
    if (key === 'mode') {
      const changed = P.mode !== v;
      P.mode = v as InputMode;
      if (changed && S.take && S.phase === 'idle') {
        const t = S.take;
        savePrefs();
        renderSettings();
        void loadTake({ name: t.name, source: t.source, audio: t.audio, sampleRate: t.sampleRate, zero: t.zero, bpm: S.bpm, keepTempo: true });
        return;
      }
    }
    savePrefs();
    renderSettings();
    refresh();
  });
}
el.latency.addEventListener('input', () => {
  P.latencyMs = Number(el.latency.value);
  savePrefs();
  renderSettings();
});
el.btnSample.addEventListener('click', () => {
  closeSheet();
  void loadSample();
});
el.btnInst.addEventListener('click', () => {
  const i = INSTRUMENTS.findIndex((x) => x.id === P.instrument);
  P.instrument = INSTRUMENTS[(i + 1) % INSTRUMENTS.length].id;
  savePrefs();
  renderInspector();
  preview(S.notes.find((n) => n.id === S.selected)?.pitch ?? 60);
});
el.balance.addEventListener('input', () => {
  P.balance = Number(el.balance.value) / 100;
  savePrefs();
});
el.btnListen.addEventListener('click', listenSelected);
el.btnDelete.addEventListener('click', deleteSelected);

roll.onPick = (id, beat) => {
  if (S.phase !== 'idle') return;
  if (id) {
    select(id);
    return;
  }
  S.selected = null;
  const wasPlaying = !!player?.playing;
  stopPlayback();
  S.cursorBeat = Math.max(0, Math.round(beat / S.grid) * S.grid);
  if (wasPlaying) play();
  renderInspector();
  updateCounter();
  drawRoll();
};

// Drag and drop audio files onto the editor.
let dragDepth = 0;
el.roll.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  el.drop.hidden = false;
});
el.roll.addEventListener('dragover', (e) => e.preventDefault());
el.roll.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.drop.hidden = true;
});
el.roll.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.drop.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadFile(f);
});

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const typing = target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range';
  if (e.key === 'Escape') {
    if (openSheet) closeSheet();
    else if (S.selected) select(null);
    return;
  }
  if (openSheet) {
    if (e.key === 'Tab') trapFocus(e, openSheet);
    return;
  }
  if (typing || target.tagName === 'SELECT') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  } else if (mod && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    openExport();
  } else if (mod) {
    return;
  } else if (e.key === ' ') {
    if (target.tagName === 'BUTTON') return;
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'r' || e.key === 'R') {
    toggleRec();
  } else if (e.key === 'Home') {
    el.btnStart.click();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected) {
    e.preventDefault();
    deleteSelected();
  } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && S.selected && target.tagName !== 'INPUT') {
    e.preventDefault();
    const n = S.notes.find((x) => x.id === S.selected);
    if (n) setPitch(n.id, n.pitch + (e.key === 'ArrowUp' ? 1 : -1));
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && S.selected && target.tagName !== 'INPUT') {
    e.preventDefault();
    const i = S.notes.findIndex((x) => x.id === S.selected);
    const next = S.notes[i + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) select(next.id, true);
  }
});

function trapFocus(e: KeyboardEvent, root: HTMLElement): void {
  const items = [...root.querySelectorAll<HTMLElement>('button, input, select')].filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ---------------------------------------------------------------- debug hook (used by the E2E test)

(window as unknown as { __mt: unknown }).__mt = {
  get phase() {
    return S.phase;
  },
  get mic() {
    return S.mic;
  },
  get inArtifact() {
    return inArtifact;
  },
  notes: () =>
    S.notes.map((n) => ({ id: n.id, name: noteName(n.pitch), pitch: n.pitch, startBeat: n.startBeat, endBeat: n.endBeat, flagged: n.flagged })),
  take: () =>
    S.take && {
      name: S.take.name,
      source: S.take.source,
      sampleRate: S.take.sampleRate,
      seconds: S.take.audio.length / S.take.sampleRate,
      zero: S.take.zero,
      tuningCents: S.take.trans.tuningCents,
      millisPerFrame: S.take.stats.millisPerFrame,
    },
  get bpm() {
    return S.bpm;
  },
  get key() {
    return keyShort(S.key);
  },
  liveFrames: () => rec?.frames.length ?? 0,
  lastExport: () => lastExport && { filename: lastExport.filename, files: lastExport.files },
  lastExportBytes: () => (lastExport ? Array.from(lastExport.data) : null),
  load: (samples: number[], sampleRate: number, name = 'test') =>
    loadTake({ name, source: 'file', audio: Float32Array.from(samples), sampleRate, keepTempo: false }),
};

// ---------------------------------------------------------------- start

renderTransport();
renderInspector();
void loadSample();
