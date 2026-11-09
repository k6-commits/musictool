import { describe, expect, it } from 'vitest';
import { analyzePitch } from '../src/dsp/pitch';
import { SEGMENT_PARAMS, transcribe } from '../src/transcribe/segment';
import { SAMPLE_MELODY, sing, type SungNote } from '../src/synth/voice';
import { scoreNotes } from '../src/transcribe/score';

async function run(notes: SungNote[], opts: Parameters<typeof sing>[1], mode: 'sing' | 'hum' | 'whistle' = 'sing') {
  const audio = sing(notes, opts);
  const { frames } = await analyzePitch(audio, opts.sampleRate, mode);
  return transcribe(frames, SEGMENT_PARAMS[mode]);
}

describe('pipeline on synthetic singing', () => {
  it('transcribes the sample melody', async () => {
    const t = await run(SAMPLE_MELODY, { sampleRate: 48000, detuneCents: 12, noiseDb: -38 });
    const s = scoreNotes(t.notes, SAMPLE_MELODY);
    expect(s.f1).toBeGreaterThanOrEqual(0.9);
    expect(Math.abs(t.tuningCents - 12)).toBeLessThanOrEqual(8);
  });

  it('flags the note sung between two pitches', async () => {
    const t = await run(SAMPLE_MELODY, { sampleRate: 48000, detuneCents: 12, noiseDb: -38 });
    // F4 sung 55 cents sharp (+12 global, removed by tuning) sits between F and F#.
    const f = t.notes.find((n) => Math.abs(n.start - SAMPLE_MELODY[8].start) < 0.08);
    expect(f?.flagged).toBe(true);
  });

  it('keeps repeated same-pitch notes separate', async () => {
    const notes: SungNote[] = [
      { pitch: 60, start: 0.1, dur: 0.35 },
      { pitch: 60, start: 0.5, dur: 0.35 },
      { pitch: 60, start: 0.9, dur: 0.35 },
      { pitch: 62, start: 1.3, dur: 0.5 },
    ];
    const t = await run(notes, { sampleRate: 44100 });
    expect(t.notes.length).toBe(4);
  });

  it('handles a low male voice and a high female voice', async () => {
    for (const base of [43, 72]) {
      const notes: SungNote[] = [0, 2, 4, 5, 7, 5, 4, 2].map((d, i) => ({ pitch: base + d, start: 0.1 + i * 0.4, dur: 0.36 }));
      const t = await run(notes, { sampleRate: 48000, noiseDb: -35 });
      const s = scoreNotes(t.notes, notes);
      expect(s.f1).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('works for whistling', async () => {
    const notes: SungNote[] = [79, 81, 83, 84, 86].map((p, i) => ({ pitch: p, start: 0.1 + i * 0.3, dur: 0.26 }));
    const t = await run(notes, { sampleRate: 48000, vibratoCents: 10 }, 'whistle');
    expect(scoreNotes(t.notes, notes).f1).toBeGreaterThanOrEqual(0.85);
  });

  it('returns nothing for silence', async () => {
    const t = transcribe((await analyzePitch(new Float32Array(48000), 48000, 'sing')).frames, SEGMENT_PARAMS.sing);
    expect(t.notes.length).toBe(0);
  });

  it('keeps a deep scoop inside the note it leads into', async () => {
    for (const [cents, sec] of [
      [150, 0.1],
      [200, 0.15],
    ]) {
      const t = await run(SAMPLE_MELODY, { sampleRate: 48000, scoopCents: cents, scoopSec: sec, noiseDb: -40 });
      const s = scoreNotes(t.notes, SAMPLE_MELODY);
      expect(s.f1, `${cents} cents over ${sec} s`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('finds notes in a quiet take sung without pauses', async () => {
    const notes: SungNote[] = [60, 62, 64, 65, 67, 65, 64, 62, 60, 62].map((p, i) => ({ pitch: p, start: i * 0.5, dur: 0.5 }));
    const audio = sing(notes, { sampleRate: 48000, gain: 0.05, length: 5 }); // about -40 dBFS, no silence at all
    const t = transcribe((await analyzePitch(audio, 48000, 'sing')).frames, SEGMENT_PARAMS.sing);
    expect(scoreNotes(t.notes, notes).recall).toBeGreaterThanOrEqual(0.9);
  });

  it('gives the same velocities whatever the mic gain', async () => {
    const loud = await run(SAMPLE_MELODY, { sampleRate: 48000, noiseDb: -40 });
    const soft = await run(SAMPLE_MELODY, { sampleRate: 48000, noiseDb: -40, gain: 0.1 });
    expect(soft.notes.length).toBe(loud.notes.length);
    soft.notes.forEach((n, i) => expect(Math.abs(n.velocity - loud.notes[i].velocity)).toBeLessThanOrEqual(3));
  });

  it('splits repeated notes at voiced dips but not at tremolo', async () => {
    const sr = 48000;
    const long = sing([{ pitch: 60, start: 0.1, dur: 2.1 }], { sampleRate: sr, vibratoCents: 0 });
    const dipped = long.map((v, i) => {
      const t = i / sr;
      let g = 1;
      for (const at of [0.6, 1.1, 1.6]) g = Math.min(g, 1 - 0.6 * Math.max(0, 1 - Math.abs(t - at) / 0.05)); // down to 40 %
      return v * g;
    });
    const a = transcribe((await analyzePitch(dipped, sr, 'sing')).frames, SEGMENT_PARAMS.sing);
    expect(a.notes.length).toBe(4);
    const tremolo = long.map((v, i) => v * (1 + 0.25 * Math.sin(2 * Math.PI * 5.5 * (i / sr)))); // about ±2 dB
    const b = transcribe((await analyzePitch(tremolo, sr, 'sing')).frames, SEGMENT_PARAMS.sing);
    expect(b.notes.length).toBe(1);
  });
});
