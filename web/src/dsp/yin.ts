// YIN fundamental-frequency estimator (de Cheveigné & Kawahara, 2002)
// with parabolic interpolation. Returns 0 Hz for unvoiced frames.

export interface YinOptions {
  sampleRate: number;
  fmin: number;
  fmax: number;
  /** Integration window in samples. */
  window: number;
}

export interface YinResult {
  f0: number;
  /** 1 - d'(tau): close to 1 for clean periodic sound. */
  conf: number;
  rms: number;
}

export class Yin {
  readonly sampleRate: number;
  readonly window: number;
  readonly tauMin: number;
  readonly tauMax: number;
  readonly threshold: number;
  /** Samples needed from `offset` for one detection. */
  readonly frameLength: number;
  private readonly cmnd: Float64Array;

  constructor(opts: YinOptions) {
    this.sampleRate = opts.sampleRate;
    this.window = opts.window;
    this.tauMin = Math.max(2, Math.floor(opts.sampleRate / opts.fmax));
    this.tauMax = Math.ceil(opts.sampleRate / opts.fmin);
    this.threshold = 0.15;
    this.frameLength = this.window + this.tauMax + 2;
    this.cmnd = new Float64Array(this.tauMax + 2);
  }

  detect(x: Float32Array, offset = 0): YinResult {
    const w = this.window;
    let energy = 0;
    for (let j = 0; j < w; j++) {
      const v = x[offset + j];
      energy += v * v;
    }
    const rms = Math.sqrt(energy / w);
    if (rms < 1e-5) return { f0: 0, conf: 0, rms };

    // Cumulative mean normalized difference, computed lag by lag and only as far as needed:
    // the search stops at the first dip below the threshold (same result as computing every lag).
    const c = this.cmnd;
    const last = this.tauMax + 1;
    c[0] = 1;
    let running = 0;
    let computed = 0;
    const lag = (t: number) => {
      while (computed < t) {
        const tau = ++computed;
        let s = 0;
        for (let j = 0; j < w; j++) {
          const d = x[offset + j] - x[offset + j + tau];
          s += d * d;
        }
        running += s;
        c[tau] = running > 0 ? (s * tau) / running : 1;
      }
      return c[t];
    };

    let tau = -1;
    for (let t = this.tauMin; t <= this.tauMax; t++) {
      if (lag(t) < this.threshold) {
        while (t + 1 <= this.tauMax && lag(t + 1) < c[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = this.tauMin;
      for (let t = this.tauMin + 1; t <= this.tauMax; t++) if (c[t] < c[best]) best = t;
      if (c[best] > 0.45) return { f0: 0, conf: Math.max(0, 1 - c[best]), rms };
      tau = best;
    }
    if (tau < last) lag(tau + 1);

    let refined = tau;
    if (tau > 1 && tau < last) {
      const a = c[tau - 1];
      const b = c[tau];
      const d = c[tau + 1];
      const denom = a + d - 2 * b;
      if (Math.abs(denom) > 1e-12) refined = tau + (a - d) / (2 * denom);
    }
    return { f0: this.sampleRate / refined, conf: Math.max(0, Math.min(1, 1 - c[tau])), rms };
  }
}
