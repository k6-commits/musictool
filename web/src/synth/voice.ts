// A simple synthetic singer: harmonic tone with onset scoop, vibrato, envelope and breath noise.
// Used for the built-in sample and as ground truth in tests.
import { midiToHz } from '../music/notes';

export interface SungNote {
  /** Intended MIDI pitch. */
  pitch: number;
  /** Seconds. */
  start: number;
  dur: number;
  /** How far off the singer is, in cents. */
  cents?: number;
}

export interface SingOptions {
  sampleRate: number;
  /** Total length in seconds (defaults to the last note end + 0.5 s). */
  length?: number;
  /** Global detune in cents, added to every note. */
  detuneCents?: number;
  /** Breath/room noise level relative to the voice peak, in dB. */
  noiseDb?: number;
  vibratoCents?: number;
  /** Depth (cents below the note) and length of the scoop into each note. Default 35 cents over 60 ms. */
  scoopCents?: number;
  scoopSec?: number;
  /** Overall level, applied before the noise (1 = about -14 dBFS RMS). */
  gain?: number;
  /** Notes that touch (one ends where the next starts) are slurred without a break in level; a repeated pitch is still re-articulated. */
  legato?: boolean;
  /** Amplitude vibrato depth in dB (±), at 5.5 Hz. */
  tremoloDb?: number;
  seed?: number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
}

export function sing(notes: SungNote[], o: SingOptions): Float32Array {
  const sr = o.sampleRate;
  const lastEnd = notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
  const length = Math.ceil((o.length ?? lastEnd + 0.5) * sr);
  const out = new Float32Array(length);
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const vib = o.vibratoCents ?? 25;
  const scoop = o.scoopCents ?? 35;
  const scoopSec = o.scoopSec ?? 0.06;
  const gain = o.gain ?? 1;
  let phase = 0;
  let idx = 0;

  for (let i = 0; i < length; i++) {
    const t = i / sr;
    while (idx < sorted.length - 1 && t >= sorted[idx].start + sorted[idx].dur) idx++;
    const note = sorted[idx];
    if (!note || t < note.start || t > note.start + note.dur) continue;
    const k = t - note.start;
    let cents = (note.cents ?? 0) + (o.detuneCents ?? 0);
    if (k < scoopSec) cents -= scoop * (1 - k / scoopSec); // scoop into the note
    if (note.dur > 0.5 && k > 0.2) cents += vib * Math.sin(2 * Math.PI * 5.5 * (k - 0.2));
    const f0 = midiToHz(note.pitch + cents / 100);
    phase += (2 * Math.PI * f0) / sr;
    const prev = sorted[idx - 1];
    const next = sorted[idx + 1];
    const joinedBefore = o.legato && prev && prev.pitch !== note.pitch && Math.abs(prev.start + prev.dur - note.start) < 0.005;
    const joinedAfter = o.legato && next && next.pitch !== note.pitch && Math.abs(note.start + note.dur - next.start) < 0.005;
    const attack = joinedBefore ? 1 : Math.min(1, k / 0.04);
    const release = joinedAfter ? 1 : Math.min(1, (note.dur - k) / 0.05);
    let env = Math.max(0, Math.min(attack, release));
    if (o.tremoloDb) env *= Math.pow(10, (o.tremoloDb / 20) * Math.sin(2 * Math.PI * 5.5 * t));
    let s = 0;
    for (let h = 1; h <= 8; h++) {
      const fh = f0 * h;
      if (fh > sr / 2.2) break;
      const formant = 1 + 0.8 * Math.exp(-((fh - 750) ** 2) / (2 * 280 ** 2)) + 0.5 * Math.exp(-((fh - 1150) ** 2) / (2 * 300 ** 2));
      s += (formant / h) * Math.sin(h * phase);
    }
    out[i] = 0.18 * gain * env * s;
  }

  if (o.noiseDb !== undefined) {
    let peak = 0;
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]));
    const amp = peak * Math.pow(10, o.noiseDb / 20);
    const rand = rng(o.seed ?? 7);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      lp = 0.7 * lp + 0.3 * rand();
      out[i] += amp * lp;
    }
  }
  return out;
}

/** Notes given in beats at a tempo -> seconds. */
export function fromBeats(
  bpm: number,
  rows: [pitch: number, startBeat: number, beats: number, cents?: number][],
): SungNote[] {
  const spb = 60 / bpm;
  return rows.map(([pitch, start, beats, cents]) => ({ pitch, start: start * spb, dur: beats * spb, cents }));
}

/** The melody from the design mocks (E D C D E | G A G F E D C at 96 BPM), sung a little sharp,
 * with one note (F4) sung between F and F#. */
export const SAMPLE_BPM = 96;
export const SAMPLE_MELODY = fromBeats(SAMPLE_BPM, [
  [64, 0.06, 0.92],
  [62, 1.02, 0.46],
  [60, 1.55, 0.42],
  [62, 2.08, 0.95, 25],
  [64, 3.1, 0.85],
  [67, 4.03, 0.45],
  [69, 4.52, 0.44],
  [67, 5.04, 0.9],
  [65, 6.02, 0.44, 45],
  [64, 6.5, 0.45],
  [62, 7.02, 0.44],
  [60, 7.52, 0.9],
]);

export function makeSample(sampleRate: number): Float32Array {
  return sing(SAMPLE_MELODY, { sampleRate, detuneCents: 12, noiseDb: -38, length: 5.8 });
}
