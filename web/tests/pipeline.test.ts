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
    console.log('sample', s, t.tuningCents, t.notes.map((n) => `${n.pitch.toFixed(2)}@${n.start.toFixed(2)}-${n.end.toFixed(2)}${n.flagged ? '!' + n.reason : ''}`).join(' '));
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
      console.log('base', base, s);
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
});
