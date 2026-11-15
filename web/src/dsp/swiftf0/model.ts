// SwiftF0 (Nieradzik 2025, MIT License): a small CNN on log-frequency spectrograms that gives a pitch and a voicing
// confidence for every 16 ms of 16 kHz audio. This is a TypeScript port of the swift-f0 0.3.0 ONNX model: three
// STFTs (1024, 2048 and 512 points, hop 256), log-frequency filters, 18 convolutions (BatchNorm folded in) and the
// package's decoding. Frame i is centered on sample 256 * i. The network sees 7 frames on each side, so any stretch
// of frames can be computed on its own from 7 frames of context and gives the same result.
// The convolutions run in a small WebAssembly SIMD kernel (wasm/swiftf0-kernel.ts) when the browser has it, and in
// plain TypeScript otherwise; both give the same numbers up to float rounding.
import { Fft } from '../fft';
import { KERNEL_WASM } from './kernel';
import { CONVS, FILTERS, WINDOWS } from './weights';

export const SF0_HOP = 256;
/** The 95 output bins are spaced evenly in log frequency from MIN_HZ to MAX_HZ. */
const MIN_HZ = 46.875;
const MAX_HZ = 2093.75;
/** Frames of context the network needs on each side of a frame. */
export const SF0_CONTEXT = 7;

const SIZES = [1024, 2048, 512];
const N_LOG = 128;
const N_BINS = 95;
const CH = 12;
const LOG_FLOOR = Math.fround(1e-8);
/** A frame whose 16 ms of audio peaks below this gets confidence 0 (digital silence confuses the model). */
const SILENCE_PEAK = 1e-3;

function bytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function floats(b64: string): Float32Array {
  return new Float32Array(bytes(b64).buffer);
}

interface Conv {
  co: number;
  ci: number;
  /** Kernel rows (frequency) and columns (time: 1, or 3 for frames t - 1, t, t + 1). */
  kh: number;
  kw: number;
  /** Dilation and padding (before) along frequency. */
  dh: number;
  ph0: number;
  w: Float32Array;
  b: Float32Array;
}

// ---------------------------------------------------------------- convolution backends
// Activations are planes of rows x stride floats; each row holds its frames at columns 1..cols with a zero column
// on each side, which is the time padding of the 3-wide kernels. Only columns 1..cols are ever written.

interface Buf {
  f: Float32Array;
  ptr: number;
}

interface Backend {
  readonly name: string;
  /** Zeroed buffers of the given sizes (in floats), valid until the next call. */
  buffers(sizes: number[]): Buf[];
  conv(layer: number, x: Buf, y: Buf, rows: number, outRows: number, cols: number, stride: number): void;
  relu(x: Buf, n: number): void;
  addRelu(h: Buf, d: Buf, n: number): void;
}

class JsBackend implements Backend {
  readonly name = 'js';
  constructor(private readonly convs: Conv[]) {}

  buffers(sizes: number[]): Buf[] {
    return sizes.map((n) => ({ f: new Float32Array(n), ptr: 0 }));
  }

