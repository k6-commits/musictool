/// <reference types="node" />
// Accuracy on real recordings: each pitch engine's frames go through the same note segmentation, and the notes
// are scored against human annotations (see eval/real/metrics.ts). Run: npm run eval:real -- [--data <dir>]
// [--engine yin,swiftf0] [--conditions clean,cafeteria10,...] [--make-noisy] [--items] [--json <file>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { analyzePitch, type AnalyzeOptions, type PitchEngine, type PitchFrame } from '../src/dsp/pitch';
import { hzToMidi, midiToHz } from '../src/music/notes';
import { segmentParams, transcribe } from '../src/transcribe/segment';
import { allItems, type Item } from './real/datasets';
import { frameScores, octaveErrors, prf, sequenceF1, type FrameScores, type TimedNote } from './real/metrics';
import { conditionWav, parseCondition, type Condition } from './real/noise';
import { readWav, type Audio } from './real/wav';

interface Engine {
  name: string;
  /** The engine whose segmentation parameters apply. */
  kind: PitchEngine;
  run(item: Item, audio: Audio, condition: Condition): Promise<{ frames: PitchFrame[]; msPerFrame: number } | null>;
}

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = arg('data', process.env.MUSICTOOL_EVAL_DATA ?? join(process.cwd(), 'eval/data'));
const wanted = arg('engine', 'yin,swiftf0').split(',');
const verbose = args.includes('--items');
const conditions = arg('conditions', 'clean').split(',').map(parseCondition);

/** The app's analysis (analyzePitch) with the given options. */
function viaApp(name: string, kind: PitchEngine, opts: AnalyzeOptions = {}): Engine {
  return {
    name,
    kind,
    async run(item, audio) {
      const { frames, stats } = await analyzePitch(audio.samples, audio.sampleRate, item.mode, { ...opts, engine: kind });
      return { frames, msPerFrame: stats.millisPerFrame };
    },
  };
}

const ENGINES: Engine[] = [
  viaApp('yin', 'yin'),
  viaApp('swiftf0', 'swiftf0'),
  // SwiftF0 without the app's octave check, for comparison.
  viaApp('swiftf0-plain', 'swiftf0', { octaveCheck: false }),
  {
    // Frames written by the reference implementation (the swift-f0 Python package, at the recording's own level):
    // eval/real/swiftf0_frames.py.
    name: 'swiftf0-ref',
    kind: 'swiftf0',
    async run(item, _audio, condition) {
      const path = join(root, 'frames/swiftf0', condition.name, item.dataset, `${item.id}.json`);
      if (!existsSync(path)) return null;
      const j = JSON.parse(readFileSync(path, 'utf8')) as { t: number[]; f0: number[]; conf: number[]; db: number[] };
      const frames = j.t.map((t, i) => ({ t, f0: j.f0[i], conf: j.conf[i], rms: Math.pow(10, j.db[i] / 20) }));
      return { frames, msPerFrame: NaN };
    },
  },
];

interface Row {
  dataset: string;
  condition: string;
  engine: string;
  items: number;
  refNotes: number;
  estNotes: number;
  conp: number;
  conpoff: number;
  con: number;
  octave: number;
  seq: number;
  frame: FrameScores | null;
  msPerFrame: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Notes from one engine's analysis, with absolute pitch (the segmentation removes the singer's tuning offset). */
async function notesOf(item: Item, audio: Audio, kind: PitchEngine): Promise<TimedNote[]> {
  const { frames } = await analyzePitch(audio.samples, audio.sampleRate, item.mode, { engine: kind });
  const t = transcribe(frames, segmentParams(item.mode, kind));
  return t.notes.map((n) => ({ start: n.start, end: n.end, hz: midiToHz(n.pitch + t.tuningCents / 100) }));
}

/**
 * A score-based reference (HumTrans) fitted to its recording, once, for every engine and condition alike: the start
 * offset (0-2 s; people following the playback lag it by up to 1.5 s) and octave (people hum low melodies one or two
 * octaves down) that together match the most notes (onset and pitch). The matches are summed over YIN's and
 * SwiftF0's notes on the clean recording, so neither engine is favoured. (Fitting the offset on onsets alone first
 * misplaces recordings with a very regular rhythm.)
 */
async function fitScore(item: Item): Promise<{ notes: TimedNote[]; offset: number; octave: number }> {
  const audio = readWav(readFileSync(item.wav));
  const est = [await notesOf(item, audio, 'yin'), await notesOf(item, audio, 'swiftf0')];
  const shift = (off: number, octave: number) => item.notes.map((n) => ({ start: n.start + off, end: n.end + off, hz: n.hz * Math.pow(2, octave) }));
  let best = { offset: 0, octave: 0, count: -1 };
  for (const octave of [0, -1, 1, -2, 2]) {
    for (let k = 0; k <= 200; k++) {
      const ref = shift(k / 100, octave);
      const count = est.reduce((a, e) => a + prf(ref, e).matched, 0);
      if (count > best.count) best = { offset: k / 100, octave, count };
    }
  }
  return { notes: shift(best.offset, best.octave), offset: best.offset, octave: best.octave };
}

