// Accuracy sweep on synthetic singing. This measures the DSP pipeline under controlled conditions
// (detune, noise, vibrato, tempo, range); it is not a substitute for testing with real voices.
import { analyzePitch, type InputMode } from '../src/dsp/pitch';
import { scoreNotes } from '../src/transcribe/score';
import { SEGMENT_PARAMS, transcribe } from '../src/transcribe/segment';
import { sing, type SungNote } from '../src/synth/voice';

interface Case {
  name: string;
  base: number;
  bpm: number;
  detune?: number;
  noiseDb?: number;
  vibrato?: number;
  scoop?: [cents: number, seconds: number];
  /** Overall level (1 = about -14 dBFS RMS). */
  gain?: number;
  /** Notes back to back with no lead-in silence. */
  legato?: boolean;
  mode?: InputMode;
}

const PATTERN: [number, number, number][] = [
  [0, 0, 1], [2, 1, 0.5], [4, 1.5, 0.5], [5, 2, 1], [7, 3, 1], [9, 4, 0.5], [7, 4.5, 0.5], [5, 5, 0.5], [4, 5.5, 0.5],
  [2, 6, 1], [0, 7, 0.5], [0, 7.5, 0.5], [-1, 8, 1], [0, 9, 2], [4, 11, 0.5], [7, 11.5, 0.5], [12, 12, 2],
];

function melody(base: number, bpm: number, legato = false): SungNote[] {
  const spb = 60 / bpm;
  const lead = legato ? 0 : 0.3;
  const fill = legato ? 1 : 0.92;
  return PATTERN.map(([d, b, len]) => ({ pitch: base + d, start: lead + b * spb, dur: len * spb * fill }));
}

const CASES: Case[] = [
  { name: 'tenor, clean', base: 55, bpm: 96 },
  { name: 'bass', base: 43, bpm: 96, noiseDb: -40 },
  { name: 'alto', base: 62, bpm: 96, noiseDb: -40 },
  { name: 'soprano', base: 69, bpm: 96, noiseDb: -40 },
  { name: 'sharp +35 cents', base: 57, bpm: 96, detune: 35, noiseDb: -40 },
  { name: 'flat -40 cents', base: 57, bpm: 96, detune: -40, noiseDb: -40 },
  { name: 'wide vibrato (±60 c)', base: 57, bpm: 96, vibrato: 60, noiseDb: -40 },
  { name: 'noisy room (-25 dB)', base: 57, bpm: 96, noiseDb: -25 },
  { name: 'very noisy (-18 dB)', base: 57, bpm: 96, noiseDb: -18 },
  { name: 'fast (150 BPM)', base: 57, bpm: 150, noiseDb: -40 },
  { name: 'deep scoops (150 c / 100 ms)', base: 57, bpm: 96, scoop: [150, 0.1], noiseDb: -40 },
  { name: 'deeper scoops (200 c / 150 ms)', base: 57, bpm: 96, scoop: [200, 0.15], noiseDb: -40 },
  { name: 'quiet, no pauses (-40 dBFS)', base: 57, bpm: 96, gain: 0.05, legato: true },
  { name: 'humming', base: 52, bpm: 90, noiseDb: -35, mode: 'hum' },
  { name: 'whistling', base: 79, bpm: 110, vibrato: 10, noiseDb: -40, mode: 'whistle' },
];

const rows: string[][] = [['case', 'notes', 'F1', 'onset err', 'flagged', 'ms/frame']];
let sum = 0;
for (const c of CASES) {
  const ref = melody(c.base, c.bpm, c.legato);
  const audio = sing(ref, {
    sampleRate: 48000,
    detuneCents: c.detune,
    noiseDb: c.noiseDb,
    vibratoCents: c.vibrato,
    scoopCents: c.scoop?.[0],
    scoopSec: c.scoop?.[1],
    gain: c.gain,
    seed: 11,
  });
  const mode = c.mode ?? 'sing';
  const { frames, stats } = await analyzePitch(audio, 48000, mode);
  const t = transcribe(frames, SEGMENT_PARAMS[mode]);
  const s = scoreNotes(t.notes, ref);
  const errs: number[] = [];
  for (const r of ref) {
    const d = t.notes.find((n) => Math.round(n.pitch) === r.pitch && Math.abs(n.start - r.start) < 0.07);
    if (d) errs.push(Math.abs(d.start - r.start) * 1000);
  }
  const mae = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN;
  sum += s.f1;
  rows.push([
    c.name,
    `${s.matched}/${s.reference} (+${s.detected - s.matched})`,
    s.f1.toFixed(2),
    `${mae.toFixed(0)} ms`,
    String(t.notes.filter((n) => n.flagged).length),
    stats.millisPerFrame.toFixed(2),
  ]);
}
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => [...r[i]].length)));
for (const r of rows) console.log(r.map((v, i) => (i === 0 ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join('  '));
console.log(`\nmean F1 ${(sum / CASES.length).toFixed(3)} over ${CASES.length} cases (synthetic voices)`);
