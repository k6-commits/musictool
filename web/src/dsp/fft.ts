/**
 * Radix-2 complex FFT (forward, unnormalized). Two real signals can go through one transform (one as the real
 * part, one as the imaginary part) and be separated afterwards, which halves the work for real input
 * (`magnitudes`, used by SwiftF0's three STFTs).
 */
export class Fft {
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  readonly re: Float64Array;
  readonly im: Float64Array;

  constructor(readonly n: number) {
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /** Magnitude spectra (bins 0..n/2) of the real frames a and b, into magA and magB. */
  magnitudes(a: Float64Array, b: Float64Array, magA: Float64Array, magB: Float64Array): void {
    const { n, re, im } = this;
    this.transform(a, b);
    for (let k = 0; k <= n / 2; k++) {
      const j = (n - k) & (n - 1);
      // A(k) = (Z(k) + conj Z(n-k)) / 2, B(k) = (Z(k) - conj Z(n-k)) / 2i.
      const ar = re[k] + re[j];
      const ai = im[k] - im[j];
      const br = im[k] + im[j];
      const bi = re[j] - re[k];
      magA[k] = 0.5 * Math.sqrt(ar * ar + ai * ai);
      magB[k] = 0.5 * Math.sqrt(br * br + bi * bi);
    }
  }

  /** DFT of the complex signal inRe + i inIm (n samples each, not `re` or `im` themselves), into `re` and `im`. */
  transform(inRe: ArrayLike<number>, inIm: ArrayLike<number>): void {
    const { n, rev, re, im, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      re[rev[i]] = inRe[i];
      im[rev[i]] = inIm[i];
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}
