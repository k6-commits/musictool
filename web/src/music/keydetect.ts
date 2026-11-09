// Key estimation with Krumhansl–Kessler profiles, weighted by note duration.
import { pitchClass } from './notes';
import type { Key } from './scale';

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export interface KeyGuess {
  key: Key;
  score: number;
}

/** Returns all 24 keys, best first. Notes are { pitch, duration } in any time unit. */
export function detectKey(notes: { pitch: number; duration: number }[]): KeyGuess[] {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[pitchClass(n.pitch)] += Math.max(0, n.duration);
  const guesses: KeyGuess[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotMajor = MAJOR.map((_, i) => MAJOR[(i - tonic + 12) % 12]);
    const rotMinor = MINOR.map((_, i) => MINOR[(i - tonic + 12) % 12]);
    guesses.push({ key: { tonic, mode: 'major' }, score: correlation(hist, rotMajor) });
    guesses.push({ key: { tonic, mode: 'minor' }, score: correlation(hist, rotMinor) });
  }
  return guesses.sort((a, b) => b.score - a.score);
}
