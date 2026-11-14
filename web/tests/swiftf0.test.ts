import { afterEach, describe, expect, it } from 'vitest';
import { analyzePitch, SwiftF0Tracker } from '../src/dsp/pitch';
import { frameCount, kernelName, swiftF0Frames, SwiftF0Stream, useJsKernel } from '../src/dsp/swiftf0/model';
import { hzToMidi, midiToHz } from '../src/music/notes';
import { sing, type SungNote } from '../src/synth/voice';

/** A short melody at 16 kHz with a breath of noise, as SwiftF0 sees it. */
function melody16k(): Float32Array {
  const notes: SungNote[] = [57, 60, 64, 62, 59].map((p, i) => ({ pitch: p, start: 0.1 + i * 0.35, dur: 0.3 }));
  return sing(notes, { sampleRate: 16000, noiseDb: -40, vibratoCents: 20 });
}

describe('SwiftF0 port', () => {
  afterEach(() => useJsKernel(false));

  it('gives one frame per 256 samples, at least one', () => {
    expect(frameCount(0)).toBe(1);
    expect(frameCount(255)).toBe(1);
    expect(frameCount(16000)).toBe(62);
  });

  it('finds the pitch of a sung tone and calls silence unvoiced', () => {
    const x = new Float32Array(16000 + 8000);
    x.set(sing([{ pitch: 57, start: 0, dur: 0.9 }], { sampleRate: 16000, vibratoCents: 15 }).subarray(0, 14400));
    const total = frameCount(x.length);
    const r = swiftF0Frames(x, 0, total, 0, total);
    const mid = Array.from({ length: 30 }, (_, k) => 10 + k);
    for (const k of mid) {
      expect(r.conf[k]).toBeGreaterThan(0.5);
      expect(Math.abs(hzToMidi(r.pitch[k]) - 57)).toBeLessThan(0.4);
    }
    // The tail is digital silence: confidence 0 by the package's rule.
    expect(r.conf[total - 5]).toBe(0);
  });

  it('gives the same frames in WebAssembly and in TypeScript', () => {
    const x = melody16k();
    const total = frameCount(x.length);
    const wasm = swiftF0Frames(x, 0, total, 0, total);
    const name = kernelName();
    useJsKernel(true);
    expect(kernelName()).toBe('js');
    const js = swiftF0Frames(x, 0, total, 0, total);
    expect(['wasm-simd', 'js']).toContain(name);
    for (let k = 0; k < total; k++) {
      expect(Math.abs(js.conf[k] - wasm.conf[k])).toBeLessThan(1e-4);
      if (js.conf[k] >= 0.5) expect(Math.abs(1200 * Math.log2(js.pitch[k] / wasm.pitch[k]))).toBeLessThan(0.5);
    }
  });

  it('streams in batches with the same result as the whole signal', () => {
    const x = melody16k();
    const total = frameCount(x.length);
    const whole = swiftF0Frames(x, 0, total, 0, total);
    const stream = new SwiftF0Stream(16);
    const pitch: number[] = [];
    const conf: number[] = [];
    const take = (r: ReturnType<SwiftF0Stream['finish']>) => {
      if (!r) return;
      pitch.push(...r.pitch);
      conf.push(...r.conf);
    };
    for (let p = 0; p < x.length; p += 1000) take(stream.push(x.subarray(p, p + 1000)));
    take(stream.finish());
    expect(pitch.length).toBe(total);
    for (let k = 0; k < total; k++) {
      expect(Math.abs(conf[k] - whole.conf[k])).toBeLessThan(1e-5);
      expect(Math.abs(pitch[k] - whole.pitch[k]) / whole.pitch[k]).toBeLessThan(1e-6);
    }
  });

  it('frames from 48 kHz audio line up with the input', async () => {
    const notes: SungNote[] = [{ pitch: 60, start: 0.5, dur: 0.5 }];
    const audio = sing(notes, { sampleRate: 48000, vibratoCents: 15, length: 1.5 });
    const { frames, engine } = await analyzePitch(audio, 48000, 'sing');
    expect(engine).toBe('swiftf0');
    expect(frames.length).toBe(frameCount(Math.floor(audio.length / 3)));
    const voiced = frames.filter((f) => f.conf >= 0.5);
    expect(voiced[0].t).toBeGreaterThan(0.45);
    expect(voiced[0].t).toBeLessThan(0.56);
    expect(Math.abs(hzToMidi(voiced[10].f0) - 60)).toBeLessThan(0.3);
  });

  it("takes YIN's octave when SwiftF0 doubles a steady, confident tone", () => {
    // A straight (vibrato-free) C5 with a little noise: SwiftF0 alone reports C6 for most of the note.
    const x = sing([{ pitch: 72, start: 0.1, dur: 0.8 }], { sampleRate: 16000, noiseDb: -40, vibratoCents: 0 });
    const run = (check: boolean) => {
      const t = new SwiftF0Tracker(16000, 'sing', check);
      const frames = [...t.push(x), ...t.finish()].filter((f) => f.conf >= 0.5 && f.t > 0.2 && f.t < 0.8);
      return frames.filter((f) => Math.abs(hzToMidi(f.f0) - 84) < 0.5).length / frames.length;
    };
    expect(run(false)).toBeGreaterThan(0.3);
    expect(run(true)).toBe(0);
    expect(midiToHz(72)).toBeCloseTo(523.25, 1);
  });
});
