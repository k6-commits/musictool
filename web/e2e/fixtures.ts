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

/** A long take (minutes) to check that analysis and the roll scale with length. */
export function longWav(sampleRate: number, seconds: number): Uint8Array {
  const notes = [];
  for (let t = 0.3, i = 0; t < seconds - 1; t += 0.5, i++) notes.push({ pitch: 55 + ((i * 5) % 12), start: t, dur: 0.42 });
  return encodeWav(sing(notes, { sampleRate, noiseDb: -40, length: seconds }), sampleRate);
}

/** The mic melody on the right channel only (as from input 2 of a stereo interface), 16-bit stereo WAV. */
export function micWavRightOnly(sampleRate: number, leadSeconds: number): Uint8Array {
  const notes = fromBeats(MIC_BPM, MIC_MELODY).map((n) => ({ ...n, start: n.start + leadSeconds }));
  const mono = sing(notes, { sampleRate, detuneCents: -18, noiseDb: -40 });
  const n = mono.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    v.setInt16(44 + i * 4, 0, true);
    v.setInt16(44 + i * 4 + 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export { noteName } from '../src/music/notes';
