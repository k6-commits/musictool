import { describe, expect, it } from 'vitest';
import { detectKey } from '../src/music/keydetect';
import { centsOff, hzToMidi, midiToHz, noteName } from '../src/music/notes';
import { inScale, keySignature, snapPitch } from '../src/music/scale';

describe('notes', () => {
  it('converts between Hz and MIDI', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 6);
    expect(midiToHz(60)).toBeCloseTo(261.626, 2);
    expect(centsOff(60.23)).toBe(23);
    expect(centsOff(59.8)).toBe(-20);
  });

  it('names notes with the chosen middle C', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(60, 'letter', 3)).toBe('C3');
    expect(noteName(60, 'letter', 5)).toBe('C5');
    expect(noteName(61)).toBe('C♯4');
    expect(noteName(64, 'doremi')).toBe('ミ');
    expect(noteName(59.6)).toBe('C4');
  });
});

describe('scale', () => {
  const C = { tonic: 0, mode: 'major' as const };
  it('knows scale tones', () => {
    expect(inScale(64, C)).toBe(true);
    expect(inScale(66, C)).toBe(false);
    expect(inScale(66, { tonic: 7, mode: 'major' })).toBe(true);
  });

  it('snaps out-of-scale notes depending on strength', () => {
    expect(snapPitch(66.1, C, 0)).toBe(66); // weak: keep F#
    expect(snapPitch(65.6, C, 0.6)).toBe(65); // F# sung low -> F
    expect(snapPitch(66.4, C, 1)).toBe(67); // strong: nearest scale tone (G)
    expect(snapPitch(64.2, C, 1)).toBe(64);
    expect(snapPitch(66.2, { tonic: 0, mode: 'chromatic' }, 1)).toBe(66);
  });

  it('writes MIDI key signatures', () => {
    expect(keySignature({ tonic: 0, mode: 'major' })).toEqual({ sf: 0, mi: 0 });
    expect(keySignature({ tonic: 9, mode: 'minor' })).toEqual({ sf: 0, mi: 1 });
    expect(keySignature({ tonic: 3, mode: 'major' })).toEqual({ sf: -3, mi: 0 });
    expect(keySignature({ tonic: 4, mode: 'minor' })).toEqual({ sf: 1, mi: 1 });
    expect(keySignature({ tonic: 6, mode: 'major' })).toEqual({ sf: 6, mi: 0 });
  });
});

describe('key detection', () => {
  it('finds D major from a D major line', () => {
    const notes = [62, 64, 66, 67, 69, 71, 73, 74, 69, 66, 62].map((pitch, i) => ({ pitch, duration: i === 0 || i === 10 ? 2 : 1 }));
    const best = detectKey(notes)[0].key;
    expect(best).toEqual({ tonic: 2, mode: 'major' });
  });

  it('finds A minor from an A minor line', () => {
    const notes = [57, 60, 64, 62, 60, 59, 57, 64, 57].map((pitch, i) => ({ pitch, duration: i % 4 === 0 ? 2 : 1 }));
    expect(detectKey(notes)[0].key).toEqual({ tonic: 9, mode: 'minor' });
  });
});
