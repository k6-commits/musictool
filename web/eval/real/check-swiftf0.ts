/// <reference types="node" />
// Compares the TypeScript SwiftF0 with frames from the reference implementation (eval/real/swiftf0_frames.py)
// on 16 kHz recordings, and times it. Run: npm run eval:check-swiftf0 -- <wav_dir> <reference_dir> [max_files]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { frameCount, swiftF0Frames } from '../../src/dsp/swiftf0/model';
import { readWav } from './wav';

const [wavDir, refDir, limitArg] = process.argv.slice(2);
const files = readdirSync(wavDir).filter((f) => f.endsWith('.wav')).sort().slice(0, Number(limitArg ?? 1e9));
let worstCents = 0;
let worstConf = 0;
let worstDb = 0;
let frames = 0;
let ms = 0;
let flips = 0;
for (const f of files) {
  const audio = readWav(readFileSync(join(wavDir, f)));
  if (audio.sampleRate !== 16000) throw new Error('16 kHz input expected');
  const ref = JSON.parse(readFileSync(join(refDir, f.replace(/\.wav$/, '.json')), 'utf8')) as { f0: number[]; conf: number[]; db: number[] };
  const total = frameCount(audio.samples.length);
  const t0 = performance.now();
  const out = swiftF0Frames(audio.samples, 0, total, 0, total);
  ms += performance.now() - t0;
  frames += total;
  if (ref.f0.length !== total) throw new Error(`${f}: ${total} frames, reference has ${ref.f0.length}`);
  for (let i = 0; i < total; i++) {
    const c = Math.abs(out.conf[i] - ref.conf[i]);
    worstConf = Math.max(worstConf, c);
    const db = 20 * Math.log10(Math.max(out.rms[i], 1e-7));
    worstDb = Math.max(worstDb, Math.abs(db - ref.db[i]));
    if ((out.conf[i] >= 0.5) !== (ref.conf[i] >= 0.5)) flips++;
    if (ref.conf[i] >= 0.5) worstCents = Math.max(worstCents, Math.abs(1200 * Math.log2(out.pitch[i] / ref.f0[i])));
  }
}
console.log(`${files.length} files, ${frames} frames: max pitch difference ${worstCents.toFixed(3)} cents (voiced frames), max confidence difference ${worstConf.toExponential(2)}, max level difference ${worstDb.toFixed(3)} dB, voicing flips ${flips}; ${(ms / frames).toFixed(3)} ms per frame`);
