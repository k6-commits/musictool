// musictool prototype: sing (or open a recording) -> pitch -> notes -> edit -> MIDI.
import { buildFiles, packageFiles, safeName, saveWithLink, type ExportKind } from './app/files';
import { MicCapture, TakeRecorder } from './audio/capture';
import { INSTRUMENTS, Player, type Instrument } from './audio/player';
import { analyzePitch, HOP_SEC, LivePitch, type AnalyzeStats, type InputMode, type PitchFrame } from './dsp/pitch';
import { detectKey } from './music/keydetect';
import { centsOff, hzToMidi, isBlackKey, noteName, type MiddleC, type Notation } from './music/notes';
import { ALL_KEYS, keyFromId, keyId, keyShort, type Key } from './music/scale';
import { makeSample, SAMPLE_BPM } from './synth/voice';
import { arrange, quantizeValue, secondsToBeats, type ArrangedNote } from './transcribe/arrange';
import { SEGMENT_PARAMS, transcribe, type RawNote, type Transcription } from './transcribe/segment';
import { estimateTempo } from './transcribe/tempo';
import { Knob, releaseFocusAfterPointer } from './ui/knob';
import { fitRange, PianoRoll, type RollNote, type RollView } from './ui/roll';

// ---------------------------------------------------------------- environment

interface DownloadsApi {
  save(req: { filename: string; data: Blob | ArrayBuffer | ArrayBufferView | string }): Promise<{ status: string }>;
}
interface ClaudeHost {
  use(name: string): Promise<unknown>;
}
interface FeaturePolicy {
  allowsFeature(feature: string): boolean;
}
const host = (window as unknown as { claude?: ClaudeHost }).claude;
const inArtifact = typeof host?.use === 'function';
const downloadsApi: Promise<DownloadsApi | null> = inArtifact
  ? host!.use('downloads').then((d) => (d as DownloadsApi | null) ?? null, () => null)
  : Promise.resolve(null);

function framed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/** Can this page ask for the microphone? (The claude.ai viewer frames pages without it.) */
function micAllowed(): boolean {
  if (!MicCapture.supported() || !window.isSecureContext) return false;
  const doc = document as unknown as { permissionsPolicy?: FeaturePolicy; featurePolicy?: FeaturePolicy };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  if (policy && typeof policy.allowsFeature === 'function') return policy.allowsFeature('microphone');
  // No policy API (Safari, Firefox): a cross-origin frame gets no microphone unless the parent allows it.
  return !framed();
}

// ---------------------------------------------------------------- state

const BEATS_PER_BAR = 4;
const CHROMATIC: Key = { tonic: 0, mode: 'chromatic' };
const MAX_FILE_SECONDS = 6 * 60;
const MAX_RECORD_SECONDS = 10 * 60;

type Phase = 'idle' | 'arming' | 'count' | 'rec' | 'analyzing';
type Source = 'mic' | 'file' | 'sample';

interface Take {
  id: number;
  name: string;
  source: Source;
  /** Mono samples (a view of `buffer`, so the audio is kept once). */
  audio: Float32Array;
  buffer: AudioBuffer;
  sampleRate: number;
  /** Seconds in `audio` where bar 1 starts. */
  zero: number;
  mode: InputMode;
  frames: PitchFrame[];
  trans: Transcription;
  stats: AnalyzeStats;
  /** Waveform-lane envelope, one value per frame (0..1). */
  peaks: Float32Array;
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

/** Stored preferences, each checked against the values the app understands. */
function loadPrefs(): Prefs {
  const p = { ...defaultPrefs };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    if (raw.notation === 'letter' || raw.notation === 'doremi') p.notation = raw.notation;
    if (raw.middleC === 3 || raw.middleC === 4 || raw.middleC === 5) p.middleC = raw.middleC;
    if (raw.mode === 'sing' || raw.mode === 'hum' || raw.mode === 'whistle') p.mode = raw.mode;
    if (typeof raw.countIn === 'boolean') p.countIn = raw.countIn;
    if (typeof raw.metronome === 'boolean') p.metronome = raw.metronome;
    if (typeof raw.latencyMs === 'number' && Number.isFinite(raw.latencyMs)) p.latencyMs = Math.max(-100, Math.min(200, raw.latencyMs));
    if (INSTRUMENTS.some((i) => i.id === raw.instrument)) p.instrument = raw.instrument as Instrument;
    if (typeof raw.balance === 'number' && Number.isFinite(raw.balance)) p.balance = Math.max(0, Math.min(1, raw.balance));
  } catch {
    /* storage unavailable or not JSON */
  }
  return p;
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
  key: { tonic: 0, mode: 'major' } as Key,
  keyAuto: true,
  detectedKey: null as Key | null,
  snap: 0.6,
  quant: 0.5,
  grid: 0.5,
  fixed: {} as Record<string, number>,
  deleted: new Set<string>(),
  selected: null as string | null,
  notes: [] as ArrangedNote[],
  /** Bumped whenever the arranged notes or their display change; the roll caches its data per version. */
  version: 0,
  cursorBeat: 0,
  playheadBeat: null as number | null,
  appearAt: null as number | null,
  undo: [] as Snapshot[],
  undoTag: '',
  undoAt: 0,
  exportKind: 'both' as ExportKind,
  mic: micAllowed(),
  /** The last microphone used, for the measurement panel. */
  lastInput: null as { kind: string; latencyMs: number } | null,
};

