// Round-trip latency, measured through the speaker and the microphone: short chirps are played at known frames of
// the audio clock and found again in what the microphone records, through the same path a take uses (the context's
// output, then MicCapture's context-frame timestamps). The result is how long after its scheduled time a sound shows
// up in a recording: what a take subtracts to line the voice up with the clicks it was sung to.
import { Fft } from '../dsp/fft';
import type { MicCapture } from './capture';

/**
 * Start of each chirp, seconds after the first. The gaps all differ (by 10 ms or more), so at a wrong delay at
 * most one chirp lines up with the recording, against all of them at the right one.
 */
export const PROBE_TIMES: readonly number[] = [0.42, 0.53, 0.45, 0.5, 0.44, 0.55, 0.47, 0.52, 0.49].reduce(
  (times, gap) => [...times, times[times.length - 1] + gap],
  [0],
);

/** The delays searched, seconds. Bluetooth speakers can take 300 ms; below 0 only an estimated timestamp can go. */
export const LAG_MIN = -0.05;
export const LAG_MAX = 0.6;

const PROBE_SECONDS = 0.01;
const PROBE_LOW_HZ = 1000;
const PROBE_HIGH_HZ = 6000;
const PROBE_LEVEL = 0.6;
/** Time for the microphone to start delivering before the first chirp. */
const LEAD_IN = 0.5;
/** A chirp counts as heard when its match peaks this far above the median of its search window... */
const HEARD_RATIO = 6;
/** ...and above this level relative to the chirp as played (-80 dB), so digital silence is never "heard"... */
const MIN_LEVEL = 1e-4;
/** ...within this distance of the delay found for all chirps together, seconds. */
const HEARD_WINDOW = 0.001;
/** The estimate stands when this share of the recorded chirps is heard, and at least MIN_HEARD of them. */
const HEARD_SHARE = 0.7;
const MIN_HEARD = 6;

/**
 * The chirp: 10 ms sweeping 1-6 kHz (what phone and laptop speakers play well) under a Hann window. Its match is
 * sharp (about 0.2 ms wide) and it sounds like a short tick.
 */
export function probeSignal(sampleRate: number): Float32Array {
  const n = Math.round(PROBE_SECONDS * sampleRate);
  const high = Math.min(PROBE_HIGH_HZ, 0.45 * sampleRate);
  const sweep = (high - PROBE_LOW_HZ) / PROBE_SECONDS;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    out[i] = PROBE_LEVEL * window * Math.sin(2 * Math.PI * (PROBE_LOW_HZ * t + 0.5 * sweep * t * t));
  }
  return out;
}

export interface LatencyEstimate {
  /** Seconds from a chirp's scheduled start to its start in the recording, or null when the chirps were not heard. */
  latency: number | null;
  /** Chirps heard at that delay, and chirps the recording covers. */
  heard: number;
  covered: number;
  /** Spread of the heard chirps' own delays (max - min), seconds. */
  spread: number;
}

/** One chirp's match at every delay searched, and the level a peak must reach to count as the chirp heard. */
export interface ChirpMatch {
  envelope: Float64Array;
  floor: number;
}

/**
 * Finds the chirps in a recording. The chirp that started playing at context frame f is looked for in the `span`
 * samples from frame f + lagMin (every delay from LAG_MIN to LAG_MAX), matched by FFT cross-correlation; the
 * analytic envelope is kept so the chirp's oscillation does not move the peak. The matches of all chirps are then
 * summed at each delay and the largest sum gives the delay.
 */
export class ChirpMatcher {
  readonly lagMin: number;
  readonly lags: number;
  /** Samples of recording one chirp is looked for in. */
  readonly span: number;
  private readonly fft: Fft;
  private readonly probeRe: Float64Array;
  private readonly probeIm: Float64Array;
  private readonly x: Float64Array;
  private readonly zeros: Float64Array;
  private readonly yRe: Float64Array;
  private readonly yIm: Float64Array;
  private readonly scratch: Float64Array;
  /** The envelope's peak for a chirp that arrives at MIN_LEVEL. */
  private readonly minPeak: number;

