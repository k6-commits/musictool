// Building the export files and handing them to the browser (or to the claude.ai viewer).
import { encodeWav } from '../audio/wav';
import { writeSmf } from '../midi/smf';
import { keySignature, type Key } from '../music/scale';
import type { ArrangedNote } from '../transcribe/arrange';
import { zipStore } from '../util/zip';

export type ExportKind = 'both' | 'midi' | 'wav';

export interface ExportInput {
  name: string;
  bpm: number;
  beatsPerBar: number;
  key: Key;
  program: number;
  notes: ArrangedNote[];
  /** Voice audio that starts exactly at bar 1. */
  voice: Float32Array;
  sampleRate: number;
}

export interface OutFile {
  name: string;
  data: Uint8Array;
}

export const PPQ = 480;

export function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || 'musictool';
}

export function buildMidi(input: ExportInput): Uint8Array {
  return writeSmf({
    ppq: PPQ,
    bpm: input.bpm,
    timeSignature: [input.beatsPerBar, 4],
    keySignature: keySignature(input.key),
    title: input.name,
    trackName: 'Voice Melody',
    program: input.program,
    notes: input.notes.map((n) => ({
      pitch: n.pitch,
      startTick: Math.round(n.startBeat * PPQ),
      endTick: Math.round(n.endBeat * PPQ),
      velocity: n.velocity,
    })),
  });
}

export function buildFiles(kind: ExportKind, input: ExportInput): OutFile[] {
  const base = safeName(input.name);
  const files: OutFile[] = [];
  if (kind !== 'wav') files.push({ name: `${base}.mid`, data: buildMidi(input) });
  if (kind !== 'midi') files.push({ name: `${base}-voice.wav`, data: encodeWav(input.voice, input.sampleRate) });
  return files;
}

/** One file to save: the file itself, or a zip when there are several (or when only zip is allowed). */
export function packageFiles(files: OutFile[], name: string, zipAlways: boolean): OutFile {
  if (files.length === 1 && !zipAlways) return files[0];
  return { name: `${safeName(name)}.zip`, data: zipStore(files) };
}

/** Save through a temporary link (normal browsers). */
export function saveWithLink(file: OutFile): void {
  const blob = new Blob([file.data as BlobPart], { type: mimeOf(file.name) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function mimeOf(name: string): string {
  if (name.endsWith('.mid')) return 'audio/midi';
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}