let ctx: AudioContext | null = null;
let player: Player | null = null;
let takeSeq = 0;

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

function getPlayer(): Player {
  if (!player) player = new Player(audio());
  return player;
}

function outputLatency(ac: AudioContext): number {
  return ac.outputLatency || ac.baseLatency || 0;
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

function toBeats(seconds: number): number {
  return secondsToBeats(seconds, S.bpm);
}

function toSeconds(beats: number): number {
  return (beats * 60) / S.bpm;
}

function barBeat(beat: number): string {
  const b = Math.max(0, beat);
  return `${Math.floor(b / BEATS_PER_BAR) + 1}.${Math.floor(b % BEATS_PER_BAR) + 1}`;
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function selectedNote(): ArrangedNote | undefined {
  return S.selected ? S.notes.find((n) => n.id === S.selected) : undefined;
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
}

function undo(): void {
  if (S.phase !== 'idle') return;
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
  refresh();
}

// ---------------------------------------------------------------- arrangement

/** The take's notes on the song timeline (bar 1 = 0 s). */
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

function detectKeyOf(notes: RawNote[]): Key | null {
  if (notes.length < 4) return null;
  return detectKey(notes.map((n) => ({ pitch: Math.round(n.pitch), duration: n.end - n.start })))[0]?.key ?? null;
}

/** Hand edits, located by time so they survive a re-analysis that renumbers the notes. */
interface CarriedEdits {
  fixed: { start: number; end: number; pitch: number }[];
  deleted: { start: number; end: number }[];
}

function collectEdits(t: Take): CarriedEdits {
  const byId = new Map(t.trans.notes.map((n) => [n.id, n]));
  const fixed: CarriedEdits['fixed'] = [];
  const deleted: CarriedEdits['deleted'] = [];
  for (const [id, pitch] of Object.entries(S.fixed)) {
    const n = byId.get(id);
    if (n) fixed.push({ start: n.start, end: n.end, pitch });
  }
  for (const id of S.deleted) {
    const n = byId.get(id);
    if (n) deleted.push({ start: n.start, end: n.end });
  }
  return { fixed, deleted };
}

/** Apply carried edits to the note that overlaps each edited span the most (at least half of the shorter). */
function applyEdits(notes: RawNote[], carried: CarriedEdits): void {
  const match = (span: { start: number; end: number }) => {
    let best: RawNote | null = null;
    let bestOverlap = 0;
    for (const n of notes) {
      const overlap = Math.min(n.end, span.end) - Math.max(n.start, span.start);
      const need = 0.5 * Math.min(n.end - n.start, span.end - span.start);
      if (overlap >= need && overlap > bestOverlap) {
        best = n;
        bestOverlap = overlap;
      }
    }
    return best;
  };
  for (const f of carried.fixed) {
    const n = match(f);
    if (n) S.fixed[n.id] = f.pitch;
  }
  for (const d of carried.deleted) {
    const n = match(d);
    if (n) S.deleted.add(n.id);
  }
}

// ---------------------------------------------------------------- loading takes

interface TakeInput {
  name: string;
  source: Source;
  audio: Float32Array;
  sampleRate: number;
  /** Bar 1 and tempo when known (a take recorded to the click); otherwise both are guessed from the notes. */
  timing?: { zero: number; bpm: number };
  /** Pitch frames already computed with the current input mode (live, while recording). */
  analysis?: { frames: PitchFrame[]; stats: AnalyzeStats };
  /** Hand edits to keep from an earlier analysis of the same audio. */
  carried?: CarriedEdits;
}

function envelopeOf(frames: PitchFrame[]): Float32Array {
  let maxRms = 1e-9;
  for (const f of frames) maxRms = Math.max(maxRms, f.rms);
  const peaks = new Float32Array(frames.length);
  for (let i = 0; i < peaks.length; i++) peaks[i] = Math.sqrt(Math.max(0, frames[i].rms / maxRms - 0.03));
  return peaks;
}

async function loadTake(input: TakeInput): Promise<void> {
  if (S.phase !== 'idle') return;
  stopPlayback();
  S.phase = 'analyzing';
  el.busy.hidden = false;
  el.empty.hidden = true;
  el.busyBar.style.width = '0%';
  renderTransport();
  try {
    const mode = P.mode;
    const { frames, stats } =
      input.analysis ??
      (await analyzePitch(input.audio, input.sampleRate, mode, (p) => {
        el.busyBar.style.width = `${Math.round(p * 100)}%`;
      }));
    const trans = transcribe(frames, SEGMENT_PARAMS[mode]);
    let zero = input.timing?.zero ?? 0;
    let bpm = input.timing?.bpm ?? S.bpm;
    if (!input.timing) {
      const guess = estimateTempo(trans.notes.map((n) => n.start));
      if (guess) {
        bpm = guess.bpm;
        zero = guess.zero;
      } else if (trans.notes.length) {
        zero = trans.notes[0].start;
      }
    }
    // Keep the audio once: in the AudioBuffer used for playback, read back through a view.
    const buffer = new AudioBuffer({ length: Math.max(1, input.audio.length), sampleRate: input.sampleRate, numberOfChannels: 1 });
    buffer.copyToChannel(input.audio as Float32Array<ArrayBuffer>, 0);
    S.take = {
      id: ++takeSeq,
      name: input.name,
      source: input.source,
      audio: buffer.getChannelData(0),
      buffer,
      sampleRate: input.sampleRate,
      zero,
      mode,
      frames,
      trans,
      stats,
      peaks: envelopeOf(frames),
    };
    S.bpm = Math.max(40, Math.min(240, bpm));
    S.fixed = {};
    S.deleted = new Set();
    if (input.carried) applyEdits(trans.notes, input.carried);
    S.selected = null;
    S.undo = [];
    S.undoTag = '';
    S.detectedKey = detectKeyOf(shiftedNotes(S.take));
    if (S.keyAuto) S.key = S.detectedKey ?? CHROMATIC;
    S.cursorBeat = 0;
    S.playheadBeat = null;
    S.appearAt = performance.now() + 120;
    roll.scrollToStart();
    if (!trans.notes.length) toast('声が見つかりませんでした', 'warn');
  } catch {
    toast('解析できませんでした', 'warn');
  } finally {
    S.phase = 'idle';
    el.busy.hidden = true;
  }
  refresh();
  loop();
}

async function loadSample(): Promise<void> {
  if (S.phase !== 'idle') return;
  const sr = 48000;
  await loadTake({ name: 'サンプル', source: 'sample', audio: makeSample(sr), sampleRate: sr, timing: { zero: 0, bpm: SAMPLE_BPM } });
}

async function loadFile(file: File): Promise<void> {
  if (S.phase !== 'idle') return;
  let decoded: AudioBuffer;
  try {
    decoded = await audio().decodeAudioData(await file.arrayBuffer());
  } catch {
    toast('この音声は読み込めませんでした', 'warn');
    return;
  }
  // A recording may have started while the file was decoding.
  if (S.phase !== 'idle') return;
  if (decoded.duration > MAX_FILE_SECONDS) {
    toast('6 分までの音声に対応しています', 'warn');
    return;
  }
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / decoded.numberOfChannels;
  }
  const name = file.name.replace(/\.[^.]+$/, '') || 'voice';
  await loadTake({ name, source: 'file', audio: mono, sampleRate: decoded.sampleRate });
}

/** Re-analyze the current take with the current input mode, keeping hand edits. */
async function reanalyze(): Promise<void> {
  const t = S.take;
  if (!t || S.phase !== 'idle' || t.mode === P.mode) return;
  await loadTake({
    name: t.name,
    source: t.source,
    audio: t.audio,
    sampleRate: t.sampleRate,
    timing: { zero: t.zero, bpm: S.bpm },
    carried: collectEdits(t),
  });
}

// ---------------------------------------------------------------- recording

/** Growable Float32Array; `view()` is a window onto the filled part (no copy). */
class Series {
  private a = new Float32Array(4096);
  length = 0;
  push(v: number): void {
    if (this.length === this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.length++] = v;
  }
  view(): Float32Array {
    return this.a.subarray(0, this.length);
  }
}

interface Rec {
  capture: MicCapture;
  recorder: TakeRecorder;
  live: LivePitch;
  mode: InputMode;
  sampleRate: number;
  frames: PitchFrame[];
  bpm: number;
  spb: number;
  t0: number;
  zeroTime: number;
  latency: number;
  countBeats: number;
  nextBeat: number;
  clicks: { osc: OscillatorNode; time: number }[];
  clickTimer: number;
  shownCount: number;
  lastTranscribe: number;
  /** Live preview notes (take time) and their arrangement for the roll. */
  rawNotes: RawNote[];
  rollNotes: RollNote[];
  curveBeats: Series;
  curvePitch: Series;
  peaks: Series;
  envStart: number;
  pitch: number | null;
  pitchAt: number;
  range: [number, number];
}

let rec: Rec | null = null;
let armToken = 0;

/** Seconds to add to a time in the recording to get song time (bar 1 = 0). */
function songOffset(r: Rec): number {
  return r.recorder.firstFrame / r.sampleRate - r.zeroTime - r.latency;
}

async function startRecording(): Promise<void> {
  if (S.phase !== 'idle' || !S.mic) return;
  stopPlayback();
  S.phase = 'arming';
  S.selected = null;
  renderTransport();
  renderInspector();
  const token = ++armToken;
  const ac = audio();
  let capture: MicCapture;
  try {
    await ac.resume();
    capture = await MicCapture.open(ac);
  } catch (e) {
    if (token !== armToken) return;
    S.phase = 'idle';
    const name = (e as { name?: string })?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      S.mic = false;
      toast('マイクが使えません。音声ファイルを開いてください', 'warn');
    } else {
      toast('マイクを開けませんでした', 'warn');
    }
    renderTransport();
    renderInspector();
    return;
  }
  // REC pressed again (cancel) while the microphone was opening.
  if (token !== armToken || S.phase !== 'arming') {
    capture.close();
    return;
  }
  getPlayer();
  const spb = 60 / S.bpm;
  const t0 = ac.currentTime + 0.15;
  const countBeats = P.countIn ? BEATS_PER_BAR : 0;
  const latency = outputLatency(ac) + capture.inputLatency + P.latencyMs / 1000;
  S.lastInput = { kind: capture.kind === 'worklet' ? 'Worklet' : 'ScriptProcessor', latencyMs: Math.round(latency * 1000) };
  const r: Rec = {
    capture,
    recorder: new TakeRecorder(),
    live: new LivePitch(capture.sampleRate, P.mode),
    mode: P.mode,
    sampleRate: capture.sampleRate,
    frames: [],
    bpm: S.bpm,
    spb,
    t0,
    zeroTime: t0 + countBeats * spb,
    latency,
    countBeats,
    nextBeat: 0,
    clicks: [],
    clickTimer: 0,
    shownCount: -1,
    lastTranscribe: 0,
    rawNotes: [],
    rollNotes: [],
    curveBeats: new Series(),
    curvePitch: new Series(),
    peaks: new Series(),
    envStart: 0,
    pitch: null,
    pitchAt: 0,
    range: S.take ? currentRange() : [55, 76],
  };
  rec = r;
  const params = SEGMENT_PARAMS[r.mode];
  capture.onEnded = () => {
    if (rec === r) {
      toast('マイクが切れました', 'warn');
      void stopRecording();
    }
  };
  capture.listen((data, frame) => {
    r.recorder.push(data, frame);
    const offset = songOffset(r);
    for (const f of r.live.push(data)) {
      r.frames.push(f);
      const songT = f.t + offset;
      // Same confidence rule as the transcription; a low fixed level floor so quiet singers still show.
      const voiced = f.f0 > 0 && f.conf >= params.confThreshold && f.rms > 0.001;
      if (voiced) {
        r.pitch = hzToMidi(f.f0);
        r.pitchAt = songT;
      } else if (songT - r.pitchAt > 0.15) {
        r.pitch = null;
      }
      if (songT < -0.2) continue;
      if (!r.peaks.length) r.envStart = (songT - HOP_SEC / 2) / r.spb;
      r.peaks.push(Math.min(1, Math.sqrt(Math.max(0, f.rms * 6 - 0.01))));
      const pitch = voiced ? hzToMidi(f.f0) : NaN;
      r.curveBeats.push(songT / r.spb);
      r.curvePitch.push(pitch);
      if (voiced) r.range = [Math.min(r.range[0], Math.floor(pitch) - 2), Math.max(r.range[1], Math.ceil(pitch) + 2)];
    }
  });
  // Clicks are scheduled well ahead from a timer, so they keep going in a background tab.
  r.clickTimer = window.setInterval(() => scheduleClicks(r), 250);
  scheduleClicks(r);
  S.phase = countBeats ? 'count' : 'rec';
  S.playheadBeat = 0;
  roll.scrollToStart();
  renderTransport();
  renderInspector();
  loop();
}