  conv(layer: number, xb: Buf, yb: Buf, rows: number, outRows: number, cols: number, stride: number): void {
    const c = this.convs[layer];
    const x = xb.f;
    const y = yb.f;
    const inPlane = rows * stride;
    const outPlane = outRows * stride;
    for (let o = 0; o < c.co; o++) for (let r = 0; r < outRows; r++) y.fill(c.b[o], o * outPlane + r * stride + 1, o * outPlane + r * stride + 1 + cols);
    const { w, kh, kw, ci, co } = c;
    const wq = ci * kh * kw;
    for (let o = 0; o < co; o += 4) {
      const live = Math.min(4, co - o);
      for (let i = 0; i < ci; i++) {
        for (let a = 0; a < kh; a++) {
          const dy = a * c.dh - c.ph0;
          const r0 = Math.max(0, -dy);
          const r1 = Math.min(outRows, rows - dy);
          const wb = ((o * ci + i) * kh + a) * kw;
          for (let r = r0; r < r1; r++) {
            const s = i * inPlane + (r + dy) * stride + 1;
            const d0 = o * outPlane + r * stride + 1;
            if (live === 4 && kw === 1) {
              const w0 = w[wb];
              const w1 = w[wb + wq];
              const w2 = w[wb + 2 * wq];
              const w3 = w[wb + 3 * wq];
              const d1 = d0 + outPlane;
              const d2 = d1 + outPlane;
              const d3 = d2 + outPlane;
              for (let t = 0; t < cols; t++) {
                const v = x[s + t];
                y[d0 + t] += w0 * v;
                y[d1 + t] += w1 * v;
                y[d2 + t] += w2 * v;
                y[d3 + t] += w3 * v;
              }
            } else if (live === 4) {
              const a0 = w[wb];
              const b0 = w[wb + 1];
              const c0 = w[wb + 2];
              const a1 = w[wb + wq];
              const b1 = w[wb + wq + 1];
              const c1 = w[wb + wq + 2];
              const a2 = w[wb + 2 * wq];
              const b2 = w[wb + 2 * wq + 1];
              const c2 = w[wb + 2 * wq + 2];
              const a3 = w[wb + 3 * wq];
              const b3 = w[wb + 3 * wq + 1];
              const c3 = w[wb + 3 * wq + 2];
              const d1 = d0 + outPlane;
              const d2 = d1 + outPlane;
              const d3 = d2 + outPlane;
              let prev = x[s - 1];
              let cur = x[s];
              for (let t = 0; t < cols; t++) {
                const next = x[s + t + 1];
                y[d0 + t] += a0 * prev + b0 * cur + c0 * next;
                y[d1 + t] += a1 * prev + b1 * cur + c1 * next;
                y[d2 + t] += a2 * prev + b2 * cur + c2 * next;
                y[d3 + t] += a3 * prev + b3 * cur + c3 * next;
                prev = cur;
                cur = next;
              }
            } else {
              for (let q = 0; q < live; q++) {
                const k = wb + q * wq;
                const d = d0 + q * outPlane;
                if (kw === 1) {
                  for (let t = 0; t < cols; t++) y[d + t] += w[k] * x[s + t];
                } else {
                  for (let t = 0; t < cols; t++) y[d + t] += w[k] * x[s + t - 1] + w[k + 1] * x[s + t] + w[k + 2] * x[s + t + 1];
                }
              }
            }
          }
        }
      }
    }
  }

  relu(x: Buf, n: number): void {
    const f = x.f;
    for (let i = 0; i < n; i++) if (f[i] < 0) f[i] = 0;
  }

  addRelu(h: Buf, d: Buf, n: number): void {
    const a = h.f;
    const b = d.f;
    for (let i = 0; i < n; i++) {
      const v = a[i] + b[i];
      a[i] = v > 0 ? v : 0;
    }
  }
}

interface KernelExports {
  memory: WebAssembly.Memory;
  conv: (...args: number[]) => void;
  relu: (y: number, n: number) => void;
  addRelu: (h: number, d: number, n: number) => void;
}

class WasmBackend implements Backend {
  readonly name = 'wasm-simd';
  private readonly k: KernelExports;
  private readonly layers: { w: number; b: number; c: Conv }[] = [];
  private readonly heap: number;

  constructor(instance: WebAssembly.Instance, convs: Conv[]) {
    this.k = instance.exports as unknown as KernelExports;
    // Weights live after the kernel's own (tiny) static data, from 64 KiB on.
    let p = 65536;
    const placed: { w: number; b: number; c: Conv }[] = [];
    for (const c of convs) {
      placed.push({ w: p, b: p + c.w.length * 4, c });
      p += (c.w.length + c.b.length) * 4;
    }
    this.ensure(p);
    const f = new Float32Array(this.k.memory.buffer);
    for (const l of placed) {
      f.set(l.c.w, l.w / 4);
      f.set(l.c.b, l.b / 4);
    }
    this.layers = placed;
    this.heap = Math.ceil(p / 16) * 16;
  }

  private ensure(end: number): void {
    const have = this.k.memory.buffer.byteLength;
    if (end > have) this.k.memory.grow(Math.ceil((end - have) / 65536));
  }

