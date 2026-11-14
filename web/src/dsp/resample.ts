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

  /** Output samples to drop at the start so the output lines up with the input. */
  get skip(): number {
    return Math.round(this.delay);
  }

  /** Length of the aligned output for `inputLength` input samples. */
  outputLength(inputLength: number): number {
    return this.fromRate === this.toRate ? inputLength : Math.floor(inputLength / this.ratio);
  }

  /** Zeros to push through at the end so the filter's tail comes out. */
  get flushLength(): number {
    return Math.ceil(this.ratio * (this.delay + 2)) + 64;
  }

  process(input: Float32Array): Float32Array {
    // Virtual buffer: the filtered samples carried over from the last call, then this call's filtered input.
    // Filtered samples are computed only where the interpolator reads them (every third one at 48 kHz).
    const pending = this.pending;
    const P = pending.length;
    const total = P + input.length;
    const h = this.taps;
    const ext = h ? new Float32Array(this.history.length + input.length) : null;
    if (ext) {
      ext.set(this.history);
      ext.set(input, this.history.length);
    }
    const filtered = h ? new Float32Array(input.length) : input;
    const ready = h ? new Uint8Array(input.length) : null;
    const at = (b: number): number => {
      if (b < P) return pending[b];
      const n = b - P;
      if (h && ext && ready && !ready[n]) {
        const base = n + h.length - 1;
        let s = 0;
        for (let k = 0; k < h.length; k++) s += h[k] * ext[base - k];
        filtered[n] = s;
        ready[n] = 1;
      }
      return filtered[n];
    };

    const out = new Float32Array(Math.max(0, Math.ceil((total - this.pos) / this.ratio) + 1));
    let count = 0;
    let pos = this.pos;
    while (pos + 1 < total) {
      const i = Math.floor(pos);
      const f = pos - i;
      out[count++] = f === 0 ? at(i) : at(i) * (1 - f) + at(i + 1) * f;
      pos += this.ratio;
    }
    const drop = Math.min(Math.floor(pos), total);
    const rest = new Float32Array(total - drop);
    for (let b = drop; b < total; b++) rest[b - drop] = at(b);
    this.pending = rest;
    this.pos = pos - drop;
    if (h && ext) this.history = ext.slice(ext.length - (h.length - 1));
    return out.subarray(0, count);
  }
}

/**
 * A Resampler whose output lines up with its input: the filter delay is dropped at the start, and once finish()
 * is called the output has exactly outputLength(input) samples (the filter's tail, then zeros if needed).
 */
export class AlignedResampler {
  private readonly r: Resampler;
  private skipped = 0;
  private written = 0;
  private input = 0;

  constructor(fromRate: number, toRate: number) {
    this.r = new Resampler(fromRate, toRate);
  }

  push(x: Float32Array): Float32Array {
    this.input += x.length;
    return this.take(this.r.process(x), Infinity);
  }

  finish(): Float32Array {
    const want = this.r.outputLength(this.input);
    const tail = this.take(this.r.process(new Float32Array(this.r.flushLength)), want);
    const out = new Float32Array(tail.length + Math.max(0, want - this.written));
    out.set(tail);
    this.written = want;
    return out;
  }

  private take(y: Float32Array, limit: number): Float32Array {
    let from = 0;
    if (this.skipped < this.r.skip) {
      from = Math.min(this.r.skip - this.skipped, y.length);
      this.skipped += from;
    }
    const to = Math.max(from, Math.min(y.length, from + Math.max(0, limit - this.written)));
    this.written += to - from;
    return y.subarray(from, to);
  }
}

/** Offline conversion of a whole buffer, compensating the filter delay. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  const r = new AlignedResampler(fromRate, toRate);
  const head = r.push(input);
  const tail = r.finish();
  const all = new Float32Array(head.length + tail.length);
  all.set(head);
  all.set(tail, head.length);
  return all;
}
