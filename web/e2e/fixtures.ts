// Test audio for the end-to-end run: a synthetic singer rendered to WAV.
import { encodeWav } from '../src/audio/wav';
import { fromBeats, sing } from '../src/synth/voice';

export const MIC_BPM = 100;
/** C D E F G F E D C over two bars at 100 BPM (MIDI 60..67). */
export const MIC_MELODY: [number, number, number][] = [
  [60, 0, 0.9],
  [62, 1, 0.45],
  [64, 1.5, 0.45],
  [65, 2, 0.9],
  [67, 3, 0.9],
  [65, 4, 0.45],
  [64, 4.5, 0.45],
  [62, 5, 0.9],
  [60, 6, 1.8],
];

/** The melody after `leadSeconds` of silence (time for the count-in). */
export function micWav(sampleRate: number, leadSeconds: number): Uint8Array {
  const notes = fromBeats(MIC_BPM, MIC_MELODY).map((n) => ({ ...n, start: n.start + leadSeconds }));
  return encodeWav(sing(notes, { sampleRate, detuneCents: -18, noiseDb: -40 }), sampleRate);
}

export const FILE_BPM = 112;
/** A minor phrase: A C D E D C A G A (MIDI 57..64), as if recorded on a phone without a click. */
export const FILE_MELODY: [number, number, number][] = [
  [57, 0, 0.9],
  [60, 1, 0.45],
  [62, 1.5, 0.45],
  [64, 2, 1.4],
  [62, 3.5, 0.45],
  [60, 4, 0.9],
  [57, 5, 0.45],
  [55, 5.5, 0.45],
  [57, 6, 1.8],
];

export function fileWav(sampleRate: number): Uint8Array {
  const notes = fromBeats(FILE_BPM, FILE_MELODY).map((n) => ({ ...n, start: n.start + 0.73 }));
  return encodeWav(sing(notes, { sampleRate, detuneCents: 20, noiseDb: -34, seed: 3 }), sampleRate);
}