  buffers(sizes: number[]): Buf[] {
    const ptrs: number[] = [];
    let p = this.heap;
    for (const n of sizes) {
      ptrs.push(p);
      p += Math.ceil((n * 4) / 16) * 16;
    }
    this.ensure(p);
    const all = new Float32Array(this.k.memory.buffer);
    all.fill(0, this.heap / 4, p / 4);
    return sizes.map((n, i) => ({ f: new Float32Array(this.k.memory.buffer, ptrs[i], n), ptr: ptrs[i] }));
  }

  conv(layer: number, x: Buf, y: Buf, rows: number, outRows: number, cols: number, stride: number): void {
    const { w, b, c } = this.layers[layer];
    this.k.conv(x.ptr, y.ptr, w, b, c.co, c.ci, c.kh, c.kw, c.dh, c.ph0, rows, outRows, cols, stride);
  }

  relu(x: Buf, n: number): void {
    this.k.relu(x.ptr, n);
  }

  addRelu(h: Buf, d: Buf, n: number): void {
    this.k.addRelu(h.ptr, d.ptr, n);
  }
}

// ---------------------------------------------------------------- model

interface Net {
  backend: Backend;
  windows: Float32Array[];
  filters: { starts: number[]; lengths: number[]; offsets: number[]; w: Float32Array }[];
  logCenters: Float64Array;
  ffts: Fft[];
}

let net: Net | null = null;
let forceJs = false;

/** Use the plain TypeScript convolutions even where WebAssembly SIMD is available (for tests). */
export function useJsKernel(on: boolean): void {
  forceJs = on;
  net = null;
}

function load(): Net {
  if (net) return net;
  const convs = CONVS.map((c): Conv => {
    const twoD = c.shape.length === 4;
    // ONNX layouts: 2-D [co, ci, kh, kw] with pads [rows begin, cols begin, rows end, cols end]; 1-D (the
    // confidence head) [co, ci, k] over time only, run here as a 1 x k kernel on a single row.
    const [co, ci, k1, k2] = c.shape;
    const conv: Conv = {
      co,
      ci,
      kh: twoD ? k1 : 1,
      kw: twoD ? k2 : k1,
      dh: twoD ? c.dilation[0] : 1,
      ph0: twoD ? c.pads[0] : 0,
      w: floats(c.w),
      b: floats(c.b),
    };
    const timePad = twoD ? c.pads[1] : c.pads[0];
    if (!(conv.kw === 1 && timePad === 0) && !(conv.kw === 3 && timePad === 1)) throw new Error('unexpected SwiftF0 layer');
    return conv;
  });
  const filters = FILTERS.map((f) => {
    const offsets: number[] = [];
    let o = 0;
    for (const len of f.lengths) {
      offsets.push(o);
      o += len;
    }
    return { starts: f.starts, lengths: f.lengths, offsets, w: floats(f.w) };
  });
  // Bin centers as the model stores them (float32), then their logs for decoding.
  const logCenters = Float64Array.from({ length: N_BINS }, (_, b) => Math.log(Math.fround(MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, b / (N_BINS - 1)))));
  let backend: Backend = new JsBackend(convs);
  if (!forceJs && typeof WebAssembly === 'object') {
    try {
      const code = bytes(KERNEL_WASM);
      // Without SIMD support the module does not validate; the kernel is under 4 KiB, so synchronous compilation
      // is allowed on the main thread.
      if (WebAssembly.validate(code)) backend = new WasmBackend(new WebAssembly.Instance(new WebAssembly.Module(code), {}), convs);
    } catch {
      /* keep the TypeScript kernel */
    }
  }
  net = { backend, windows: WINDOWS.map(floats), filters, logCenters, ffts: SIZES.map((n) => new Fft(n)) };
  return net;
}

/** Which convolution kernel runs: "wasm-simd" or "js". */
export function kernelName(): string {
  return load().backend.name;
}

export interface Sf0Frames {
  /** Pitch in Hz per frame. */
  pitch: Float64Array;
  /** Voicing confidence 0..1 (voiced at 0.5 or more). */
  conf: Float32Array;
  /** Level of the 32 ms centered on the frame (RMS, linear). */
  rms: Float32Array;
}

