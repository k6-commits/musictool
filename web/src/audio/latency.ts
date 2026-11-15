// Round-trip latency, measured through the speaker and the microphone: short chirps are played at known frames of
// the audio clock and found again in what the microphone records, through the same path a take uses (the context's
// output, then MicCapture's context-frame timestamps). The result is how long after its scheduled time a sound shows
// up in a recording: what a take subtracts to line the voice up with the clicks it was sung to.
import { Fft } from '../dsp/fft';
import { type MicCapture, TakeRecorder } from './capture';

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

/**
 * Finds the chirps in a recording whose first sample is context frame `firstFrame`; chirp k started playing at
 * context frame `emitted[k]`. Each chirp's stretch of recording (every delay from LAG_MIN to LAG_MAX) is matched
 * against the chirp by FFT cross-correlation, keeping the analytic envelope so the chirp's oscillation does not
 * move the peak. The envelopes are summed over the chirps at each delay and the largest sum gives the delay; each
 * chirp then counts as heard if its own envelope peaks near that delay well above its noise floor.
 */
export function estimateLatency(recording: Float32Array, firstFrame: number, sampleRate: number, emitted: readonly number[]): LatencyEstimate {
  const probe = probeSignal(sampleRate);
  const lagMin = Math.floor(LAG_MIN * sampleRate);
  const lags = Math.ceil(LAG_MAX * sampleRate) - lagMin + 1;
  const span = lags + probe.length - 1;
  let n = 1;
  while (n < span) n <<= 1;
  const fft = new Fft(n);
  const zeros = new Float64Array(n);
  const x = new Float64Array(n);
  x.set(probe);
  fft.transform(x, zeros);
  const probeRe = fft.re.slice();
  const probeIm = fft.im.slice();
  const yRe = new Float64Array(n);
  const yIm = new Float64Array(n);

  const envelopes: Float64Array[] = [];
  for (const frame of emitted) {
    const start = frame + lagMin - firstFrame;
    if (firstFrame < 0 || start < 0 || start + span > recording.length) continue;
    x.fill(0);
    for (let i = 0; i < span; i++) x[i] = recording[start + i];
    fft.transform(x, zeros);
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
    const env = new Float64Array(lags);
    for (let j = 0; j < lags; j++) env[j] = Math.sqrt(fft.re[j] * fft.re[j] + fft.im[j] * fft.im[j]);
    envelopes.push(env);
  }

  const covered = envelopes.length;
  const none: LatencyEstimate = { latency: null, heard: 0, covered, spread: 0 };
  if (covered < MIN_HEARD) return none;
  const sum = new Float64Array(lags);
  for (const env of envelopes) for (let j = 0; j < lags; j++) sum[j] += env[j];
  let best = 0;
  for (let j = 1; j < lags; j++) if (sum[j] > sum[best]) best = j;

  const reach = Math.round(HEARD_WINDOW * sampleRate);
  let heard = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const env of envelopes) {
    let at = best;
    for (let j = Math.max(0, best - reach); j <= Math.min(lags - 1, best + reach); j++) if (env[j] > env[at]) at = j;
    if (env[at] >= HEARD_RATIO * median(env)) {
      heard++;
      lo = Math.min(lo, at);
      hi = Math.max(hi, at);
    }
  }
  if (heard < Math.max(MIN_HEARD, Math.ceil(HEARD_SHARE * covered))) return { ...none, heard };
  return { latency: (lagMin + best) / sampleRate, heard, covered, spread: (hi - lo) / sampleRate };
}

function median(values: Float64Array): number {
  const sorted = values.slice().sort();
  return sorted[sorted.length >> 1];
}

/**
 * The browser's own estimate of the same round trip: output latency plus the microphone's reported latency.
 * Chromium's outputLatency already includes the callback buffer that baseLatency reports, Firefox reports
 * baseLatency as 0 and WebKit's is one render quantum, so adding the two would count the buffer twice: outputLatency
 * alone, or baseLatency where outputLatency is not reported. Some browsers report 0 until audio has been running.
 */
export function reportedLatency(ac: AudioContext, capture: MicCapture): number {
  return (ac.outputLatency || ac.baseLatency || 0) + capture.inputLatency;
}

/**
 * Plays the chirps through the context's output and records them with `capture` (an open microphone), then finds
 * them. Takes about 5 s. Stops early (and finds what it can) if the audio clock stalls, as it does when a phone
 * locks or the page goes to the background.
 */
export async function measureLatency(ac: AudioContext, capture: MicCapture): Promise<LatencyEstimate> {
  // Opening the microphone can pause the audio clock (iOS switches its audio session).
  if (ac.state !== 'running') await ac.resume();
  const sr = ac.sampleRate;
  const probe = probeSignal(sr);
  const buffer = ac.createBuffer(1, probe.length, sr);
  buffer.getChannelData(0).set(probe);
  const recorder = new TakeRecorder();
  capture.listen((data, frame) => recorder.push(data, frame));
  const first = Math.ceil((ac.currentTime + LEAD_IN) * sr);
  const emitted = PROBE_TIMES.map((t) => first + Math.round(t * sr));
  const sources = emitted.map((frame) => {
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(ac.destination);
    src.start(frame / sr);
    return src;
  });
  const end = emitted[emitted.length - 1] / sr + LAG_MAX + PROBE_SECONDS + 0.1;
  const deadline = performance.now() + (end - ac.currentTime) * 1000 + 3000;
  try {
    while (ac.currentTime < end && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    capture.listen(null);
    for (const src of sources) {
      try {
        src.stop();
      } catch {
        /* never started */
      }
      src.disconnect();
    }
  }
  const samples = new Float32Array(recorder.samples);
  recorder.moveInto(samples);
  return estimateLatency(samples, recorder.firstFrame, sr, emitted);
}