  constructor(readonly sampleRate: number) {
    const probe = probeSignal(sampleRate);
    this.lagMin = Math.floor(LAG_MIN * sampleRate);
    this.lags = Math.ceil(LAG_MAX * sampleRate) - this.lagMin + 1;
    this.span = this.lags + probe.length - 1;
    let n = 1;
    while (n < this.span) n <<= 1;
    this.fft = new Fft(n);
    this.zeros = new Float64Array(n);
    this.x = new Float64Array(n);
    this.x.set(probe);
    this.fft.transform(this.x, this.zeros);
    this.probeRe = this.fft.re.slice();
    this.probeIm = this.fft.im.slice();
    this.yRe = new Float64Array(n);
    this.yIm = new Float64Array(n);
    this.scratch = new Float64Array(this.lags);
    let energy = 0;
    for (const v of probe) energy += v * v;
    this.minPeak = MIN_LEVEL * energy;
  }

  /** The match of one chirp against `span` samples of recording from `start`. */
  match(recording: Float32Array, start: number): ChirpMatch {
    const { fft, x, yRe, yIm, probeRe, probeIm, span, lags } = this;
    const n = fft.n;
    x.fill(0);
    for (let i = 0; i < span; i++) x[i] = recording[start + i];
    fft.transform(x, this.zeros);
    // Cross-spectrum X conj(P), positive frequencies only (doubled): its inverse is the analytic correlation.
    // The inverse is taken as conj(DFT(conj Y)) without the 1/n (only ratios are used), and only its magnitude.
    yRe.fill(0);
    yIm.fill(0);
    for (let k = 0; k <= n / 2; k++) {
      const g = k === 0 || k === n / 2 ? 1 : 2;
      const ar = fft.re[k];
      const ai = fft.im[k];
      yRe[k] = g * (ar * probeRe[k] + ai * probeIm[k]);
      yIm[k] = -g * (ai * probeRe[k] - ar * probeIm[k]);
    }
    fft.transform(yRe, yIm);
    const envelope = new Float64Array(lags);
    for (let j = 0; j < lags; j++) envelope[j] = Math.sqrt(fft.re[j] * fft.re[j] + fft.im[j] * fft.im[j]);
    return { envelope, floor: Math.max(HEARD_RATIO * this.median(envelope), this.minPeak) };
  }

  /**
   * The delay of the chirps: the largest sum of their matches. Each chirp counts as heard if its own match peaks
   * near that delay above its floor; the estimate stands when most of the recorded chirps are heard.
   */
  combine(matches: ChirpMatch[]): LatencyEstimate {
    const covered = matches.length;
    const none: LatencyEstimate = { latency: null, heard: 0, covered, spread: 0 };
    if (covered < MIN_HEARD) return none;
    const { lags } = this;
    const sum = new Float64Array(lags);
    for (const m of matches) for (let j = 0; j < lags; j++) sum[j] += m.envelope[j];
    let best = 0;
    for (let j = 1; j < lags; j++) if (sum[j] > sum[best]) best = j;
    const reach = Math.round(HEARD_WINDOW * this.sampleRate);
    let heard = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const { envelope, floor } of matches) {
      let at = best;
      for (let j = Math.max(0, best - reach); j <= Math.min(lags - 1, best + reach); j++) if (envelope[j] > envelope[at]) at = j;
      if (envelope[at] > floor) {
        heard++;
        lo = Math.min(lo, at);
        hi = Math.max(hi, at);
      }
    }
    if (heard < Math.max(MIN_HEARD, Math.ceil(HEARD_SHARE * covered))) return { ...none, heard };
    return { latency: (this.lagMin + best) / this.sampleRate, heard, covered, spread: (hi - lo) / this.sampleRate };
  }

  /** Median (the upper middle value) by quickselect on a scratch copy. */
  private median(values: Float64Array): number {
    const a = this.scratch;
    a.set(values);
    const k = values.length >> 1;
    let lo = 0;
    let hi = values.length - 1;
    while (lo < hi) {
      const pivot = a[(lo + hi) >> 1];
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) {
          const t = a[i];
          a[i++] = a[j];
          a[j--] = t;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else break;
    }
    return a[k];
  }
}

