// Pitch tracking at 16 kHz with a 16 ms hop, by one of two engines:
// - SwiftF0 (a small neural network, src/dsp/swiftf0) analyzes singing and humming: on real recordings it matches
//   YIN in quiet rooms and holds up far better in noise (eval/README.md). Its result does not depend on the mode.
// - YIN analyzes whistling (whistles can go above SwiftF0's 2.1 kHz range) and drives the live view while
//   recording, where it has no look-ahead delay.
import { AlignedResampler } from './resample';
import { SwiftF0Stream, type Sf0Frames } from './swiftf0/model';
import { Yin } from './yin';

export const ANALYSIS_RATE = 16000;
export const HOP = 256;
export const HOP_SEC = HOP / ANALYSIS_RATE;

export type InputMode = 'sing' | 'hum' | 'whistle';
export type PitchEngine = 'swiftf0' | 'yin';

const YIN_SETTINGS: Record<InputMode, { fmin: number; fmax: number; window: number }> = {
  sing: { fmin: 65, fmax: 1100, window: 512 },
  hum: { fmin: 65, fmax: 750, window: 512 },
  whistle: { fmin: 400, fmax: 2600, window: 256 },
};

export interface PitchFrame {
  /** Seconds from the start of the audio (center of the analysis window). */
  t: number;
  f0: number;
  conf: number;
  rms: number;
}

export interface AnalyzeStats {
  /** Processing time (resampling and pitch detection) per 16 ms frame. */
  millisPerFrame: number;
}

export interface Analysis {
  frames: PitchFrame[];
  stats: AnalyzeStats;
  engine: PitchEngine;
}

/** The engine that analyzes a take in this input mode. */
export function engineFor(mode: InputMode): PitchEngine {
  return mode === 'whistle' ? 'yin' : 'swiftf0';
}

export function makeYin(mode: InputMode): Yin {
  return new Yin({ sampleRate: ANALYSIS_RATE, ...YIN_SETTINGS[mode] });
}

export interface AnalyzeOptions {
  onProgress?: (fraction: number) => void;
  /** The engine to use (default: the mode's, engineFor). */
  engine?: PitchEngine;
  /** SwiftF0 only: the octave check (default on; see SwiftF0Tracker). */
  octaveCheck?: boolean;
}

/**
 * Analysis of a whole take, fed to a streaming tracker in chunks, yielding to the event loop every ~30 ms so the
 * page stays responsive and the progress bar moves even for long files. For SwiftF0 the take is first brought to a
 * fixed level (levelGain): its voicing confidence depends on the input level, and takes are recorded without
 * automatic gain.
 */
