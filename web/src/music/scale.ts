// Keys, scale snapping and MIDI key signatures.
import { LETTER_NAMES, pitchClass } from './notes';

export type Mode = 'major' | 'minor' | 'chromatic';

export interface Key {
  /** Pitch class of the tonic, 0 = C. Ignored for chromatic. */
  tonic: number;
  mode: Mode;
}

const SCALE_STEPS: Record<'major' | 'minor', number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

export function inScale(midi: number, key: Key): boolean {
  if (key.mode === 'chromatic') return true;
  const rel = (pitchClass(midi) - key.tonic + 12) % 12;
  return SCALE_STEPS[key.mode].includes(rel);
}

/**
 * Snap a (fractional) pitch to the key.
 * strength 0 = nearest semitone only, 1 = always the nearest scale tone.
 * In between, an out-of-scale note moves to the nearest scale tone when it is
 * within 0.5 + 0.5 * strength semitones of it.
 */
export function snapPitch(pitch: number, key: Key, strength: number): number {
  const r = Math.round(pitch);
  if (key.mode === 'chromatic' || inScale(r, key)) return r;
  const candidates = [r - 1, r + 1, r - 2, r + 2]
    .filter((c) => inScale(c, key))
    .sort((a, b) => Math.abs(pitch - a) - Math.abs(pitch - b) || a - b);
  const target = candidates[0];
  return Math.abs(pitch - target) <= 0.5 + 0.5 * strength ? target : r;
}

export function keyLabel(key: Key): string {
  if (key.mode === 'chromatic') return 'クロマチック';
  return `${LETTER_NAMES[key.tonic]} ${key.mode === 'major' ? 'メジャー' : 'マイナー'}`;
}

export function keyShort(key: Key): string {
  if (key.mode === 'chromatic') return 'Chr';
  return LETTER_NAMES[key.tonic] + (key.mode === 'minor' ? 'm' : '');
}

// Sharps (+) / flats (-) of each major key, indexed by tonic pitch class.
const MAJOR_SF = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];

/** MIDI key signature meta event values (FF 59 02 sf mi). */
export function keySignature(key: Key): { sf: number; mi: 0 | 1 } {
  if (key.mode === 'minor') return { sf: MAJOR_SF[(key.tonic + 3) % 12], mi: 1 };
  if (key.mode === 'major') return { sf: MAJOR_SF[key.tonic], mi: 0 };
  return { sf: 0, mi: 0 };
}

export const ALL_KEYS: Key[] = [
  ...Array.from({ length: 12 }, (_, t) => ({ tonic: t, mode: 'major' as Mode })),
  ...Array.from({ length: 12 }, (_, t) => ({ tonic: t, mode: 'minor' as Mode })),
  { tonic: 0, mode: 'chromatic' },
];

export function keyId(key: Key): string {
  return `${key.mode}-${key.tonic}`;
}

export function keyFromId(id: string): Key {
  const [mode, tonic] = id.split('-');
  return { mode: mode as Mode, tonic: Number(tonic) };
}
