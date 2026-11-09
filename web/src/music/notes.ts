// Note names and pitch conversions.

export const LETTER_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const DOREMI_NAMES = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'];

export type Notation = 'letter' | 'doremi';
/** Which octave number the DAW shows for MIDI note 60. */
export type MiddleC = 3 | 4 | 5;

/** Pitch class 0..11 of a (rounded) MIDI note number. */
export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** "E4" / "ミ". Octave numbering follows `middleC` (4 = scientific pitch notation). */
export function noteName(midi: number, notation: Notation = 'letter', middleC: MiddleC = 4): string {
  const m = Math.round(midi);
  if (notation === 'doremi') return DOREMI_NAMES[pitchClass(m)];
  const octave = Math.floor(m / 12) - 1 + (middleC - 4);
  return LETTER_NAMES[pitchClass(m)] + octave;
}

/** Distance from the nearest semitone in cents, -50..+50. */
export function centsOff(midi: number): number {
  return Math.round((midi - Math.round(midi)) * 100);
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(pitchClass(midi));
}