async function main(): Promise<void> {
  const items = allItems(root);
  if (!items.length) {
    console.error(`No evaluation data in ${root}. Fetch it first: npm run eval:fetch`);
    process.exit(2);
  }
  if (args.includes('--make-noisy')) {
    for (const c of conditions) for (const item of items) conditionWav(root, item, c);
    console.log(`Noisy audio is in ${join(root, 'noisy')}`);
    return;
  }
  const engines = ENGINES.filter((e) => wanted.includes(e.name));
  // Score-based references are lined up with their recordings first (the same fit for every engine and condition).
  const fits: Record<string, { offset: number; octave: number }> = {};
  for (const item of items.filter((i) => i.score)) {
    const f = await fitScore(item);
    item.notes = f.notes;
    fits[`${item.dataset}/${item.id}`] = { offset: f.offset, octave: f.octave };
  }
  const perItem: Record<string, unknown>[] = [];
  const acc = new Map<string, { item: Item; conp: number; conpoff: number; con: number; octave: number; seq: number; est: number; frame: FrameScores | null; ms: number }[]>();
  const agreement = new Map<string, number[]>();
  for (const condition of conditions) for (const item of items) {
    const audio = readWav(readFileSync(conditionWav(root, item, condition)));
    if (item.notes2 && condition.name === 'clean') {
      const a = agreement.get(item.dataset) ?? [];
      a.push(prf(item.notes, item.notes2).f1);
      agreement.set(item.dataset, a);
    }
    for (const engine of engines) {
      const out = await engine.run(item, audio, condition);
      if (!out) continue;
      const params = segmentParams(item.mode, engine.kind);
      const t = transcribe(out.frames, params);
      // Absolute pitch: the segmentation reports pitches with the singer's overall tuning offset removed.
      const est: TimedNote[] = t.notes.map((n) => ({ start: n.start, end: n.end, hz: midiToHz(n.pitch + t.tuningCents / 100) }));
      const ref = item.notes;
      const conp = prf(ref, est).f1;
      const conpoff = prf(ref, est, { offsetRatio: 0.2 }).f1;
      const con = prf(ref, est, { pitchTolCents: null }).f1;
      const octave = octaveErrors(ref, est).rate;
      // The note numbers the app writes (tuning offset removed, rounded) against the score's, in order.
      const seq = item.score ? sequenceF1(t.notes.map((n) => Math.round(n.pitch)), ref.map((n) => Math.round(hzToMidi(n.hz)))) : NaN;
      const frame = item.f0
        ? frameScores(item.f0, out.frames.map((f) => ({ t: f.t, hz: f.f0, voiced: f.f0 > 0 && f.conf >= params.confThreshold })))
        : null;
      const key = `${item.dataset}\t${condition.name}\t${engine.name}`;
      const list = acc.get(key) ?? [];
      list.push({ item, conp, conpoff, con, octave, seq, est: est.length, frame, ms: out.msPerFrame });
      acc.set(key, list);
      perItem.push({ dataset: item.dataset, condition: condition.name, id: item.id, engine: engine.name, refNotes: item.notes.length, estNotes: est.length, conp, conpoff, con, octave, seq, frame, tuningCents: t.tuningCents, est });
      if (verbose) {
        console.log(`${item.id.padEnd(14)} ${condition.name.padEnd(12)} ${engine.name.padEnd(8)} ref ${String(item.notes.length).padStart(3)} est ${String(est.length).padStart(3)}  COnP ${conp.toFixed(2)}  COn ${con.toFixed(2)}  RPA ${frame ? frame.rpa.toFixed(2) : '-'}`);
      }
    }
  }
  const rows: Row[] = [...acc.entries()].map(([key, list]) => {
    const [dataset, condition, engine] = key.split('\t');
    const frames = list.map((x) => x.frame).filter((f): f is FrameScores => !!f);
    const avgFrame = (k: keyof FrameScores) => mean(frames.map((f) => f[k]));
    return {
      dataset,
      condition,
      engine,
      items: list.length,
      refNotes: list.reduce((a, x) => a + x.item.notes.length, 0),
      estNotes: list.reduce((a, x) => a + x.est, 0),
      conp: mean(list.map((x) => x.conp)),
      conpoff: mean(list.map((x) => x.conpoff)),
      con: mean(list.map((x) => x.con)),
      octave: mean(list.map((x) => x.octave)),
      seq: mean(list.map((x) => x.seq)),
      frame: frames.length
        ? { rpa: avgFrame('rpa'), rca: avgFrame('rca'), vr: avgFrame('vr'), vfa: avgFrame('vfa'), oa: avgFrame('oa'), frames: frames.reduce((a, f) => a + f.frames, 0) }
        : null,
      msPerFrame: mean(list.map((x) => x.ms)),
    };
  });

  const pct = (x: number) => (Number.isNaN(x) ? '   -' : `${(x * 100).toFixed(1).padStart(5)}`);
  console.log('\nMeans over tracks. Notes: onset ±50 ms, pitch ±50 cents (COnP), plus offset (COnPOff), onset only (COn).');
  console.log('dataset    condition    engine    tracks  ref/est notes   COnP  COnPOff   COn  octave    seq    RPA    RCA     VR    VFA  ms/frame');
  for (const r of rows) {
    const f = r.frame;
    console.log(
      `${r.dataset.padEnd(10)} ${r.condition.padEnd(12)} ${r.engine.padEnd(8)} ${String(r.items).padStart(6)}  ${`${r.refNotes}/${r.estNotes}`.padStart(13)}  ${pct(r.conp)}  ${pct(r.conpoff)}  ${pct(r.con)}  ${pct(r.octave)}  ${pct(r.seq)}  ${f ? [f.rpa, f.rca, f.vr, f.vfa].map(pct).join('  ') : '     -      -      -      -'}  ${Number.isNaN(r.msPerFrame) ? '      -' : r.msPerFrame.toFixed(3).padStart(8)}`,
    );
  }
  for (const [dataset, f1s] of agreement) console.log(`${dataset.padEnd(10)} annotator 2 vs annotator 1: COnP ${pct(mean(f1s))}`);
  const out = arg('json', join(process.cwd(), 'e2e/out/eval-real.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ rows, agreement: Object.fromEntries([...agreement].map(([k, v]) => [k, mean(v)])), fits, items: perItem }, null, 1));
  console.log(`\nDetails: ${out}`);
}

void main();