function scheduleClicks(r: Rec): void {
  const ac = audio();
  const p = getPlayer();
  const now = ac.currentTime;
  r.clicks = r.clicks.filter((c) => c.time > now);
  while (r.t0 + r.nextBeat * r.spb < now + 1.5) {
    const k = r.nextBeat++;
    const time = r.t0 + k * r.spb;
    if (k < r.countBeats || P.metronome) r.clicks.push({ osc: p.click(time, k % BEATS_PER_BAR === 0), time });
  }
}

/** Live preview notes: the last ~20 s are re-transcribed; earlier notes are kept as they were. */
const LIVE_WINDOW_FRAMES = 1250;

function updateRecording(r: Rec): void {
  const now = audio().currentTime;
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
  if (S.phase !== 'rec') return;
  S.playheadBeat = Math.max(0, (now - r.zeroTime) / r.spb);
  if (now - r.zeroTime > MAX_RECORD_SECONDS) {
    toast('10 分で録音を止めました', 'warn');
    void stopRecording();
    return;
  }
  const wall = performance.now();
  if (wall - r.lastTranscribe > 300 && r.frames.length > 10) {
    r.lastTranscribe = wall;
    const params = SEGMENT_PARAMS[r.mode];
    const from = Math.max(0, r.frames.length - LIVE_WINDOW_FRAMES);
    if (from === 0) {
      r.rawNotes = transcribe(r.frames, params).notes;
    } else {
      // Notes that begin near the window's start may be cut by it: take those from the earlier result.
      const edge = r.frames[from].t + 2;
      const kept = r.rawNotes.filter((n) => n.start < edge);
      const fresh = transcribe(r.frames.slice(from), params).notes.filter((n) => n.start >= edge);
      r.rawNotes = kept.concat(fresh);
    }
    const offset = songOffset(r);
    const shifted = r.rawNotes
      .map((n, i) => ({ ...n, id: `l${i}`, start: n.start + offset, end: n.end + offset }))
      .filter((n) => n.end > 0)
      .map((n) => ({ ...n, start: Math.max(0, n.start) }));
    r.rollNotes = arrange(shifted, { bpm: r.bpm, key: S.key, snap: S.snap, quant: 0, grid: S.grid, fixed: {}, deleted: [] }).map((n) => ({
      id: n.id,
      pitch: n.pitch,
      startBeat: n.startBeat,
      endBeat: n.endBeat,
      flagged: false,
      label: label(n.pitch),
    }));
  }
}

