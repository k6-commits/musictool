import { describe, expect, it } from 'vitest';
import { estimateLatency, LAG_MAX, PROBE_TIMES, probeSignal, reportedLatency } from '../src/audio/latency';
import type { MicCapture } from '../src/audio/capture';
import { rng, sing } from '../src/synth/voice';

/** Deterministic Gaussian noise (Box-Muller on the synth's xorshift, mapped to (0, 1]). */
function gauss(seed: number): () => number {
  const r = rng(seed);
  const uniform = () => (r() + 1) / 2;
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

interface Room {
  sampleRate: number;
  /** Round trip in samples. */
  delay: number;
  /** Level of the chirp at the microphone (1 = as played). */
  gain?: number;
  noise?: number;
  /** Indexes of chirps that never sound (an output glitch). */
  silent?: number[];
  /** Seconds of the start the microphone missed. */
  lateStart?: number;
  /** Added to the recording (a voice, music). */
  extra?: Float32Array;
  clip?: boolean;
  seed?: number;
}

/**
 * What the microphone records when the chirps play through a small speaker into a room: each chirp loses its low
 * end (a one-pole high-pass, as a phone speaker), arrives after `delay` samples and is followed by reflections
 * (random taps decaying over ~40 ms, each weaker than the direct sound), over background noise.
 */
function record(room: Room): { recording: Float32Array; firstFrame: number; emitted: number[] } {
  const { sampleRate: sr, delay, gain = 0.3, noise = 0.003, silent = [], lateStart = 0, seed = 7 } = room;
  const rand = gauss(seed);
  const probe = probeSignal(sr);
  const played = new Float32Array(probe.length);
  const a = Math.exp((-2 * Math.PI * 600) / sr);
  for (let i = 0, prevX = 0, prevY = 0; i < probe.length; i++) {
    prevY = a * (prevY + probe[i] - prevX);
    prevX = probe[i];
    played[i] = prevY;
  }
  const taps: [number, number][] = [[0, 1]];
  for (let k = 0; k < 40; k++) {
    const t = 0.002 + Math.abs(rand()) * 0.06;
    taps.push([Math.round(t * sr), 0.35 * Math.exp(-t / 0.04) * Math.sign(rand())]);
  }
  const contextStart = 48213; // context frame where the microphone started
  const emitted = PROBE_TIMES.map((t) => contextStart + Math.round((0.5 + t) * sr));
  const total = emitted[emitted.length - 1] - contextStart + Math.round((LAG_MAX + 0.2) * sr);
  const full = new Float32Array(total);
  emitted.forEach((frame, k) => {
    if (silent.includes(k)) return;
    for (const [at, level] of taps) {
      const base = frame - contextStart + delay + at;
      for (let i = 0; i < played.length && base + i < total; i++) full[base + i] += gain * level * played[i];
    }
  });
  for (let i = 0; i < total; i++) {
    full[i] += noise * rand() + (room.extra?.[i] ?? 0);
    if (room.clip) full[i] = Math.max(-1, Math.min(1, full[i]));
  }
  const skip = Math.round(lateStart * sr);
  return { recording: full.subarray(skip), firstFrame: contextStart + skip, emitted };
}

const run = (room: Room) => {
  const r = record(room);
  return estimateLatency(r.recording, r.firstFrame, room.sampleRate, r.emitted);
};

describe('loopback latency', () => {
  it('finds the round trip through a speaker and a room, to a sample or two', () => {
    for (const [sampleRate, seconds] of [
      [48000, 0.0123],
      [48000, 0.087],
      [44100, 0.2345],
      [48000, 0.58], // longer than any gap between chirps
      [96000, 0.041],
    ]) {
      const delay = Math.round(seconds * sampleRate);
      const e = run({ sampleRate, delay, seed: delay });
      expect(e.latency, `${sampleRate} Hz, ${seconds} s`).not.toBeNull();
      expect(Math.abs(e.latency! * sampleRate - delay)).toBeLessThanOrEqual(2);
      expect(e.heard).toBe(PROBE_TIMES.length);
      expect(e.covered).toBe(PROBE_TIMES.length);
      expect(e.spread).toBeLessThan(0.0002);
    }
  });

  it('hears quiet chirps under noise, and gives up when they are buried', () => {
    const delay = 4321;
    const quiet = run({ sampleRate: 48000, delay, gain: 0.05, noise: 0.02 });
    expect(quiet.latency).not.toBeNull();
    expect(Math.abs(quiet.latency! * 48000 - delay)).toBeLessThanOrEqual(2);
    expect(run({ sampleRate: 48000, delay, gain: 0.05, noise: 0.15 }).latency).toBeNull();
  });

  it('finds nothing in noise or singing alone', () => {
    expect(run({ sampleRate: 48000, delay: 3000, gain: 0 }).latency).toBeNull();
    const voice = sing(
      [57, 60, 64, 62, 59, 57, 64, 67, 65, 62].map((p, i) => ({ pitch: p, start: 0.2 + i * 0.5, dur: 0.45 })),
      { sampleRate: 48000, gain: 2, length: 6 },
    );
    const singing = run({ sampleRate: 48000, delay: 3000, gain: 0, extra: voice });
    expect(singing.latency).toBeNull();
    expect(singing.heard).toBeLessThan(3);
    // With the chirps playing over the same singing, they are still found.
    const both = run({ sampleRate: 48000, delay: 3000, gain: 0.3, extra: voice });
    expect(Math.abs(both.latency! * 48000 - 3000)).toBeLessThanOrEqual(2);
  });

  it('copes with a late microphone, a missing chirp and clipping', () => {
    const late = run({ sampleRate: 48000, delay: 2000, lateStart: 1.2 });
    expect(late.covered).toBe(PROBE_TIMES.length - 2);
    expect(Math.abs(late.latency! * 48000 - 2000)).toBeLessThanOrEqual(2);
    const gaps = run({ sampleRate: 48000, delay: 2000, silent: [3, 7] });
    expect(gaps.heard).toBe(PROBE_TIMES.length - 2);
    expect(Math.abs(gaps.latency! * 48000 - 2000)).toBeLessThanOrEqual(2);
    // Most chirps lost: no estimate.
    expect(run({ sampleRate: 48000, delay: 2000, silent: [0, 2, 4, 6] }).latency).toBeNull();
    const loud = run({ sampleRate: 48000, delay: 2000, gain: 4, clip: true });
    expect(Math.abs(loud.latency! * 48000 - 2000)).toBeLessThanOrEqual(2);
  });

  it('never hears chirps in digital silence', () => {
    const r = record({ sampleRate: 48000, delay: 2000 });
    const n = r.recording.length;
    // A muted microphone: exact zeros throughout.
    expect(estimateLatency(new Float32Array(n), r.firstFrame, 48000, r.emitted).latency).toBeNull();
    // Zeros, then noise: no chirps at all.
    const noise = gauss(3);
    const lateNoise = new Float32Array(n).map((_, i) => (i > 4.2 * 48000 ? 0.01 * noise() : 0));
    expect(estimateLatency(lateNoise, r.firstFrame, 48000, r.emitted).latency).toBeNull();
    // Gated noise: 60 ms bursts with digital silence between.
    const gated = new Float32Array(n).map((_, i) => (i % 14400 < 2880 ? 0.02 * noise() : 0));
    expect(estimateLatency(gated, r.firstFrame, 48000, r.emitted).latency).toBeNull();
    // A digital loopback (exact zeros between the chirps) and a faint chirp over silence are still found.
    for (const gain of [1, 0.001]) {
      const clean = run({ sampleRate: 48000, delay: 2000, gain, noise: 0 });
      expect(Math.abs(clean.latency! * 48000 - 2000), `gain ${gain}`).toBeLessThanOrEqual(2);
    }
  });

  it('needs the recording to cover most chirps', () => {
    const r = record({ sampleRate: 48000, delay: 2000 });
    const short = estimateLatency(r.recording.subarray(0, Math.round(2.4 * 48000)), r.firstFrame, 48000, r.emitted);
    expect(short.covered).toBeLessThan(6);
    expect(short.latency).toBeNull();
    expect(estimateLatency(new Float32Array(0), -1, 48000, r.emitted)).toEqual({ latency: null, heard: 0, covered: 0, spread: 0 });
  });

  it("adds the microphone's latency to the output latency, counting the callback buffer once", () => {
    const mic = { inputLatency: 0.01 } as MicCapture;
    const ac = (outputLatency: number, baseLatency: number) => ({ outputLatency, baseLatency }) as AudioContext;
    expect(reportedLatency(ac(0.04, 0.01), mic)).toBeCloseTo(0.05, 9);
    expect(reportedLatency(ac(0, 0.003), mic)).toBeCloseTo(0.013, 9);
    expect(reportedLatency({ baseLatency: 0.003 } as AudioContext, mic)).toBeCloseTo(0.013, 9);
  });
});
