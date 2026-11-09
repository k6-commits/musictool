// Pitch frames -> notes.
// 1. keep confident, loud-enough frames  2. fix octave jumps  3. remove the singer's global tuning offset
// 4. split into notes on pitch changes, silences and re-articulations  5. merge / drop fragments.
import { HOP_SEC, type InputMode, type PitchFrame } from '../dsp/pitch';
import { hzToMidi } from '../music/notes';

export interface SegmentParams {
  confThreshold: number;
  /** Notes shorter than this (seconds) are merged into a neighbor or dropped. */
  minDuration: number;
  /** A pitch deviation (semitones) from the running note median that starts a new note... */
  splitSemitones: number;
  /** ...once it has lasted this many frames (keeps vibrato inside one note). */
  holdFrames: number;
  /** Quiet (silent) frames tolerated inside a note; more than this ends the note. */
  gapFrames: number;
  /** Loud but unpitched frames tolerated inside a note (breathiness, a cracked tone). */
  dropoutFrames: number;
}

export const SEGMENT_PARAMS: Record<InputMode, SegmentParams> = {
  sing: { confThreshold: 0.7, minDuration: 0.08, splitSemitones: 0.7, holdFrames: 3, gapFrames: 2, dropoutFrames: 6 },
  hum: { confThreshold: 0.6, minDuration: 0.1, splitSemitones: 0.7, holdFrames: 3, gapFrames: 3, dropoutFrames: 6 },
  whistle: { confThreshold: 0.7, minDuration: 0.06, splitSemitones: 0.7, holdFrames: 2, gapFrames: 2, dropoutFrames: 4 },
};

export type FlagReason = 'ambiguous' | 'unstable' | 'short';

export interface RawNote {
  id: string;
  /** Seconds from the start of the take. */
  start: number;
  end: number;
  /** Fractional MIDI pitch after removing the global tuning offset. */
  pitch: number;
  conf: number;
  velocity: number;
  flagged: boolean;
  reason?: FlagReason;
}

export interface Transcription {
  notes: RawNote[];
  /** Tuning offset that was removed, in cents (+ = the singer was sharp). */
  tuningCents: number;
  voicedRatio: number;
  /** Tuning-corrected pitch per frame (NaN = unvoiced), for drawing the voice curve. */
  curve: Float32Array;
  frameTimes: Float32Array;
}

interface Segment {
  s: number;
  e: number;
  /** First frame after an onset glide; the note's pitch is measured from here. */
  settle: number;
  /** Started by a re-articulation (level dip) or after a silence: never merge into the previous note. */
  onset: boolean;
}

export function transcribe(frames: PitchFrame[], params: SegmentParams): Transcription {
  const n = frames.length;
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) db[i] = 20 * Math.log10(frames[i].rms + 1e-9);
  const { gate, loudDb } = levels(db);

  const raw = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    if (f.f0 > 0 && f.conf >= params.confThreshold && db[i] >= gate) raw[i] = hzToMidi(f.f0);
  }

  // Octave jumps: fold a frame into the octave of its neighborhood, drop it if it still disagrees.
  const fixed = new Float64Array(raw);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(raw[i])) continue;
    const med = localMedian(raw, i, 4);
    if (Number.isNaN(med)) continue;
    let v = raw[i];
    if (Math.abs(v - med) > 6) v += 12 * Math.round((med - v) / 12);
    fixed[i] = Math.abs(v - med) > 3 ? NaN : v;
  }

  // Global tuning offset: circular mean of the distance to the nearest semitone over steady frames.
  let sx = 0;
  let sy = 0;
  let steady = 0;
  for (let i = 1; i < n; i++) {
    const a = fixed[i - 1];
    const b = fixed[i];
    if (Number.isNaN(a) || Number.isNaN(b) || Math.abs(b - a) > 0.12) continue;
    const frac = b - Math.round(b);
    sx += Math.cos(2 * Math.PI * frac);
    sy += Math.sin(2 * Math.PI * frac);
    steady++;
  }
  let offset = 0;
  if (steady >= 10) {
    offset = Math.atan2(sy, sx) / (2 * Math.PI);
    if (Math.abs(offset) < 0.06) offset = 0;
  }

  const pc = new Float64Array(n);
  for (let i = 0; i < n; i++) pc[i] = fixed[i] - offset;
  const smooth = new Float64Array(pc);
  for (let i = 1; i < n - 1; i++) {
    if (Number.isNaN(pc[i - 1]) || Number.isNaN(pc[i]) || Number.isNaN(pc[i + 1])) continue;
    smooth[i] = median3(pc[i - 1], pc[i], pc[i + 1]);
  }

  const loud = new Uint8Array(n);
  for (let i = 0; i < n; i++) loud[i] = db[i] >= gate ? 1 : 0;
  const segments = segmentFrames(smooth, frames, loud, params);
  let notes = segments
    .map((seg) => buildNote(seg, smooth, frames, db, loudDb, params))
    .filter((x): x is RawNote & { onset: boolean } => x !== null);
  notes = mergeAndClean(notes, params);

  let voiced = 0;
  for (let i = 0; i < n; i++) if (!Number.isNaN(smooth[i])) voiced++;
  const frameTimes = new Float32Array(n);
  for (let i = 0; i < n; i++) frameTimes[i] = frames[i].t;

  return {
    notes: notes.map((note, i) => {
      const { onset: _onset, ...rest } = note;
      return { ...rest, id: `n${i + 1}` };
    }),
    tuningCents: Math.round(offset * 100),
    voicedRatio: n ? voiced / n : 0,
    curve: Float32Array.from(smooth),
    frameTimes,
  };
}

