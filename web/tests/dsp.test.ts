import { describe, expect, it } from 'vitest';
import { Resampler, resample } from '../src/dsp/resample';
import { Yin } from '../src/dsp/yin';

function sine(freq: number, sr: number, seconds: number, harmonics: number[] = [1]): Float32Array {
  const out = new Float32Array(Math.round(sr * seconds));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    harmonics.forEach((a, h) => (s += a * Math.sin((2 * Math.PI * freq * (h + 1) * i) / sr)));
    out[i] = 0.5 * s;
  }
  return out;
}

function zeroCrossFreq(x: Float32Array, sr: number): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return (n * sr) / x.length;
}

describe('resample', () => {
  it('keeps a 1 kHz tone at 1 kHz going 48k -> 16k', () => {
    const y = resample(sine(1000, 48000, 1), 48000, 16000);
    expect(y.length).toBe(16000);
    expect(zeroCrossFreq(y.subarray(400, 15600), 16000)).toBeCloseTo(1000, -1);
    let peak = 0;
    for (let i = 400; i < 15600; i++) peak = Math.max(peak, Math.abs(y[i]));
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThan(0.55);
  });

  it('removes content above the new Nyquist', () => {
    const y = resample(sine(9000, 48000, 0.5), 48000, 16000);
    let peak = 0;
    for (let i = 200; i < y.length - 200; i++) peak = Math.max(peak, Math.abs(y[i]));
    expect(peak).toBeLessThan(0.05);
  });

  it('streams the same output as the offline version (apart from the filter delay)', () => {
    const x = sine(440, 44100, 0.5);
    const r = new Resampler(44100, 16000);
    const parts: number[] = [];
    for (let i = 0; i < x.length; i += 333) parts.push(...r.process(x.subarray(i, i + 333)));
    const offline = resample(x, 44100, 16000);
    const d = Math.round(r.delay);
    for (let i = 500; i < 7000; i += 97) expect(parts[i + d]).toBeCloseTo(offline[i], 2);
  });
});

describe('yin', () => {
  const yin = new Yin({ sampleRate: 16000, fmin: 65, fmax: 1100, window: 512 });
  it.each([82.41, 110, 220, 440, 880])('finds %s Hz', (f) => {
    const x = sine(f, 16000, 0.2);
    const r = yin.detect(x, 400);
    expect(Math.abs(r.f0 - f) / f).toBeLessThan(0.005);
    expect(r.conf).toBeGreaterThan(0.9);
  });

  it('does not jump an octave on a voice-like tone with a strong 2nd harmonic', () => {
    const x = sine(196, 16000, 0.2, [0.6, 1, 0.5, 0.3]);
    const r = yin.detect(x, 300);
    expect(Math.abs(r.f0 - 196)).toBeLessThan(2);
  });

  it('reports silence and noise as unvoiced', () => {
    expect(yin.detect(new Float32Array(2000), 0).f0).toBe(0);
    const noise = new Float32Array(2000).map(() => Math.random() - 0.5);
    const r = yin.detect(noise, 0);
    expect(r.f0 === 0 || r.conf < 0.6).toBe(true);
  });
});