export async function analyzePitch(samples: Float32Array, sampleRate: number, mode: InputMode, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const engine = opts.engine ?? engineFor(mode);
  const tracker =
    engine === 'yin'
      ? new LivePitch(sampleRate, mode)
      : new SwiftF0Tracker(sampleRate, { gain: levelGain(samples, sampleRate), octaveCheck: opts.octaveCheck });
  const frames: PitchFrame[] = [];
  const CHUNK = 8192;
  let lastYield = now();
  for (let p = 0; p < samples.length; p += CHUNK) {
    for (const f of tracker.push(samples.subarray(p, Math.min(samples.length, p + CHUNK)))) frames.push(f);
    if (now() - lastYield > 30) {
      opts.onProgress?.(p / samples.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = now();
    }
  }
  for (const f of tracker.finish()) frames.push(f);
  opts.onProgress?.(1);
  return { frames, stats: { millisPerFrame: tracker.millisPerFrame }, engine };
}

/** The level SwiftF0 sees: voice RMS (the louder half of 32 ms frames) of -20 dBFS, about that of the eval sets. */
const TARGET_RMS = 0.1;

/**
 * Gain that brings a take to TARGET_RMS: RMS over the louder half of its 32 ms frames, so pauses and silence do not
 * count. Between 1/4 and 1000 (+60 dB); 1 for a silent take.
 */
export function levelGain(samples: Float32Array, sampleRate: number): number {
  const n = Math.max(1, Math.round(0.032 * sampleRate));
  const energies: number[] = [];
  for (let p = 0; p + n <= samples.length; p += n) {
    let e = 0;
    for (let i = p; i < p + n; i++) e += samples[i] * samples[i];
    energies.push(e / n);
  }
  if (!energies.length) return 1;
  energies.sort((a, b) => b - a);
  const top = energies.slice(0, Math.ceil(energies.length / 2));
  const rms = Math.sqrt(top.reduce((a, b) => a + b, 0) / top.length);
  return rms < 1e-6 ? 1 : Math.min(1000, Math.max(0.25, TARGET_RMS / rms));
}

export interface SwiftF0TrackerOptions {
  /** Applied to the 16 kHz input before SwiftF0 (frames report the level before it). */
  gain?: number;
  octaveCheck?: boolean;
  /** Frames per SwiftF0 batch: each batch is one synchronous computation (see SwiftF0Stream). */
  batch?: number;
}

/** SwiftF0 pitches at or above this are checked against YIN for a doubled octave (see SwiftF0Tracker). */
const OCTAVE_CHECK_HZ = 700;
/** YIN confidence (1 - aperiodicity) needed to take YIN's octave. */
const OCTAVE_CHECK_CONF = 0.9;

/**
 * SwiftF0 over a stream of samples at any rate (resampled to 16 kHz), with one safeguard: on a steady tone around
 * A4-D#5 with a little noise SwiftF0 can report the octave above for whole notes (a straight-toned child's or
 * soprano's note, or the synthetic test voice), and YIN is at its most reliable on exactly such tones. So where
 * SwiftF0 says 700 Hz or more, YIN looks at the same 32 ms (centered on the frame, with a 300-2100 Hz range so a
 * real high note is not mistaken for its sub-octave), and if YIN confidently says half of SwiftF0's pitch, the frame
 * takes YIN's octave. Lower pitches are left alone: there YIN's own sub-octave errors on low voices are the risk.
 */
export class SwiftF0Tracker {
  private readonly input: AlignedResampler;
  private readonly sf0: SwiftF0Stream;
  private readonly gain: number;
  private readonly yin: Yin | null;
  /** Recent 16 kHz input (after the gain) for the octave check: sample recentBase + i is recent[i]. */
  private recent = new Float32Array(1 << 15);
  private recentLen = 0;
  private recentBase = 0;
  private produced = 0;
  private busyMs = 0;

  constructor(inputRate: number, opts: SwiftF0TrackerOptions = {}) {
    this.input = new AlignedResampler(inputRate, ANALYSIS_RATE);
    this.sf0 = new SwiftF0Stream(opts.batch);
    this.gain = opts.gain ?? 1;
    this.yin = opts.octaveCheck === false ? null : new Yin({ sampleRate: ANALYSIS_RATE, fmin: 300, fmax: 2100, window: 512 });
  }

  get millisPerFrame(): number {
    return this.busyMs / Math.max(1, this.produced);
  }

  push(chunk: Float32Array): PitchFrame[] {
    const t0 = now();
    const x = this.scaled(this.input.push(chunk));
    this.keep(x);
    const out = this.frames(this.sf0.push(x));
    this.busyMs += now() - t0;
    return out;
  }

  finish(): PitchFrame[] {
    const t0 = now();
    const x = this.scaled(this.input.finish());
    this.keep(x);
    // Zeros after the end, so YIN can look at the last frames.
    if (this.yin) this.keep(new Float32Array(this.yin.frameLength));
    const out = this.frames(this.sf0.push(x));
    for (const f of this.frames(this.sf0.finish())) out.push(f);
    this.busyMs += now() - t0;
    return out;
  }

  private scaled(x: Float32Array): Float32Array {
    if (this.gain === 1) return x;
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] * this.gain;
    return y;
  }

  private keep(x: Float32Array): void {
    if (!this.yin) return;
    if (this.recentLen + x.length > this.recent.length) {
      const grown = new Float32Array(Math.max(this.recent.length * 2, this.recentLen + x.length));
      grown.set(this.recent.subarray(0, this.recentLen));
      this.recent = grown;
    }
    this.recent.set(x, this.recentLen);
    this.recentLen += x.length;
  }

  private frames(r: Sf0Frames | null): PitchFrame[] {
    if (!r) return [];
    const out: PitchFrame[] = [];
    for (let k = 0; k < r.pitch.length; k++) {
      let f0 = r.pitch[k];
      if (this.yin && f0 >= OCTAVE_CHECK_HZ) {
        // YIN's window centered on this frame (frame i is centered on sample 256 i).
        const at = this.produced * HOP - this.yin.window / 2 - this.recentBase;
        if (at >= 0 && at + this.yin.frameLength <= this.recentLen) {
          const y = this.yin.detect(this.recent, at);
          if (y.conf >= OCTAVE_CHECK_CONF && y.f0 > 0 && Math.abs(1200 * Math.log2(f0 / (2 * y.f0))) < 50) f0 /= 2;
        }
      }
      out.push({ t: this.produced * HOP_SEC, f0, conf: r.conf[k], rms: r.rms[k] / this.gain });
      this.produced++;
    }
    // Keep only what the next frames' YIN windows need.
    if (this.yin) {
      const drop = Math.max(0, this.produced * HOP - this.yin.window / 2 - this.recentBase);
      if (drop > 0) {
        this.recent.copyWithin(0, drop, this.recentLen);
        this.recentLen -= drop;
        this.recentBase += drop;
      }
    }
    return out;
  }
}