async function stopRecording(): Promise<void> {
  const r = rec;
  if (!r) {
    // Still opening the microphone: cancel.
    if (S.phase === 'arming') {
      armToken++;
      S.phase = 'idle';
      renderTransport();
      renderInspector();
    }
    return;
  }
  rec = null;
  window.clearInterval(r.clickTimer);
  for (const c of r.clicks) {
    try {
      c.osc.stop();
    } catch {
      /* already stopped */
    }
  }
  r.capture.listen(null);
  r.capture.close();
  el.count.hidden = true;
  const wasCounting = S.phase === 'count';
  S.phase = 'idle';
  S.playheadBeat = null;
  if (wasCounting) {
    renderTransport();
    refresh();
    return;
  }
  const data = r.recorder.merge();
  const zero = Math.max(0, -songOffset(r));
  if (data.length / r.sampleRate - zero < 0.4) {
    toast('短すぎます', 'warn');
    renderTransport();
    refresh();
    return;
  }
  // The live tracker already analyzed every chunk; finishing it gives the frames an offline pass would.
  const frames = r.frames.concat(r.live.finish());
  await loadTake({
    name: stampName(),
    source: 'mic',
    audio: data,
    sampleRate: r.sampleRate,
    timing: { zero, bpm: r.bpm },
    analysis: r.mode === P.mode ? { frames, stats: { millisPerFrame: r.live.millisPerFrame } } : undefined,
  });
}

