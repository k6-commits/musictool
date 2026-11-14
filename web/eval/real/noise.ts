/// <reference types="node" />
// Noisy versions of the evaluation recordings: real background noise (DEMAND, Thiemann et al. 2013, CC BY 4.0)
// mixed in at a fixed signal-to-noise ratio, written once as 16 kHz WAV files so every engine reads the same audio.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodeWav } from '../../src/audio/wav';
import { resample } from '../../src/dsp/resample';
import type { Item } from './datasets';
import { readWav } from './wav';

/** Condition names (e.g. "cafeteria10" = cafeteria noise at 10 dB SNR) and the DEMAND recording each uses. */
export const NOISES: Record<string, string> = { cafeteria: 'PCAFETER', street: 'STRAFFIC', living: 'DLIVING' };

export interface Condition {
  name: string;
  noise: string | null;
  snrDb: number;
}

export function parseCondition(name: string): Condition {
  if (name === 'clean') return { name, noise: null, snrDb: Infinity };
  const m = name.match(/^([a-z]+)(-?\d+)$/);
  if (!m || !NOISES[m[1]]) throw new Error(`unknown condition "${name}" (clean, or ${Object.keys(NOISES).join('/')} + SNR in dB)`);
  return { name, noise: NOISES[m[1]], snrDb: Number(m[2]) };
}

const noiseCache = new Map<string, Float32Array>();

function loadNoise(root: string, name: string): Float32Array {
  let n = noiseCache.get(name);
  if (!n) {
    const audio = readWav(readFileSync(join(root, 'noise', `${name}.wav`)));
    if (audio.sampleRate !== 16000) throw new Error(`${name}.wav must be 16 kHz`);
    n = audio.samples;
    noiseCache.set(name, n);
  }
  return n;
}

/** The voice's level: RMS over the louder half of its 32 ms frames, so pauses do not lower it. */
function activeRms(x: Float32Array): number {
  const energies: number[] = [];
  for (let p = 0; p + 512 <= x.length; p += 512) {
    let s = 0;
    for (let i = p; i < p + 512; i++) s += x[i] * x[i];
    energies.push(s / 512);
  }
  energies.sort((a, b) => b - a);
  const top = energies.slice(0, Math.max(1, Math.ceil(energies.length / 2)));
  return Math.sqrt(top.reduce((a, b) => a + b, 0) / top.length);
}

function rng(seedText: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mix(voice: Float32Array, noise: Float32Array, snrDb: number, seed: string): Float32Array {
  const start = Math.floor(rng(seed)() * noise.length);
  const segment = new Float32Array(voice.length);
  for (let i = 0; i < voice.length; i++) segment[i] = noise[(start + i) % noise.length];
  let ns = 0;
  for (const v of segment) ns += v * v;
  const noiseRms = Math.sqrt(ns / Math.max(1, segment.length)) || 1e-9;
  const gain = activeRms(voice) / (noiseRms * Math.pow(10, snrDb / 20));
  const out = new Float32Array(voice.length);
  let peak = 0;
  for (let i = 0; i < voice.length; i++) {
    out[i] = voice[i] + gain * segment[i];
    peak = Math.max(peak, Math.abs(out[i]));
  }
  if (peak > 0.99) for (let i = 0; i < out.length; i++) out[i] *= 0.99 / peak;
  return out;
}

/** The item's audio in a condition. Noisy versions are made on first use (deterministic: same mix every run). */
export function conditionWav(root: string, item: Item, c: Condition): string {
  if (!c.noise) return item.wav;
  const path = join(root, 'noisy', c.name, item.dataset, `${item.id}.wav`);
  if (!existsSync(path)) {
    const voice = readWav(readFileSync(item.wav));
    const v16 = voice.sampleRate === 16000 ? voice.samples : resample(voice.samples, voice.sampleRate, 16000);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodeWav(mix(v16, loadNoise(root, c.noise), c.snrDb, `${c.name}/${item.dataset}/${item.id}`), 16000));
  }
  return path;
}