/** Number of frames SwiftF0 gives for `samples` samples of 16 kHz audio. */
export function frameCount(samples: number): number {
  return Math.max(1, Math.floor(samples / SF0_HOP));
}

/**
 * Frames [first, last) of 16 kHz audio. `x` holds the samples from `base` on (`x[0]` is sample `base`); samples
 * outside it count as zero, so it must reach the signal's end, or 1024 samples past frame last + 7 (and back to
 * 1024 samples before frame first - 7). The whole signal has `total` frames (frameCount).
 */
export function swiftF0Frames(x: Float32Array, base: number, total: number, first: number, last: number): Sf0Frames {
  const n = load();
  const be = n.backend;
  const from = Math.max(0, first - SF0_CONTEXT);
  const to = Math.min(total, last + SF0_CONTEXT);
  const cols = to - from;
  const stride = cols + 2;
  const sample = (k: number) => {
    const j = k - base;
    return j >= 0 && j < x.length ? x[j] : 0;
  };
  const [feat, h, inner, out, low, proj, corr, logits, head, hidden, confLogit] = be.buffers([
    3 * N_LOG * stride,
    CH * N_LOG * stride,
    CH * N_LOG * stride,
    CH * N_LOG * stride,
    CH * 96 * stride,
    4 * N_BINS * stride,
    4 * N_BINS * stride,
    N_BINS * stride,
    5 * stride,
    16 * stride,
    stride,
  ]);
  // Features: 3 STFTs x 128 log-frequency bands x frames, two frames per FFT.
  const magA = new Float64Array(1025);
  const magB = new Float64Array(1025);
  for (let s = 0; s < 3; s++) {
    const size = SIZES[s];
    const fft = n.ffts[s];
    const win = n.windows[s];
    const frameA = new Float64Array(size);
    const frameB = new Float64Array(size);
    const flt = n.filters[s];
    const window = (frame: Float64Array, c: number) => {
      const start = (from + c) * SF0_HOP - size / 2;
      for (let k = 0; k < size; k++) frame[k] = Math.fround(sample(start + k) * win[k]);
    };
    const bands = (mag: Float64Array, c: number) => {
      for (let band = 0; band < N_LOG; band++) {
        let acc = 0;
        const st = flt.starts[band];
        const off = flt.offsets[band];
        for (let q = 0; q < flt.lengths[band]; q++) acc += mag[st + q] * flt.w[off + q];
        feat.f[(s * N_LOG + band) * stride + 1 + c] = Math.log(Math.fround(acc) + LOG_FLOOR);
      }
    };
    for (let c = 0; c < cols; c += 2) {
      window(frameA, c);
      if (c + 1 < cols) window(frameB, c + 1);
      else frameB.fill(0);
      fft.magnitudes(frameA, frameB, magA, magB);
      bands(magA, c);
      if (c + 1 < cols) bands(magB, c + 1);
    }
  }
  // Network: stem, six residual blocks, projection to 95 pitch bins, pitch and confidence heads.
  const planes = CH * N_LOG * stride;
  be.conv(0, feat, h, N_LOG, N_LOG, cols, stride);
  be.relu(h, planes);
  for (let blk = 0; blk < 6; blk++) {
    be.conv(1 + 2 * blk, h, inner, N_LOG, N_LOG, cols, stride);
    be.relu(inner, planes);
    be.conv(2 + 2 * blk, inner, out, N_LOG, N_LOG, cols, stride);
    be.addRelu(h, out, planes);
  }
  for (let ch = 0; ch < CH; ch++) low.f.set(h.f.subarray(ch * N_LOG * stride, (ch * N_LOG + 96) * stride), ch * 96 * stride);
  be.conv(13, low, proj, 96, N_BINS, cols, stride);
  be.relu(proj, 4 * N_BINS * stride);
  be.conv(14, proj, corr, N_BINS, N_BINS, cols, stride);
  be.conv(15, proj, logits, N_BINS, N_BINS, cols, stride);
  for (let ch = 0; ch < 4; ch++) {
    for (let c = 1; c <= cols; c++) {
      let m = -Infinity;
      for (let b = 0; b < N_BINS; b++) m = Math.max(m, corr.f[(ch * N_BINS + b) * stride + c]);
      head.f[ch * stride + c] = m;
    }
  }
  for (let c = 1; c <= cols; c++) {
    let s = 0;
    for (let r = 0; r < 3 * N_LOG; r++) s += feat.f[r * stride + c];
    head.f[4 * stride + c] = s / (3 * N_LOG);
  }
  be.conv(16, head, hidden, 1, 1, cols, stride);
  be.relu(hidden, 16 * stride);
  be.conv(17, hidden, confLogit, 1, 1, cols, stride);

  const count = last - first;
  const res: Sf0Frames = { pitch: new Float64Array(count), conf: new Float32Array(count), rms: new Float32Array(count) };
  const L = logits.f;
  for (let k = 0; k < count; k++) {
    const c = first - from + k + 1;
    let peak = 0;
    for (let b = 1; b < N_BINS; b++) if (L[b * stride + c] > L[peak * stride + c]) peak = b;
    // Softmax over the peak bin and its neighbours, then a weighted mean of their log frequencies.
    const top = L[peak * stride + c];
    let wsum = 0;
    let acc = 0;
    for (let d = -1; d <= 1; d++) {
      const b = peak + d;
      if (b < 0 || b >= N_BINS) continue;
      const wv = Math.exp(L[b * stride + c] - top);
      wsum += wv;
      acc += wv * n.logCenters[b];
    }
    res.pitch[k] = Math.exp(acc / wsum);
    res.conf[k] = 1 / (1 + Math.exp(-confLogit.f[c]));
    // The package's level and silence rule: the 32 ms around the frame, and the 16 ms hop after its center.
    const fi = first + k;
    let p0 = 0;
    let p1 = 0;
    let hopPeak = 0;
    for (let q = 0; q < SF0_HOP; q++) {
      const a = fi > 0 ? sample((fi - 1) * SF0_HOP + q) : 0;
      const b = sample(fi * SF0_HOP + q);
      p0 += a * a;
      p1 += b * b;
      hopPeak = Math.max(hopPeak, Math.abs(b));
    }
    res.rms[k] = Math.sqrt((p0 + p1) / (2 * SF0_HOP));
    if (hopPeak < SILENCE_PEAK) res.conf[k] = 0;
  }
  return res;
}