// ---------------------------------------------------------------- playback

function playbackEnded(): void {
  S.playheadBeat = null;
  renderTransport();
  renderNow();
  drawRoll();
}

function play(): void {
  const t = S.take;
  if (!t || S.phase !== 'idle') return;
  void audio().resume();
  getPlayer().play({
    notes: S.notes.map((n) => ({ pitch: n.pitch, start: toSeconds(n.startBeat), dur: toSeconds(n.endBeat - n.startBeat), velocity: n.velocity })),
    voice: t.buffer,
    voiceZero: t.zero,
    from: toSeconds(S.cursorBeat),
    balance: P.balance,
    instrument: P.instrument,
    onEnd: playbackEnded,
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
  if (S.phase === 'arming' || S.phase === 'count' || S.phase === 'rec') {
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
  if (S.phase === 'arming' || S.phase === 'count' || S.phase === 'rec') void stopRecording();
  else if (S.phase === 'idle') void startRecording();
}

/** Play the original voice under the selected note. */
function listenSelected(): void {
  const t = S.take;
  const n = selectedNote();
  if (!t || !n || S.phase !== 'idle') return;
  void audio().resume();
  stopPlayback();
  // n.raw is already on the song timeline; the player adds the take's bar-1 offset itself.
  getPlayer().play({
    notes: [],
    voice: t.buffer,
    voiceZero: t.zero,
    from: Math.max(0, n.raw.start - 0.04),
    to: n.raw.end + 0.04,
    balance: 0,
    instrument: P.instrument,
    onEnd: playbackEnded,
  });
  renderTransport();
  loop();
}

function preview(pitch: number): void {
  void audio().resume();
  getPlayer().preview(pitch, P.instrument);
}

// ---------------------------------------------------------------- render

function refresh(): void {
  S.notes = arranged();
  S.version++;
  if (S.selected && !S.notes.some((n) => n.id === S.selected)) S.selected = null;
  renderTransport();
  renderInspector();
  drawRoll();
}

function renderTransport(): void {
  const recording = S.phase === 'arming' || S.phase === 'rec' || S.phase === 'count';
  el.title.textContent = recording ? 'REC' : (S.take?.name ?? '');
  el.btnRec.hidden = !S.mic;
  el.btnRec.classList.toggle('on', S.phase === 'rec');
  el.btnRec.classList.toggle('count', S.phase === 'count' || S.phase === 'arming');
  el.btnRec.setAttribute('aria-label', recording ? '停止' : '録音をはじめる');
  el.btnRec.title = recording ? '停止（R）' : '録音（R）';
  el.btnRec.disabled = S.phase === 'analyzing';
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
  el.btnUndo.disabled = S.undo.length === 0 || S.phase !== 'idle';
  el.btnMetro.setAttribute('aria-pressed', String(P.metronome));
  el.btnCount.setAttribute('aria-pressed', String(P.countIn));
  el.bpm.value = String(Math.round(S.bpm));
  el.bpm.disabled = S.phase !== 'idle';
  renderKeySelect();
  updateCounter();
}

function renderKeySelect(): void {
  const opts: string[] = [];
  opts.push(`<option value="auto">AUTO · ${keyShort(S.detectedKey ?? CHROMATIC)}</option>`);
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
  el.ctrTime.textContent = clock(toSeconds(beat));
  el.ctrPos.parentElement!.classList.toggle('rec', S.phase === 'rec');
}

function renderNow(): void {
  const recording = S.phase === 'arming' || S.phase === 'count' || S.phase === 'rec';
  el.recBadge.hidden = S.phase !== 'rec';
  el.tuner.hidden = S.phase !== 'rec';
  el.meter.hidden = !recording;
  const big = el.nowNote;
  big.className = 'big';
  if (recording) {
    const r = rec;
    el.nowLabel.textContent = S.phase === 'rec' ? 'NOW' : 'READY';
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
    el.meterBar.style.width = `${Math.min(100, Math.round(Math.sqrt(r?.capture.level ?? 0) * 220))}%`;
    return;
  }
  const sel = selectedNote();
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
  el.nowInfo.textContent = S.take ? `${S.notes.length} notes · ♩${Math.round(S.bpm)}` : '';
}

function renderInspector(): void {
  renderNow();
  const idle = S.phase === 'idle';
  // Buttons below are rebuilt; remember which one had keyboard focus so it can get it back.
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focus;
  // Selected note: candidate keys.
  const sel = idle ? selectedNote() : undefined;
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
      b.dataset.focus = `cand-${p - center}`;
      if (p === auto) {
        const dot = document.createElement('span');
        dot.className = 'rec-dot';
        dot.setAttribute('aria-hidden', 'true');
        b.appendChild(dot);
      }
      const name = document.createElement('span');
      name.textContent = label(p);
      b.appendChild(name);
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
    b.dataset.focus = `flag-${n.id}`;
    b.innerHTML = `<span class="pos"></span><span class="lab"></span><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>`;
    (b.querySelector('.pos') as HTMLElement).textContent = barBeat(n.startBeat);
    (b.querySelector('.lab') as HTMLElement).textContent = label(n.pitch);
    b.addEventListener('click', () => select(n.id, true));
    el.flagList.appendChild(b);
  }
  if (focusKey && (focusKey.startsWith('cand-') || focusKey.startsWith('flag-'))) {
    const again =
      document.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`) ??
      (focusKey.startsWith('flag-') ? (el.flagList.querySelector<HTMLElement>('.flag-row') ?? el.cands.querySelector<HTMLElement>('.cand.current')) : null);
    again?.focus();
  }
  el.instLabel.textContent = INSTRUMENTS.find((i) => i.id === P.instrument)?.label ?? 'PIANO';
  el.balance.value = String(Math.round(P.balance * 100));
  gridChip.textContent = gridLabel(S.grid);
  el.empty.hidden = !!S.take || S.phase !== 'idle';
  renderSettings();
}

/** Visible pitch range of the current take. */
function currentRange(): [number, number] {
  const t = S.take;
  const pitches: number[] = S.notes.map((n) => n.pitch);
  if (t) for (const p of t.trans.curve) pitches.push(p);
  return fitRange(pitches, roll.minRows);
}

/** Roll data that only changes with the notes, the take or the tempo (not every frame). */
let rollCache: {
  version: number;
  notes: RollNote[];
  curve: RollView['curve'];
  envelope: RollView['envelope'];
  total: number;
  range: [number, number];
} | null = null;

function rollData() {
  if (rollCache?.version === S.version) return rollCache;
  const t = S.take;
  const notes: RollNote[] = S.notes.map((n) => ({
    id: n.id,
    pitch: n.pitch,
    startBeat: n.startBeat,
    endBeat: n.endBeat,
    flagged: n.flagged,
    label: label(n.pitch),
  }));
  let curve: RollView['curve'] = null;
  let envelope: RollView['envelope'] = null;
  let total = 16;
  if (t) {
    const beats = new Float32Array(t.trans.frameTimes.length);
    for (let i = 0; i < beats.length; i++) beats[i] = toBeats(t.trans.frameTimes[i] - t.zero);
    curve = { beats, pitch: t.trans.curve };
    envelope = { start: toBeats((t.frames[0]?.t ?? 0) - t.zero - HOP_SEC / 2), step: toBeats(HOP_SEC), peaks: t.peaks };
    let endBeat = toBeats(t.audio.length / t.sampleRate - t.zero);
    for (const n of S.notes) endBeat = Math.max(endBeat, n.endBeat);
    total = Math.max(16, Math.ceil((endBeat + 1) / BEATS_PER_BAR) * BEATS_PER_BAR);
  }
  rollCache = { version: S.version, notes, curve, envelope, total, range: currentRange() };
  return rollCache;
}

function drawRoll(): void {
  const r = rec;
  let view: Omit<RollView, 'playhead' | 'selectedId' | 'keyLabel' | 'beatsPerBar' | 'grid'>;
  if (r && (S.phase === 'count' || S.phase === 'rec')) {
    view = {
      notes: r.rollNotes,
      curve: { beats: r.curveBeats.view(), pitch: r.curvePitch.view() },
      envelope: { start: r.envStart, step: HOP_SEC / r.spb, peaks: r.peaks.view() },
      totalBeats: Math.max(16, Math.ceil(((S.playheadBeat ?? 0) + 6) / BEATS_PER_BAR) * BEATS_PER_BAR),
      range: r.range,
      lit: r.pitch != null && S.phase === 'rec' ? { pitch: r.pitch, kind: 'voice' } : null,
      appearAt: null,
    };
  } else {
    const d = rollData();
    let lit: RollView['lit'] = null;
    if (S.playheadBeat !== null) {
      const ph = S.playheadBeat;
      const cur = S.notes.find((n) => n.startBeat <= ph && ph < n.endBeat);
      if (cur) lit = { pitch: cur.pitch, kind: 'note' };
    } else {
      const sel = selectedNote();
      if (sel) lit = { pitch: sel.pitch, kind: 'note' };
    }
    view = { notes: d.notes, curve: d.curve, envelope: d.envelope, totalBeats: d.total, range: d.range, lit, appearAt: S.appearAt };
  }
  roll.setView({
    ...view,
    beatsPerBar: BEATS_PER_BAR,
    grid: S.grid,
    playhead: S.playheadBeat ?? (S.take ? S.cursorBeat : null),
    selectedId: S.selected,
    keyLabel: label,
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
    if (pos !== null) S.playheadBeat = toBeats(pos);
    renderNow();
    again = true;
  }
  if (S.playheadBeat !== null) roll.follow(S.playheadBeat);
  drawRoll();
  if (roll.animating) again = true;
  else S.appearAt = null;
  updateCounter();
  if (again) loop();
}

// ---------------------------------------------------------------- editing

function select(id: string | null, reveal = false): void {
  S.selected = id;
  const n = selectedNote();
  if (n) {
    preview(n.pitch);
    if (reveal) roll.follow(n.startBeat);
  }
  renderInspector();
  drawRoll();
}

function setPitch(id: string, pitch: number): void {
  if (S.phase !== 'idle') return;
  pushUndo('');
  S.fixed[id] = Math.max(0, Math.min(127, pitch));
  preview(pitch);
  refresh();
}

function deleteSelected(): void {
  if (!S.selected || S.phase !== 'idle') return;
  pushUndo('');
  S.deleted.add(S.selected);
  S.selected = null;
  refresh();
}

/** Move the playback cursor (and restart playback there if it was playing). */
function seek(beat: number): void {
  const wasPlaying = !!player?.playing;
  stopPlayback();
  S.cursorBeat = Math.max(0, beat);
  if (wasPlaying) play();
  updateCounter();
  drawRoll();
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
  if (el.settings.hidden) return;
  const idle = S.phase === 'idle';
  for (const seg of el.settings.querySelectorAll<HTMLElement>('.seg')) {
    const key = seg.dataset.setting as 'notation' | 'middleC' | 'mode';
    for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
      b.setAttribute('aria-pressed', String(String(P[key]) === b.dataset.v));
      // The input mode decides how a take is analyzed: it cannot change mid-recording or mid-analysis.
      if (key === 'mode') b.disabled = !idle;
    }
  }
  el.btnSample.disabled = !idle;
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
  if (S.lastInput) {
    rows.push(['入力', S.lastInput.kind]);
    rows.push(['遅れ', `${S.lastInput.latencyMs} ms`]);
  }
  el.measure.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    el.measure.append(dt, dd);
  }
  el.measure.hidden = rows.length === 0;
}

function renderExport(zipOnly: boolean): void {
  for (const tile of el.exportSheet.querySelectorAll<HTMLButtonElement>('.tile')) {
    tile.setAttribute('aria-checked', String(tile.dataset.kind === S.exportKind));
  }
  for (const small of el.exportSheet.querySelectorAll<HTMLElement>('small[data-ext]')) {
    const kind = small.dataset.ext;
    small.textContent = zipOnly || kind === 'both' ? '.zip' : kind === 'midi' ? '.mid' : '.wav';
  }
  el.exportNote.hidden = !zipOnly;
  el.exportNote.textContent = zipOnly ? 'ZIP にまとめて保存。展開して DAW へ' : '';
}

/** In the claude.ai viewer files are saved through the host, which accepts .zip but not .mid or .wav. */
async function saveVia(): Promise<DownloadsApi | null> {
  return inArtifact ? downloadsApi : null;
}

async function openExport(): Promise<void> {
  if (!S.take || S.phase !== 'idle') return;
  stopPlayback();
  el.exportName.value = S.take.source === 'sample' ? 'musictool-sample' : S.take.name;
  renderExport(!!(await saveVia()));
  showSheet(el.exportSheet);
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
    beatsPerBar: BEATS_PER_BAR,
    key: S.key,
    program: INSTRUMENTS.find((i) => i.id === P.instrument)?.program ?? 0,
    notes: S.notes,
    voice: t.audio.subarray(startSample),
    sampleRate: t.sampleRate,
  });
  const dl = await saveVia();
  const out = packageFiles(files, name, !!dl);
  lastExport = { filename: out.name, files: files.map((f) => ({ name: f.name, size: f.data.length })) };
  if (!dl) {
    saveWithLink(out);
    closeSheet();
    toast(`${out.name} を書き出しました`, 'ok');
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

let lastExport: { filename: string; files: { name: string; size: number }[] } | null = null;

// ---------------------------------------------------------------- events

el.btnPlay.addEventListener('click', togglePlay);
el.btnRec.addEventListener('click', toggleRec);
el.btnStart.addEventListener('click', () => {
  roll.scrollToStart();
  seek(0);
});
el.btnMetro.addEventListener('click', () => {
  P.metronome = !P.metronome;
  savePrefs();
  // Turned off while recording: silence the clicks already scheduled after the count-in.
  if (rec && !P.metronome) {
    const r = rec;
    for (const c of r.clicks) {
      if (c.time < r.zeroTime) continue;
      try {
        c.osc.stop();
      } catch {
        /* already stopped */
      }
    }
    r.clicks = r.clicks.filter((c) => c.time < r.zeroTime);
  }
  renderTransport();
});
el.btnCount.addEventListener('click', () => {
  P.countIn = !P.countIn;
  savePrefs();
  renderTransport();
});
el.bpm.addEventListener('change', () => {
  const v = Math.round(Number(el.bpm.value));
  if (S.phase !== 'idle' || !Number.isFinite(v) || v < 40 || v > 240) {
    el.bpm.value = String(Math.round(S.bpm));
    return;
  }
  pushUndo('');
  S.bpm = v;
  refresh();
});
el.key.addEventListener('change', () => {
  if (S.phase !== 'idle') return;
  pushUndo('');
  if (el.key.value === 'auto') {
    S.keyAuto = true;
    S.key = S.detectedKey ?? CHROMATIC;
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
  showSheet(el.settings);
  renderSettings();
});
el.btnUndo.addEventListener('click', undo);
el.btnExport.addEventListener('click', () => void openExport());
el.btnDownload.addEventListener('click', () => void doExport());
for (const tile of el.exportSheet.querySelectorAll<HTMLButtonElement>('.tile')) {
  tile.addEventListener('click', async () => {
    S.exportKind = tile.dataset.kind as ExportKind;
    renderExport(!!(await saveVia()));
  });
}
el.backdrop.addEventListener('click', closeSheet);
for (const b of document.querySelectorAll<HTMLButtonElement>('.sheet button.close')) b.addEventListener('click', closeSheet);
for (const seg of el.settings.querySelectorAll<HTMLElement>('.seg')) {
  seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || b.disabled) return;
    const key = seg.dataset.setting;
    const v = b.dataset.v ?? '';
    if (key === 'notation') P.notation = v as Notation;
    if (key === 'middleC') P.middleC = Number(v) as MiddleC;
    if (key === 'mode') {
      if (S.phase !== 'idle') return;
      P.mode = v as InputMode;
    }
    savePrefs();
    renderSettings();
    refresh();
    if (key === 'mode') void reanalyze();
  });
}
el.latency.addEventListener('input', () => {
  P.latencyMs = Number(el.latency.value);
  savePrefs();
  renderSettings();
});
el.btnSample.addEventListener('click', () => {
  if (S.phase !== 'idle') return;
  closeSheet();
  void loadSample();
});
el.btnInst.addEventListener('click', () => {
  const i = INSTRUMENTS.findIndex((x) => x.id === P.instrument);
  P.instrument = INSTRUMENTS[(i + 1) % INSTRUMENTS.length].id;
  savePrefs();
  renderInspector();
  preview(selectedNote()?.pitch ?? 60);
});
el.balance.addEventListener('input', () => {
  P.balance = Number(el.balance.value) / 100;
  savePrefs();
});
releaseFocusAfterPointer(el.balance);
el.btnListen.addEventListener('click', listenSelected);
el.btnDelete.addEventListener('click', deleteSelected);

roll.onPick = (id, beat) => {
  if (S.phase !== 'idle') return;
  if (id) {
    select(id);
    return;
  }
  S.selected = null;
  renderInspector();
  seek(quantizeValue(beat, S.grid, 1));
};

// Drag and drop audio files anywhere on the page (a drop outside the editor must not open the file).
let dragDepth = 0;
const draggingFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  el.drop.hidden = false;
});
document.addEventListener('dragover', (e) => {
  if (draggingFiles(e)) e.preventDefault();
});
document.addEventListener('dragleave', (e) => {
  if (!draggingFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.drop.hidden = true;
});
document.addEventListener('drop', (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  el.drop.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadFile(f);
});

/** Space is play/stop everywhere except in text fields, so a focused button must not also activate on it. */
function isTextField(t: HTMLElement): boolean {
  if (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
  return t.tagName === 'INPUT' && !['range', 'button', 'checkbox', 'radio'].includes((t as HTMLInputElement).type);
}

document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && !openSheet && !isTextField(e.target as HTMLElement)) e.preventDefault();
});

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    if (openSheet) closeSheet();
    else if (S.selected) select(null);
    return;
  }
  if (openSheet) {
    if (e.key === 'Tab') trapFocus(e, openSheet);
    return;
  }
  if (isTextField(target)) return;
  const onRange = target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'range';
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  } else if (mod && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    void openExport();
  } else if (mod) {
    return;
  } else if (e.key === ' ') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'r' || e.key === 'R') {
    toggleRec();
  } else if (onRange) {
    // Arrows, Home and End belong to the focused knob or fader.
    return;
  } else if (e.key === 'Home') {
    e.preventDefault();
    el.btnStart.click();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected) {
    e.preventDefault();
    deleteSelected();
  } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && S.selected) {
    e.preventDefault();
    const n = selectedNote();
    if (n) setPitch(n.id, n.pitch + (e.key === 'ArrowUp' ? 1 : -1));
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && S.notes.length && S.phase === 'idle') {
    // With a note selected: the next or previous note. Without: the first note after (or before) the cursor.
    e.preventDefault();
    const right = e.key === 'ArrowRight';
    let next: ArrangedNote | undefined;
    if (S.selected) {
      const i = S.notes.findIndex((x) => x.id === S.selected);
      next = S.notes[i + (right ? 1 : -1)];
    } else if (right) {
      next = S.notes.find((n) => n.startBeat >= S.cursorBeat - 1e-6) ?? S.notes[S.notes.length - 1];
    } else {
      next = [...S.notes].reverse().find((n) => n.startBeat < S.cursorBeat - 1e-6) ?? S.notes[0];
    }
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

// ---------------------------------------------------------------- test hook (read by the E2E run)

(window as unknown as { __mt: unknown }).__mt = {
  get phase() {
    return S.phase;
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
  lastExport: () => lastExport,
  select: (index: number) => select(S.notes[index]?.id ?? null),
};

// ---------------------------------------------------------------- start

renderTransport();
renderInspector();
void loadSample();
