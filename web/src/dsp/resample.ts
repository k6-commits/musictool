// Streaming sample-rate converter: windowed-sinc low-pass, then linear interpolation.
// Used to bring 44.1/48 kHz microphone audio down to the 16 kHz analysis rate.

function designLowpass(numTaps: number, cutoff: number): Float32Array {
  // cutoff is normalized to the input rate (0..0.5).
  const h = new Float32Array(numTaps);
  const m = numTaps - 1;
  let sum = 0;
  for (let n = 0; n < numTaps; n++) {
    const k = n - m / 2;
    const sinc = k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / m) + 0.08 * Math.cos((4 * Math.PI * n) / m);
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < numTaps; n++) h[n] /= sum;
  return h;
}

export class Resampler {
  readonly ratio: number;
  private readonly taps: Float32Array | null;
  private history: Float32Array;
  private pending: Float32Array = new Float32Array(0);
  private pos = 0;

  constructor(readonly fromRate: number, readonly toRate: number) {
    this.ratio = fromRate / toRate;
    if (fromRate > toRate) {
      const numTaps = Math.max(31, Math.round(32 * this.ratio) | 1);
      this.taps = designLowpass(numTaps, (0.4 * toRate) / fromRate);
      this.history = new Float32Array(numTaps - 1);
    } else {
      this.taps = null;
      this.history = new Float32Array(0);
    }
  }

  /** Delay introduced by the filter, in output samples. */
  get delay(): number {
    return this.taps ? (this.taps.length - 1) / 2 / this.ratio : 0;
  }

  process(input: Float32Array): Float32Array {
    let filtered: Float32Array;
    if (this.taps) {
      const h = this.taps;
      const len = h.length;
      const ext = new Float32Array(this.history.length + input.length);
      ext.set(this.history);
      ext.set(input, this.history.length);
      filtered = new Float32Array(input.length);
      for (let n = 0; n < input.length; n++) {
        const base = n + len - 1;
        let s = 0;
        for (let k = 0; k < len; k++) s += h[k] * ext[base - k];
        filtered[n] = s;
      }
      this.history = ext.slice(ext.length - (len - 1));
    } else {
      filtered = input;
    }

    const buf = new Float32Array(this.pending.length + filtered.length);
    buf.set(this.pending);
    buf.set(filtered, this.pending.length);

    const out = new Float32Array(Math.max(0, Math.ceil((buf.length - this.pos) / this.ratio) + 1));
    let count = 0;
    let pos = this.pos;
    while (pos + 1 < buf.length) {
      const i = Math.floor(pos);
      const f = pos - i;
      out[count++] = buf[i] * (1 - f) + buf[i + 1] * f;
      pos += this.ratio;
    }
    const drop = Math.min(Math.floor(pos), buf.length);
    this.pending = buf.slice(drop);
    this.pos = pos - drop;
    return out.subarray(0, count);
  }
}

/** Offline conversion of a whole buffer, compensating the filter delay. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  const r = new Resampler(fromRate, toRate);
  const head = r.process(input);
  const tail = r.process(new Float32Array(Math.ceil(r.ratio * (r.delay + 2)) + 64));
  const all = new Float32Array(head.length + tail.length);
  all.set(head);
  all.set(tail, head.length);
  const skip = Math.round(r.delay);
  const want = Math.floor(input.length / r.ratio);
  return all.slice(skip, skip + want);
}