/**
 * Level gate and reference level from the take itself (capture has no automatic gain, so absolute
 * levels depend on the mic). The gate sits 12 dB over the quietest frames, but never closer than 20 dB
 * to the loud level: in a take sung without pauses the quietest frames are the voice itself.
 */
export function levels(db: Float32Array): { gate: number; loudDb: number } {
  const n = db.length;
  if (!n) return { gate: -75, loudDb: -20 };
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(n * 0.1)];
  const loudDb = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
  return { gate: Math.max(-75, Math.min(floor + 12, loudDb - 20)), loudDb };
}

/** A note may begin with a glide (scoop or fall) into its pitch for up to this many frames (~220 ms). */
const GLIDE_FRAMES = 14;

function segmentFrames(pc: Float64Array, frames: PitchFrame[], loud: Uint8Array, p: SegmentParams): Segment[] {
  const n = pc.length;
  const segments: Segment[] = [];
  let i = 0;
  let onsetFlag = true;
  while (i < n) {
    if (Number.isNaN(pc[i])) {
      i++;
      if (!loud[i - 1]) onsetFlag = true;
      continue;
    }
    const s = i;
    let settle = i;
    let glided = false;
    let vals: number[] = [pc[i]];
    let lastVoiced = i;
    // Re-articulation of the same pitch: the level dips well below its peak, then rises again.
    // The attack ramp never triggers this because the level only grows there.
    let peak = frames[i].rms;
    let trough = peak;
    let troughAt = i;
    let deviating = 0;
    let quiet = 0;
    let dropout = 0;
    let next = -1;
    let nextOnset = false;
    let j = i + 1;
    for (; j < n; j++) {
      if (Number.isNaN(pc[j])) {
        if (loud[j]) dropout++;
        else quiet++;
        if (quiet > p.gapFrames || dropout > p.dropoutFrames) break;
        continue;
      }
      quiet = 0;
      dropout = 0;
      // Reference pitch: median of the last ~250 ms, longer than one vibrato cycle.
      const ref = medianOfLast(vals, 16);
      if (Math.abs(pc[j] - ref) > p.splitSemitones) {
        deviating++;
        if (deviating >= p.holdFrames) {
          const first = j - deviating + 1;
          if (first - s <= GLIDE_FRAMES && isGlide(pc, s, first, Math.sign(pc[j] - ref))) {
            // The note started with a scoop or a fall into its pitch: keep the onset, measure from here.
            // A glide into a note is an attack, so it never merges into a previous note of the same pitch.
            settle = first;
            glided = true;
            vals = [];
            for (let k = first; k <= j; k++) if (!Number.isNaN(pc[k])) vals.push(pc[k]);
            deviating = 0;
            lastVoiced = j;
            continue;
          }
          next = first;
          break;
        }
        continue;
      }
      deviating = 0;
      const level = frames[j].rms;
      if (trough < peak * 0.6 && level > trough * 1.7 && level > peak * 0.5 && troughAt > s + 2) {
        lastVoiced = troughAt;
        next = troughAt + 1;
        nextOnset = true;
        break;
      }
      if (level > peak) {
        peak = level;
        trough = level;
        troughAt = j;
      } else if (level < trough) {
        trough = level;
        troughAt = j;
      }
      vals.push(pc[j]);
      lastVoiced = j;
    }
    segments.push({ s, e: lastVoiced, settle: Math.min(settle, lastVoiced), onset: onsetFlag || glided });
    if (next >= 0) {
      i = next;
      onsetFlag = nextOnset;
    } else {
      // Ended by silence (or the end of the take): whatever comes next is a new attack.
      i = j;
      onsetFlag = quiet > p.gapFrames;
    }
  }
  return segments;
}

/** Frames [from, to) move steadily in direction `dir` (a scoop up into a note, or a fall down into it). */
function isGlide(pc: Float64Array, from: number, to: number, dir: number): boolean {
  let prev = NaN;
  let firstVal = NaN;
  let steps = 0;
  let moving = 0;
  for (let k = from; k < to; k++) {
    const v = pc[k];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(firstVal)) firstVal = v;
    else {
      steps++;
      if ((v - prev) * dir > 0.005) moving++;
    }
    prev = v;
  }
  return steps >= 1 && moving / steps >= 0.6 && (prev - firstVal) * dir >= 0.25;
}

