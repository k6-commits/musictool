// SwiftF0 convolution kernel, compiled to src/dsp/swiftf0/kernel.ts by scripts/build-wasm.mjs (npm run build:wasm).
// AssemblyScript with WebAssembly SIMD; src/dsp/swiftf0/model.ts falls back to the same loops in TypeScript.
// Activations are planes of `rows` rows x `stride` floats; a row holds its `cols` frames at columns 1..cols, with a
// zero column on each side (time padding). Weights are in ONNX order [co][ci][kh][kw]; kw is 1 or 3 (taps t-1, t, t+1).

export function conv(
  x: usize, y: usize, w: usize, b: usize,
  co: i32, ci: i32, kh: i32, kw: i32, dh: i32, ph0: i32,
  rows: i32, outRows: i32, cols: i32, stride: i32,
): void {
  const inPlane = <usize>(rows * stride) << 2;
  const outPlane = <usize>(outRows * stride) << 2;
  const rowBytes = <usize>stride << 2;
  // Bias.
  for (let o = 0; o < co; o++) {
    const bv = load<f32>(b + (<usize>o << 2));
    const bvv = f32x4.splat(bv);
    for (let r = 0; r < outRows; r++) {
      const p = y + <usize>o * outPlane + <usize>r * rowBytes + 4;
      let t = 0;
      for (; t + 4 <= cols; t += 4) v128.store(p + (<usize>t << 2), bvv);
      for (; t < cols; t++) store<f32>(p + (<usize>t << 2), bv);
    }
  }
  const wStride = ci * kh * kw;
  for (let o = 0; o < co; o += 4) {
    const live = min(4, co - o);
    for (let i = 0; i < ci; i++) {
      for (let a = 0; a < kh; a++) {
        const dy = a * dh - ph0;
        const r0 = max(0, -dy);
        const r1 = min(outRows, rows - dy);
        if (r1 <= r0) continue;
        const wBase = w + (<usize>(((o * ci + i) * kh + a) * kw) << 2);
        const wq = <usize>(wStride) << 2;
        if (live == 4 && kw == 1) {
          const w0 = f32x4.splat(load<f32>(wBase));
          const w1 = f32x4.splat(load<f32>(wBase + wq));
          const w2 = f32x4.splat(load<f32>(wBase + 2 * wq));
          const w3 = f32x4.splat(load<f32>(wBase + 3 * wq));
          const s0 = load<f32>(wBase), s1 = load<f32>(wBase + wq), s2 = load<f32>(wBase + 2 * wq), s3 = load<f32>(wBase + 3 * wq);
          for (let r = r0; r < r1; r++) {
            const s = x + <usize>i * inPlane + <usize>(r + dy) * rowBytes + 4;
            const d0 = y + <usize>o * outPlane + <usize>r * rowBytes + 4;
            const d1 = d0 + outPlane, d2 = d1 + outPlane, d3 = d2 + outPlane;
            let t = 0;
            for (; t + 4 <= cols; t += 4) {
              const off = <usize>t << 2;
              const v = v128.load(s + off);
              v128.store(d0 + off, f32x4.add(v128.load(d0 + off), f32x4.mul(w0, v)));
              v128.store(d1 + off, f32x4.add(v128.load(d1 + off), f32x4.mul(w1, v)));
              v128.store(d2 + off, f32x4.add(v128.load(d2 + off), f32x4.mul(w2, v)));
              v128.store(d3 + off, f32x4.add(v128.load(d3 + off), f32x4.mul(w3, v)));
            }
            for (; t < cols; t++) {
              const off = <usize>t << 2;
              const v = load<f32>(s + off);
              store<f32>(d0 + off, load<f32>(d0 + off) + s0 * v);
              store<f32>(d1 + off, load<f32>(d1 + off) + s1 * v);
              store<f32>(d2 + off, load<f32>(d2 + off) + s2 * v);
              store<f32>(d3 + off, load<f32>(d3 + off) + s3 * v);
            }
          }
        } else if (live == 4 && kw == 3) {
          const a0 = f32x4.splat(load<f32>(wBase)), b0 = f32x4.splat(load<f32>(wBase + 4)), c0 = f32x4.splat(load<f32>(wBase + 8));
          const a1 = f32x4.splat(load<f32>(wBase + wq)), b1 = f32x4.splat(load<f32>(wBase + wq + 4)), c1 = f32x4.splat(load<f32>(wBase + wq + 8));
          const a2 = f32x4.splat(load<f32>(wBase + 2 * wq)), b2 = f32x4.splat(load<f32>(wBase + 2 * wq + 4)), c2 = f32x4.splat(load<f32>(wBase + 2 * wq + 8));
          const a3 = f32x4.splat(load<f32>(wBase + 3 * wq)), b3 = f32x4.splat(load<f32>(wBase + 3 * wq + 4)), c3 = f32x4.splat(load<f32>(wBase + 3 * wq + 8));
          for (let r = r0; r < r1; r++) {
            const s = x + <usize>i * inPlane + <usize>(r + dy) * rowBytes + 4;
            const d0 = y + <usize>o * outPlane + <usize>r * rowBytes + 4;
            const d1 = d0 + outPlane, d2 = d1 + outPlane, d3 = d2 + outPlane;
            let t = 0;
            for (; t + 4 <= cols; t += 4) {
              const off = <usize>t << 2;
              const xm = v128.load(s + off - 4);
              const x0 = v128.load(s + off);
              const xp = v128.load(s + off + 4);
              v128.store(d0 + off, f32x4.add(v128.load(d0 + off), f32x4.add(f32x4.mul(a0, xm), f32x4.add(f32x4.mul(b0, x0), f32x4.mul(c0, xp)))));
              v128.store(d1 + off, f32x4.add(v128.load(d1 + off), f32x4.add(f32x4.mul(a1, xm), f32x4.add(f32x4.mul(b1, x0), f32x4.mul(c1, xp)))));
              v128.store(d2 + off, f32x4.add(v128.load(d2 + off), f32x4.add(f32x4.mul(a2, xm), f32x4.add(f32x4.mul(b2, x0), f32x4.mul(c2, xp)))));
              v128.store(d3 + off, f32x4.add(v128.load(d3 + off), f32x4.add(f32x4.mul(a3, xm), f32x4.add(f32x4.mul(b3, x0), f32x4.mul(c3, xp)))));
            }
            for (; t < cols; t++) {
              const off = <usize>t << 2;
              const xm = load<f32>(s + off - 4), x0 = load<f32>(s + off), xp = load<f32>(s + off + 4);
              for (let q = 0; q < 4; q++) {
                const wb = wBase + <usize>q * wq;
                const d = d0 + <usize>q * outPlane + off;
                store<f32>(d, load<f32>(d) + load<f32>(wb) * xm + load<f32>(wb + 4) * x0 + load<f32>(wb + 8) * xp);
              }
            }
          }
        } else {
          // Fewer than four output channels left (the 1-channel heads): plain loops.
          for (let q = 0; q < live; q++) {
            const wb = wBase + <usize>q * wq;
            for (let r = r0; r < r1; r++) {
              const s = x + <usize>i * inPlane + <usize>(r + dy) * rowBytes + 4;
              const d = y + <usize>(o + q) * outPlane + <usize>r * rowBytes + 4;
              for (let t = 0; t < cols; t++) {
                const off = <usize>t << 2;
                let acc = load<f32>(d + off);
                if (kw == 1) acc += load<f32>(wb) * load<f32>(s + off);
                else acc += load<f32>(wb) * load<f32>(s + off - 4) + load<f32>(wb + 4) * load<f32>(s + off) + load<f32>(wb + 8) * load<f32>(s + off + 4);
                store<f32>(d + off, acc);
              }
            }
          }
        }
      }
    }
  }
}

/** y = max(0, y) over n floats. */
export function relu(y: usize, n: i32): void {
  const z = f32x4.splat(0);
  let k = 0;
  for (; k + 4 <= n; k += 4) v128.store(y + (<usize>k << 2), f32x4.max(v128.load(y + (<usize>k << 2)), z));
  for (; k < n; k++) store<f32>(y + (<usize>k << 2), max<f32>(0, load<f32>(y + (<usize>k << 2))));
}

/** h = max(0, h + d) over n floats (residual block). */
export function addRelu(h: usize, d: usize, n: i32): void {
  const z = f32x4.splat(0);
  let k = 0;
  for (; k + 4 <= n; k += 4) {
    const off = <usize>k << 2;
    v128.store(h + off, f32x4.max(f32x4.add(v128.load(h + off), v128.load(d + off)), z));
  }
  for (; k < n; k++) {
    const off = <usize>k << 2;
    store<f32>(h + off, max<f32>(0, load<f32>(h + off) + load<f32>(d + off)));
  }
}
