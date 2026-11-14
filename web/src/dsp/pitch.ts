// Pitch tracking at 16 kHz with a 16 ms hop, by one of two engines:
// - SwiftF0 (a small neural network, src/dsp/swiftf0) analyzes singing and humming: on real recordings it matches
//   YIN in quiet rooms and holds up far better in noise (eval/README.md).
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

/**
 * Analysis of a whole take, fed to a streaming tracker in chunks, yielding to the event loop every ~30 ms so the
 * page stays responsive and the progress bar moves even for long files.
 */
export async function analyzePitch(
  samples: Float32Array,
  sampleRate: number,
  mode: InputMode,
  onProgress?: (fraction: number) => void,
  engine: PitchEngine = engineFor(mode),
): Promise<Analysis> {
  const tracker = engine === 'yin' ? new LivePitch(sampleRate, mode) : new SwiftF0Tracker(sampleRate, mode);
  const frames: PitchFrame[] = [];
  const CHUNK = 8192;
  let lastYield = now();
  for (let p = 0; p < samples.length; p += CHUNK) {
    for (const f of tracker.push(samples.subarray(p, Math.min(samples.length, p + CHUNK)))) frames.push(f);
    if (now() - lastYield > 30) {
      onProgress?.(p / samples.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = now();
    }
  }
  for (const f of tracker.finish()) frames.push(f);
  onProgress?.(1);
  return { frames, stats: { millisPerFrame: tracker.millisPerFrame }, engine };
}

/**
 * SwiftF0 over a stream of samples at any rate (resampled to 16 kHz), with one safeguard: on a steady tone around
 * C5 with a little noise SwiftF0 can report the octave above for whole notes (a straight-toned child's or
 * soprano's note, or the synthetic test voice), and YIN is at its most reliable on exactly such tones. So where
 * SwiftF0 says twice YIN's pitch and YIN is confident (aperiodicity under 0.1), the frame takes YIN's octave.
 * On the real recordings in eval/README.md this changes accuracy by at most 0.2 points.
 */
export class SwiftF0Tracker {
  private readonly input: AlignedResampler;
  private readonly sf0 = new SwiftF0Stream();
  private readonly yin: LivePitch | null;
  /** YIN frames not yet matched; YIN frame j shares its center with SwiftF0 frame j + 1. */
  private yinFrames: PitchFrame[] = [];
  private yinFirst = 0;
  private produced = 0;
  private busyMs = 0;

  constructor(inputRate: number, mode: InputMode, octaveCheck = true) {
    this.input = new AlignedResampler(inputRate, ANALYSIS_RATE);
    this.yin = octaveCheck ? new LivePitch(ANALYSIS_RATE, mode) : null;
  }

  get millisPerFrame(): number {
    return this.busyMs / Math.max(1, this.produced);
  }

  push(chunk: Float32Array): PitchFrame[] {
    const t0 = now();
    const x16 = this.input.push(chunk);
    if (this.yin) for (const f of this.yin.push(x16)) this.yinFrames.push(f);
    const out = this.frames(this.sf0.push(x16));
    this.busyMs += now() - t0;
    return out;
  }

  finish(): PitchFrame[] {
    const t0 = now();
    const x16 = this.input.finish();
    if (this.yin) for (const f of [...this.yin.push(x16), ...this.yin.finish()]) this.yinFrames.push(f);
    const out = this.frames(this.sf0.push(x16));
    for (const f of this.frames(this.sf0.finish())) out.push(f);
    this.busyMs += now() - t0;
    return out;
  }

  private frames(r: Sf0Frames | null): PitchFrame[] {
    if (!r) return [];
    const out: PitchFrame[] = [];
    for (let k = 0; k < r.pitch.length; k++) {
      let f0 = r.pitch[k];
      const y = this.yinFrames[this.produced - 1 - this.yinFirst];
      if (y && y.conf >= YIN_OCTAVE_CONF && y.f0 > 0 && Math.abs(1200 * Math.log2(f0 / (2 * y.f0))) < 50) f0 /= 2;
      out.push({ t: this.produced * HOP_SEC, f0, conf: r.conf[k], rms: r.rms[k] });
      this.produced++;
    }
    // Drop the YIN frames already matched.
    const used = Math.max(0, this.produced - 1 - this.yinFirst);
    if (used > 0) {
      this.yinFrames = this.yinFrames.slice(used);
      this.yinFirst += used;
    }
    return out;
  }
}

/** YIN confidence (1 - aperiodicity) above which YIN's octave overrides SwiftF0's (see SwiftF0Tracker). */
const YIN_OCTAVE_CONF = 0.9;

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
