// Pitch tracking at 16 kHz with a 16 ms hop, offline and streaming.
// Both paths produce the same frames: the streaming tracker drops the resampler's filter delay and,
// when the take ends, flushes and zero-pads exactly like the offline analysis.
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
  /** Pitch-detection time per 16 ms frame. */
  millisPerFrame: number;
}

export function makeYin(mode: InputMode): Yin {
  return new Yin({ sampleRate: ANALYSIS_RATE, ...YIN_SETTINGS[mode] });
}

/** Number of 16 kHz samples a take of `inputLength` samples at `rate` is analyzed over. */
function analysisLength(inputLength: number, rate: number): number {
  return rate === ANALYSIS_RATE ? inputLength : Math.floor(inputLength / (rate / ANALYSIS_RATE));
}

/** Resampler flush length: enough input zeros to push the filter's tail out. */
function flushLength(r: Resampler): number {
  return Math.ceil(r.ratio * (r.delay + 2)) + 64;
}

/**
 * Offline analysis of a whole take. Resamples in chunks and yields to the event loop every ~30 ms,
 * so the page stays responsive and the progress bar moves even for long files.
 */
export async function analyzePitch(
  samples: Float32Array,
  sampleRate: number,
  mode: InputMode,
  onProgress?: (fraction: number) => void,
): Promise<{ frames: PitchFrame[]; stats: AnalyzeStats }> {
  const yin = makeYin(mode);
  const want = analysisLength(samples.length, sampleRate);
  // The analysis signal, followed by zeros so the last frames have a full window.
  const x16 = new Float32Array(want + yin.frameLength);
  const frames: PitchFrame[] = [];
  let filled = 0;
  let next = 0;
  let detectMs = 0;
  let lastYield = now();

  const maybeYield = async (fraction: number) => {
    if (now() - lastYield < 30) return;
    onProgress?.(fraction);
    await new Promise((resolve) => setTimeout(resolve, 0));
    lastYield = now();
  };
  const analyzeAvailable = async () => {
    while (next < want && (next + yin.frameLength <= filled || filled >= want)) {
      const t0 = now();
      const r = yin.detect(x16, next);
      detectMs += now() - t0;
      frames.push({ t: (next + yin.window / 2) / ANALYSIS_RATE, f0: r.f0, conf: r.conf, rms: r.rms });
      next += HOP;
      if ((next / HOP) % 64 === 0) await maybeYield(next / Math.max(1, want));
    }
  };

  if (sampleRate === ANALYSIS_RATE) {
    x16.set(samples);
    filled = want;
  } else {
    const r = new Resampler(sampleRate, ANALYSIS_RATE);
    const skip = Math.round(r.delay);
    let produced = 0;
    const write = (out: Float32Array) => {
      for (let i = 0; i < out.length; i++) {
        const g = produced + i - skip;
        if (g >= 0 && g < want) x16[g] = out[i];
      }
      produced += out.length;
      filled = Math.min(want, Math.max(0, produced - skip));
    };
    const CHUNK = 16384;
    for (let p = 0; p < samples.length; p += CHUNK) {
      write(r.process(samples.subarray(p, Math.min(samples.length, p + CHUNK))));
      await analyzeAvailable();
      await maybeYield(next / Math.max(1, want));
    }
    write(r.process(new Float32Array(flushLength(r))));
    filled = want;
  }
  await analyzeAvailable();
  onProgress?.(1);
  return { frames, stats: { millisPerFrame: detectMs / Math.max(1, frames.length) } };
}

/** Streaming tracker for live display while singing; `finish()` completes the take's frames. */
export class LivePitch {
  private readonly resampler: Resampler;
  private readonly yin: Yin;
  private readonly skip: number;
  private skipped = 0;
  private buffer = new Float32Array(0);
  private read = 0;
  private produced = 0;
  private written = 0;
  private inputSamples = 0;
  private detectMs = 0;

  constructor(
    private readonly inputRate: number,
    mode: InputMode,
  ) {
    this.resampler = new Resampler(inputRate, ANALYSIS_RATE);
    this.yin = makeYin(mode);
    this.skip = Math.round(this.resampler.delay);
  }

  get millisPerFrame(): number {
    return this.detectMs / Math.max(1, this.produced);
  }

  push(chunk: Float32Array): PitchFrame[] {
    this.inputSamples += chunk.length;
    this.append(this.resampler.process(chunk), Infinity);
    return this.run(Infinity);
  }

  /** The take is over: flush the resampler, pad with zeros and return the remaining frames. */
  finish(): PitchFrame[] {
    const want = analysisLength(this.inputSamples, this.inputRate);
    this.append(this.resampler.process(new Float32Array(flushLength(this.resampler))), want);
    if (this.written < want) this.append(new Float32Array(want - this.written), want);
    this.append(new Float32Array(this.yin.frameLength), Infinity, true);
    return this.run(Math.ceil(want / HOP));
  }

  private append(y: Float32Array, limit: number, padding = false): void {
    let from = 0;
    if (!padding && this.skipped < this.skip) {
      from = Math.min(this.skip - this.skipped, y.length);
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
      const t0 = now();
      const r = this.yin.detect(this.buffer, this.read);
      this.detectMs += now() - t0;
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
