// Pitch tracking at 16 kHz with a 16 ms hop, offline and streaming.
import { Resampler, resample } from './resample';
import { Yin } from './yin';

export const ANALYSIS_RATE = 16000;
export const HOP = 256;
export const HOP_SEC = HOP / ANALYSIS_RATE;

export type InputMode = 'sing' | 'hum' | 'whistle';

export const MODE_LABELS: Record<InputMode, string> = { sing: '歌声', hum: 'ハミング', whistle: '口笛' };

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

export function makeYin(mode: InputMode): Yin {
  return new Yin({ sampleRate: ANALYSIS_RATE, ...YIN_SETTINGS[mode] });
}

export interface AnalyzeStats {
  frames: number;
  millis: number;
  millisPerFrame: number;
}

/** Offline analysis of a whole take. Yields to the event loop so the page stays responsive. */
export async function analyzePitch(
  samples: Float32Array,
  sampleRate: number,
  mode: InputMode,
  onProgress?: (fraction: number) => void,
): Promise<{ frames: PitchFrame[]; x16: Float32Array; stats: AnalyzeStats }> {
  const started = now();
  const x16 = resample(samples, sampleRate, ANALYSIS_RATE);
  const yin = makeYin(mode);
  const padded = new Float32Array(x16.length + yin.frameLength);
  padded.set(x16);
  const frames: PitchFrame[] = [];
  const total = Math.max(1, Math.ceil(x16.length / HOP));
  let lastYield = now();
  for (let start = 0, i = 0; start < x16.length; start += HOP, i++) {
    const r = yin.detect(padded, start);
    frames.push({ t: (start + yin.window / 2) / ANALYSIS_RATE, f0: r.f0, conf: r.conf, rms: r.rms });
    if (now() - lastYield > 30) {
      onProgress?.(i / total);
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = now();
    }
  }
  onProgress?.(1);
  const millis = now() - started;
  return { frames, x16, stats: { frames: frames.length, millis, millisPerFrame: millis / Math.max(1, frames.length) } };
}

/** Streaming tracker for live display while singing. */
export class LivePitch {
  private readonly resampler: Resampler;
  private yin: Yin;
  private buffer = new Float32Array(0);
  private read = 0;
  private produced = 0;
  lastMillisPerFrame = 0;

  constructor(inputRate: number, mode: InputMode) {
    this.resampler = new Resampler(inputRate, ANALYSIS_RATE);
    this.yin = makeYin(mode);
  }

  setMode(mode: InputMode): void {
    this.yin = makeYin(mode);
  }

  push(chunk: Float32Array): PitchFrame[] {
    const y = this.resampler.process(chunk);
    const merged = new Float32Array(this.buffer.length - this.read + y.length);
    merged.set(this.buffer.subarray(this.read));
    merged.set(y, this.buffer.length - this.read);
    this.buffer = merged;
    this.read = 0;
    const out: PitchFrame[] = [];
    const len = this.yin.frameLength;
    while (this.read + len <= this.buffer.length) {
      const t0 = now();
      const r = this.yin.detect(this.buffer, this.read);
      this.lastMillisPerFrame = now() - t0;
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