/**
 * SwiftF0 over a stream of 16 kHz samples. A frame is computed once the audio 7 frames (and one 2048-point
 * window) past it has arrived, in batches, so a long take never needs the whole spectrogram in memory; finish()
 * returns the rest. The frames are exactly those of swiftF0Frames on the whole signal. Each batch is one
 * synchronous computation of about `batch` + 14 frames (the 7 frames of context on each side are computed again).
 */
export class SwiftF0Stream {
  private buf = new Float32Array(1 << 16);
  private len = 0;
  /** Sample index of buf[0]; the stream has had base + len samples. */
  private base = 0;
  private emitted = 0;

  constructor(private readonly batch = 128) {}

  push(x: Float32Array): Sf0Frames | null {
    if (this.len + x.length > this.buf.length) {
      const grown = new Float32Array(Math.max(this.buf.length * 2, this.len + x.length));
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    this.buf.set(x, this.len);
    this.len += x.length;
    // Frame i is final when the 2048-point window of frame i + 7 is complete.
    const ready = Math.floor((this.base + this.len - 1024) / SF0_HOP) - SF0_CONTEXT;
    if (ready - this.emitted < this.batch) return null;
    return this.run(ready, Number.MAX_SAFE_INTEGER);
  }

  finish(): Sf0Frames | null {
    const total = frameCount(this.base + this.len);
    return this.emitted < total ? this.run(total, total) : null;
  }

  private run(last: number, total: number): Sf0Frames {
    const out = swiftF0Frames(this.buf.subarray(0, this.len), this.base, total, this.emitted, last);
    this.emitted = last;
    // Keep what the next frames need: their context and the half window before it.
    const keepFrom = Math.max(0, (this.emitted - SF0_CONTEXT) * SF0_HOP - 1024);
    const drop = keepFrom - this.base;
    if (drop > 0) {
      this.buf.copyWithin(0, drop, this.len);
      this.len -= drop;
      this.base = keepFrom;
    }
    return out;
  }
}
