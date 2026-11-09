// Raw notes (seconds, fractional pitch) -> editable notes on the beat grid.
// Snapping and quantizing are non-destructive: the raw notes are never changed.
import { snapPitch, type Key } from '../music/scale';
import type { FlagReason, RawNote } from './segment';

export interface ArrangeOptions {
  bpm: number;
  key: Key;
  /** 0..1, see snapPitch. */
  snap: number;
  /** 0..1, how far note edges move toward the grid. */
  quant: number;
  /** Grid size in beats (0.5 = eighth notes). */
  grid: number;
  /** Pitches the user picked by hand, by note id. */
  fixed: Record<string, number>;
  deleted: Iterable<string>;
}

export interface ArrangedNote {
  id: string;
  pitch: number;
  startBeat: number;
  endBeat: number;
  velocity: number;
  flagged: boolean;
  reason?: FlagReason;
  raw: RawNote;
}

export function secondsToBeats(seconds: number, bpm: number): number {
  return (seconds * bpm) / 60;
}

export function quantizeValue(value: number, grid: number, strength: number): number {
  return value + strength * (Math.round(value / grid) * grid - value);
}

/** Shortest note the arrangement produces, in beats. */
const MIN_BEATS = 1 / 16;

export function arrange(notes: RawNote[], o: ArrangeOptions): ArrangedNote[] {
  const deleted = new Set(o.deleted);
  const out: ArrangedNote[] = notes
    .filter((n) => !deleted.has(n.id))
    .map((n) => {
      const fixedPitch = o.fixed[n.id];
      const pitch = fixedPitch ?? snapPitch(n.pitch, o.key, o.snap);
      const rawStart = secondsToBeats(n.start, o.bpm);
      const rawEnd = secondsToBeats(n.end, o.bpm);
      const start = Math.max(0, quantizeValue(rawStart, o.grid, o.quant));
      let end = quantizeValue(rawEnd, o.grid, o.quant);
      const minLen = Math.max(1 / 16, Math.min(o.grid / 2, rawEnd - rawStart));
      if (end - start < minLen) end = start + minLen;
      return {
        id: n.id,
        pitch,
        startBeat: start,
        endBeat: end,
        velocity: n.velocity,
        flagged: n.flagged && fixedPitch === undefined,
        reason: n.reason,
        raw: n,
      };
    })
    .sort((a, b) => a.startBeat - b.startBeat || a.raw.start - b.raw.start);
  // Monophonic line: no two notes start together and no note overlaps the next.
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    if (cur.startBeat < prev.startBeat + MIN_BEATS) {
      // Quantizing pulled two notes onto one slot: keep this one where it was sung (or just after the other).
      const len = cur.endBeat - cur.startBeat;
      cur.startBeat = Math.max(prev.startBeat + MIN_BEATS, secondsToBeats(cur.raw.start, o.bpm));
      cur.endBeat = Math.max(cur.endBeat, cur.startBeat + Math.max(MIN_BEATS, Math.min(len, o.grid)));
    }
  }
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].endBeat > out[i + 1].startBeat) out[i].endBeat = out[i + 1].startBeat;
  }
  return out;
}
