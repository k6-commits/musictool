import { describe, expect, it } from 'vitest';
import { arrange, quantizeValue } from '../src/transcribe/arrange';
import type { RawNote } from '../src/transcribe/segment';
import { estimateTempo } from '../src/transcribe/tempo';

const raw = (id: string, pitch: number, start: number, end: number, flagged = false): RawNote => ({
  id,
  pitch,
  start,
  end,
  conf: 0.9,
  velocity: 90,
  flagged,
  reason: flagged ? 'ambiguous' : undefined,
});

const base = { bpm: 120, key: { tonic: 0, mode: 'major' as const }, snap: 0.6, quant: 1, grid: 0.5, fixed: {}, deleted: [] as string[] };

describe('quantize', () => {
  it('moves values toward the grid by strength', () => {
    expect(quantizeValue(1.2, 0.5, 0)).toBeCloseTo(1.2);
    expect(quantizeValue(1.2, 0.5, 1)).toBeCloseTo(1.0);
    expect(quantizeValue(1.2, 0.5, 0.5)).toBeCloseTo(1.1);
  });
});

describe('arrange', () => {
  it('converts seconds to beats, snaps pitch and quantizes', () => {
    // 120 BPM: 0.5 s per beat.
    const out = arrange([raw('a', 64.2, 0.02, 0.48), raw('b', 65.6, 0.52, 0.74)], base);
    expect(out.map((n) => [n.pitch, n.startBeat, n.endBeat])).toEqual([
      [64, 0, 1],
      [65, 1, 1.5],
    ]);
  });

  it('applies hand-picked pitches, deletions and clears the flag of fixed notes', () => {
    const notes = [raw('a', 64, 0, 0.5), raw('b', 65.5, 0.5, 1, true), raw('c', 67, 1, 1.5)];
    const out = arrange(notes, { ...base, fixed: { b: 66 }, deleted: ['c'] });
    expect(out.map((n) => [n.id, n.pitch, n.flagged])).toEqual([
      ['a', 64, false],
      ['b', 66, false],
    ]);
  });

  it('keeps the line monophonic', () => {
    const out = arrange([raw('a', 60, 0, 0.7), raw('b', 62, 0.5, 1)], { ...base, quant: 0 });
    expect(out[0].endBeat).toBeLessThanOrEqual(out[1].startBeat);
  });
});

describe('tempo guess', () => {
  it.each([84, 100, 128])('finds %s BPM from a sung rhythm', (bpm) => {
    const beats = [0, 1, 1.5, 2, 3, 4, 4.5, 5, 6, 7, 7.5, 8];
    let seed = 5;
    const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03;
    const onsets = beats.map((b) => 0.4 + (b * 60) / bpm + jitter());
    const g = estimateTempo(onsets);
    expect(g).not.toBeNull();
    expect(Math.abs(g!.bpm - bpm)).toBeLessThanOrEqual(2);
    expect(g!.zero).toBeCloseTo(onsets[0], 6);
  });

  it('needs a few notes', () => {
    expect(estimateTempo([0.1, 0.6])).toBeNull();
  });
});
