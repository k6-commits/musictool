// Pitch tracking at 16 kHz with a 16 ms hop. One streaming tracker serves both the live view and
// whole-take analysis, so a recorded take and the same audio opened as a file give the same frames.
import { Resampler } from './resample';
import { Yin } from './yin';

export const ANALYSIS_RATE = 16000;
export const HOP = 256;
export const HOP_SEC = HOP / ANALYSIS_RATE;

export type InputMode = 'sing' | 'hum' | 'whistle';

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

export function makeYin(mode: InputMode): Yin {
  return new Yin({ sampleRate: ANALYSIS_RATE, ...YIN_SETTINGS[mode] });
}

/**
 * Offline analysis of a whole take: the streaming tracker fed in chunks, yielding to the event loop every
 * ~30 ms so the page stays responsive and the progress bar moves even for long files.
 */
export async function analyzePitch(
  samples: Float32Array,
  sampleRate: number,
  mode: InputMode,
  onProgress?: (fraction: number) => void,
): Promise<{ frames: PitchFrame[]; stats: AnalyzeStats }> {
  const live = new LivePitch(sampleRate, mode);
  const frames: PitchFrame[] = [];
  const CHUNK = 8192;
  let lastYield = now();
  for (let p = 0; p < samples.length; p += CHUNK) {
    for (const f of live.push(samples.subarray(p, Math.min(samples.length, p + CHUNK)))) frames.push(f);
    if (now() - lastYield > 30) {
      onProgress?.(p / samples.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = now();
    }
  }
  for (const f of live.finish()) frames.push(f);
  onProgress?.(1);
  return { frames, stats: { millisPerFrame: live.millisPerFrame } };
}

/**
 * Streaming tracker: used live while singing, and by analyzePitch for whole takes. It drops the resampler's
 * filter delay and, when the take ends (`finish()`), flushes and zero-pads, so every frame lines up with the
 * input. `millisPerFrame` is the processing time (resampling and pitch detection) per 16 ms frame.
 */
export class LivePitch {
  private readonly resampler: Resampler;
  private readonly yin: Yin;
  private skipped = 0;
  private buffer = new Float32Array(0);
  private read = 0;
  private produced = 0;
  private written = 0;
  private inputSamples = 0;
  private busyMs = 0;

  constructor(inputRate: number, mode: InputMode) {
    this.resampler = new Resampler(inputRate, ANALYSIS_RATE);
    this.yin = makeYin(mode);
  }

  get millisPerFrame(): number {
    return this.busyMs / Math.max(1, this.produced);
  }

  push(chunk: Float32Array): PitchFrame[] {
    const t0 = now();
    this.inputSamples += chunk.length;
    this.append(this.resampler.process(chunk), Infinity);
    const out = this.run(Infinity);
    this.busyMs += now() - t0;
    return out;
  }

  /** The take is over: flush the resampler, pad with zeros and return the remaining frames. */
  finish(): PitchFrame[] {
    const t0 = now();
    const want = this.resampler.outputLength(this.inputSamples);
    this.append(this.resampler.process(new Float32Array(this.resampler.flushLength)), want);
    if (this.written < want) this.append(new Float32Array(want - this.written), want);
    this.append(new Float32Array(this.yin.frameLength), Infinity, true);
    const out = this.run(Math.ceil(want / HOP));
    this.busyMs += now() - t0;
    return out;
  }

  private append(y: Float32Array, limit: number, padding = false): void {
    let from = 0;
    if (!padding && this.skipped < this.resampler.skip) {
      from = Math.min(this.resampler.skip - this.skipped, y.length);
      this.skipped += from;
    }
    const to = padding ? y.length : Math.min(y.length, from + Math.max(0, limit - this.written));
    if (to <= from) return;
    const add = y.subarray(from, to);
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