/**
 * Finds the chirps in a recording whose first sample is context frame `firstFrame`; chirp k started playing at
 * context frame `emitted[k]`. Chirps the recording does not fully cover are left out.
 */
export function estimateLatency(recording: Float32Array, firstFrame: number, sampleRate: number, emitted: readonly number[]): LatencyEstimate {
  const matcher = new ChirpMatcher(sampleRate);
  const matches: ChirpMatch[] = [];
  for (const frame of emitted) {
    const start = frame + matcher.lagMin - firstFrame;
    if (start >= 0 && start + matcher.span <= recording.length) matches.push(matcher.match(recording, start));
  }
  return matcher.combine(matches);
}

/**
 * The browser's own estimate of the same round trip: output latency plus the microphone's reported latency.
 * Chromium's outputLatency already includes the callback buffer that baseLatency reports, Firefox reports
 * baseLatency as 0 and WebKit's is one render quantum, so adding the two would count the buffer twice: outputLatency
 * alone, or baseLatency where outputLatency is not reported. Chromium reports 0 until audio has started rendering.
 */
export function reportedLatency(ac: AudioContext, capture: MicCapture): number {
  return (ac.outputLatency || ac.baseLatency || 0) + capture.inputLatency;
}

/**
 * Plays the chirps through the context's output and records them with `capture` (an open microphone). Each chirp
 * is matched as soon as its stretch is recorded, so the work is spread over the measurement (about 5 s) instead
 * of freezing the page at the end. Stops early (and finds what it can) if the audio clock stalls, as it does when
 * a phone locks, and gives up (null) when `signal` aborts.
 */
export async function measureLatency(ac: AudioContext, capture: MicCapture, signal?: AbortSignal): Promise<LatencyEstimate> {
  const sr = ac.sampleRate;
  const matcher = new ChirpMatcher(sr);
  const probe = probeSignal(sr);
  const buffer = ac.createBuffer(1, probe.length, sr);
  buffer.getChannelData(0).set(probe);
  const first = Math.ceil((ac.currentTime + LEAD_IN) * sr);
  const emitted = PROBE_TIMES.map((t) => first + Math.round(t * sr));
  const end = emitted[emitted.length - 1] / sr + LAG_MAX + PROBE_SECONDS + 0.1;
  // The recording by context frame: frame `base + i` is rec[i]. Frames past the last chirp's stretch are not needed.
  const rec = new Float32Array(Math.ceil((end - ac.currentTime + 1) * sr));
  let base = -1;
  let recorded = 0;
  capture.listen((data, frame) => {
    if (base < 0) base = frame;
    const at = frame - base;
    if (at < 0 || at >= rec.length) return;
    const take = Math.min(data.length, rec.length - at);
    rec.set(take === data.length ? data : data.subarray(0, take), at);
    recorded = Math.max(recorded, at + take);
  });
  const sources = emitted.map((frame) => {
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(ac.destination);
    src.start(frame / sr);
    return src;
  });
  const matches: ChirpMatch[] = [];
  let next = 0;
  const matchRecorded = () => {
    for (; next < emitted.length && base >= 0; next++) {
      const start = emitted[next] + matcher.lagMin - base;
      if (start + matcher.span > recorded) break;
      // A chirp before the microphone started is not covered.
      if (start >= 0) matches.push(matcher.match(rec, start));
    }
  };
  const deadline = performance.now() + (end - ac.currentTime) * 1000 + 3000;
  while (!signal?.aborted && ac.currentTime < end && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    matchRecorded();
  }
  capture.listen(null);
  for (const src of sources) {
    src.stop();
    src.disconnect();
  }
  if (signal?.aborted) return { latency: null, heard: 0, covered: 0, spread: 0 };
  matchRecorded();
  return matcher.combine(matches);
}