function buildNote(
  seg: Segment,
  pc: Float64Array,
  frames: PitchFrame[],
  db: Float32Array,
  loudDb: number,
  p: SegmentParams,
): (RawNote & { onset: boolean }) | null {
  const vals: number[] = [];
  let confSum = 0;
  let voicedCount = 0;
  let maxDb = -180;
  for (let k = seg.s; k <= seg.e; k++) {
    if (Number.isNaN(pc[k])) continue;
    if (k >= seg.settle) vals.push(pc[k]);
    confSum += frames[k].conf;
    voicedCount++;
    maxDb = Math.max(maxDb, db[k]);
  }
  if (!vals.length) return null;
  const len = vals.length;
  const core = len >= 5 ? vals.slice(Math.floor(len * 0.2), Math.ceil(len * 0.8)) : vals;
  const pitch = median(core);
  // Stability ignores vibrato: average over ~150 ms (about one vibrato cycle) before measuring the spread.
  const spread = stdev(core.length >= 12 ? movingAverage(core, 9) : core);
  const start = Math.max(0, frames[seg.s].t - HOP_SEC / 2);
  const end = frames[seg.e].t + HOP_SEC / 2;
  const conf = (confSum / voicedCount) * clamp(1 - spread / 0.5, 0.2, 1);
  // Velocity follows the note's level relative to the loud parts of the take, not the mic gain.
  const velocity = Math.round(clamp(100 + (maxDb - loudDb) * 2.5, 20, 127));
  const note: RawNote & { onset: boolean } = {
    id: '',
    start,
    end,
    pitch,
    conf,
    velocity,
    flagged: false,
    onset: seg.onset,
  };
  return classify(note, p);
}

function classify<T extends RawNote>(note: T, p: SegmentParams): T {
  const frac = Math.abs(note.pitch - Math.round(note.pitch));
  let reason: FlagReason | undefined;
  if (frac > 0.35) reason = 'ambiguous';
  else if (note.conf < 0.55) reason = 'unstable';
  else if (note.end - note.start < p.minDuration * 1.5) reason = 'short';
  return { ...note, flagged: reason !== undefined, reason };
}

function mergeAndClean(
  input: (RawNote & { onset: boolean })[],
  p: SegmentParams,
): (RawNote & { onset: boolean })[] {
  // Same pitch with a tiny gap and no re-articulation: one note.
  const merged: (RawNote & { onset: boolean })[] = [];
  for (const note of input) {
    const prev = merged[merged.length - 1];
    if (prev && !note.onset && note.start - prev.end < 0.05 && Math.round(prev.pitch) === Math.round(note.pitch)) {
      const da = prev.end - prev.start;
      const dn = note.end - note.start;
      merged[merged.length - 1] = classify(
        {
          ...prev,
          end: note.end,
          pitch: (prev.pitch * da + note.pitch * dn) / (da + dn),
          conf: Math.min(prev.conf, note.conf),
          velocity: Math.max(prev.velocity, note.velocity),
        },
        p,
      );
    } else {
      merged.push(note);
    }
  }
  // Fragments: absorb into a close neighbor of nearly the same pitch, otherwise drop.
  const out: (RawNote & { onset: boolean })[] = [];
  for (let i = 0; i < merged.length; i++) {
    const note = merged[i];
    if (note.end - note.start >= p.minDuration) {
      out.push(note);
      continue;
    }
    const prev = out[out.length - 1];
    const next = merged[i + 1];
    if (prev && note.start - prev.end < 0.05 && Math.abs(Math.round(prev.pitch) - Math.round(note.pitch)) <= 1) {
      out[out.length - 1] = { ...prev, end: note.end };
    } else if (next && next.start - note.end < 0.05 && Math.abs(Math.round(next.pitch) - Math.round(note.pitch)) <= 1) {
      merged[i + 1] = { ...next, start: note.start };
    }
  }
  return out;
}

function median(values: number[]): number {
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const scratch = new Float64Array(32);

/** Median of the last `count` values (count <= 32) without allocating: insertion sort into a scratch buffer. */
function medianOfLast(values: number[], count: number): number {
  const n = Math.min(count, values.length);
  const off = values.length - n;
  for (let i = 0; i < n; i++) {
    const v = values[off + i];
    let k = i - 1;
    while (k >= 0 && scratch[k] > v) {
      scratch[k + 1] = scratch[k];
      k--;
    }
    scratch[k + 1] = v;
  }
  const m = n >> 1;
  return n % 2 ? scratch[m] : (scratch[m - 1] + scratch[m]) / 2;
}

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

const windowBuf: number[] = [];

function localMedian(values: Float64Array, i: number, radius: number): number {
  windowBuf.length = 0;
  for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++) {
    if (!Number.isNaN(values[k])) windowBuf.push(values[k]);
  }
  return windowBuf.length >= 3 ? medianOfLast(windowBuf, windowBuf.length) : NaN;
}

function movingAverage(values: number[], width: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= width) sum -= values[i - width];
    if (i >= width - 1) out.push(sum / width);
  }
  return out;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