/**
 * Streaming YIN: used live while singing, and by analyzePitch for whistles. When the take ends (`finish()`), it
 * pads with zeros so every frame lines up with the input. `millisPerFrame` is the processing time (resampling and
 * pitch detection) per 16 ms frame.
 */
export class LivePitch {
  private readonly input: AlignedResampler;
  private readonly yin: Yin;
  private buffer = new Float32Array(0);
  private read = 0;
  private produced = 0;
  private written = 0;
  private busyMs = 0;

  constructor(inputRate: number, mode: InputMode) {
    this.input = new AlignedResampler(inputRate, ANALYSIS_RATE);
    this.yin = makeYin(mode);
  }

  get millisPerFrame(): number {
    return this.busyMs / Math.max(1, this.produced);
  }

  push(chunk: Float32Array): PitchFrame[] {
    const t0 = now();
    this.append(this.input.push(chunk));
    const out = this.run(Infinity);
    this.busyMs += now() - t0;
    return out;
  }

  /** The take is over: flush the resampler, pad with zeros and return the remaining frames. */
  finish(): PitchFrame[] {
    const t0 = now();
    this.append(this.input.finish());
    const want = this.written;
    this.append(new Float32Array(this.yin.frameLength), true);
    const out = this.run(Math.ceil(want / HOP));
    this.busyMs += now() - t0;
    return out;
  }

  private append(add: Float32Array, padding = false): void {
    if (!add.length) return;
    if (!padding) this.written += add.length;
    const keep = this.buffer.length - this.read;
    const merged = new Float32Array(keep + add.length);
    merged.set(this.buffer.subarray(this.read));
    merged.set(add, keep);
    this.buffer = merged;
    this.read = 0;
  }

  private run(maxFrames: number): PitchFrame[] {
    const out: PitchFrame[] = [];
    const len = this.yin.frameLength;
    while (this.produced < maxFrames && this.read + len <= this.buffer.length) {
      const r = this.yin.detect(this.buffer, this.read);
      out.push({ t: (this.produced * HOP + this.yin.window / 2) / ANALYSIS_RATE, f0: r.f0, conf: r.conf, rms: r.rms });
      this.read += HOP;
      this.produced++;
    }
    return out;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
