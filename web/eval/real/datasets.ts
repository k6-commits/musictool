/// <reference types="node" />
// Real-voice evaluation sets, read from a local folder (fetched by scripts/fetch-eval-data.mjs, never committed).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Midi } from '@tonejs/midi';
import type { InputMode } from '../../src/dsp/pitch';
import { midiToHz } from '../../src/music/notes';
import type { TimedNote } from './metrics';

export interface Item {
  dataset: string;
  id: string;
  wav: string;
  mode: InputMode;
  /** Reference notes (for vocadito: annotator 1). */
  notes: TimedNote[];
  /** A second annotator's notes, when there is one (for the agreement between people). */
  notes2?: TimedNote[];
  /** Reference f0 track (hz 0 = unvoiced), when the set has one. */
  f0?: { t: number[]; hz: number[] };
  /**
   * The reference is the score the person followed rather than an annotation of the recording: its start and
   * octave are fitted per recording before scoring (see eval/real.ts).
   */
  score?: boolean;
}

function csvRows(path: string): number[][] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/[a-z]/i.test(line))
    .map((line) => line.split(',').map(Number));
}

/**
 * vocadito (Bittner et al. 2021, CC BY 4.0): 40 excerpts of solo singing in several languages, 44.1 kHz,
 * with an f0 track and the notes marked by two annotators (onset, pitch in Hz, duration).
 */
export function vocadito(root: string): Item[] {
  const dir = join(root, 'vocadito');
  if (!existsSync(join(dir, 'Audio'))) return [];
  const notes = (path: string): TimedNote[] => csvRows(path).map(([start, hz, dur]) => ({ start, end: start + dur, hz }));
  return readdirSync(join(dir, 'Audio'))
    .filter((f) => /^vocadito_\d+\.wav$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map((f) => {
      const id = f.replace(/\.wav$/, '');
      const ann = (kind: string) => join(dir, 'Annotations', kind);
      const f0 = csvRows(join(ann('F0'), `${id}_f0.csv`));
      return {
        dataset: 'vocadito',
        id,
        wav: join(dir, 'Audio', f),
        mode: 'sing' as const,
        notes: notes(join(ann('Notes'), `${id}_notesA1.csv`)),
        notes2: notes(join(ann('Notes'), `${id}_notesA2.csv`)),
        f0: { t: f0.map((r) => r[0]), hz: f0.map((r) => r[1]) },
      };
    });
}

/**
 * HumTrans (Liu et al. 2023, CC BY-NC 4.0): hummed melodies with the melody as MIDI. A person-balanced subset
 * of the official test split (12 recordings from each of the 10 people). The MIDI is the score the hummers
 * followed: the recordings lag it by up to 1.5 s (most by 0.1-0.4 s), and many low voices hummed an octave (one
 * recording two octaves) below it. eval/real.ts fits both per recording.
 */
export function humtrans(root: string): Item[] {
  const dir = join(root, 'humtrans');
  if (!existsSync(join(dir, 'wav'))) return [];
  return readdirSync(join(dir, 'wav'))
    .filter((f) => f.endsWith('.wav') && existsSync(join(dir, 'midi', f.replace(/\.wav$/, '.mid'))))
    .sort()
    .map((f) => {
      const id = f.replace(/\.wav$/, '');
      const midi = new Midi(readFileSync(join(dir, 'midi', `${id}.mid`)));
      const notes = midi.tracks
        .flatMap((t) => t.notes)
        .map((n) => ({ start: n.time, end: n.time + n.duration, hz: midiToHz(n.midi) }))
        .sort((a, b) => a.start - b.start);
      return { dataset: 'humtrans', id, wav: join(dir, 'wav', f), mode: 'hum' as const, notes, score: true };
    });
}

export function allItems(root: string): Item[] {
  return [...vocadito(root), ...humtrans(root)];
}
