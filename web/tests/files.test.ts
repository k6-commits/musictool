/// <reference types="node" />
import { crc32 as zlibCrc32 } from 'node:zlib';
import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { buildFiles, packageFiles, safeName } from '../src/app/files';
import { encodeWav } from '../src/audio/wav';
import { asciiText, vlq, writeSmf } from '../src/midi/smf';
import type { ArrangedNote } from '../src/transcribe/arrange';
import { crc32, zipStore } from '../src/util/zip';

function indexOf(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

describe('MIDI writer', () => {
  it('keeps text events ASCII', () => {
    expect(asciiText('サビ demo 2', 'x')).toBe('demo 2');
    expect(asciiText('メロディ', 'musictool')).toBe('musictool');
  });

  it('encodes variable-length quantities', () => {
    expect(vlq(0)).toEqual([0]);
    expect(vlq(127)).toEqual([0x7f]);
    expect(vlq(128)).toEqual([0x81, 0x00]);
    expect(vlq(16383)).toEqual([0xff, 0x7f]);
    expect(vlq(16384)).toEqual([0x81, 0x80, 0x00]);
    expect(vlq(0x0fffffff)).toEqual([0xff, 0xff, 0xff, 0x7f]);
  });

  it('writes a file that a MIDI parser reads back', () => {
    const bytes = writeSmf({
      bpm: 92,
      keySignature: { sf: -1, mi: 1 },
      title: 'メロディ',
      program: 73,
      notes: [
        { pitch: 62, startTick: 0, endTick: 480, velocity: 90 },
        { pitch: 62, startTick: 480, endTick: 960, velocity: 70 },
        { pitch: 65, startTick: 960, endTick: 1920, velocity: 100 },
      ],
    });
    const midi = new Midi(bytes);
    expect(midi.header.ppq).toBe(480);
    expect(midi.header.tempos[0].bpm).toBeCloseTo(92, 1);
    // FF 59 02 sf mi: one flat, minor = D minor (raw bytes; parsers name this differently).
    expect(indexOf(bytes, [0xff, 0x59, 0x02, 0xff, 0x01])).toBeGreaterThan(0);
    // Non-ASCII titles fall back to a plain name (see asciiText).
    expect(midi.header.name).toBe('musictool');
    const melody = midi.tracks.find((t) => t.notes.length)!;
    const notes = melody.notes;
    expect(notes.map((n) => [n.midi, n.ticks, n.durationTicks])).toEqual([
      [62, 0, 480],
      [62, 480, 480],
      [65, 960, 960],
    ]);
    expect(melody.instrument.number).toBe(73);
    expect(melody.name).toBe('Melody');
  });
});

describe('WAV and ZIP', () => {
  it('writes a 16-bit mono WAV header', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2]), 44100);
    const v = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 12);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getInt16(44 + 2 * 3, true)).toBe(32767);
    expect(v.getInt16(44 + 2 * 4, true)).toBe(-32768);
    expect(v.getInt16(44 + 2 * 5, true)).toBe(32767);
  });

  it('interleaves several channels', () => {
    const wav = encodeWav([new Float32Array([0.5, 0]), new Float32Array([0, -0.5])], 8000);
    const v = new DataView(wav.buffer);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([16383, 0, 0, -16384]);
  });

  it('computes CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a zip whose directory, headers and CRCs check out, with UTF-8 names', () => {
    const entries = [
      { name: 'メロディ.mid', data: new Uint8Array([1, 2, 3]) },
      { name: 'voice.wav', data: new Uint8Array(1000).fill(7) },
    ];
    const zip = zipStore(entries);
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(entries.length);
    let cd = v.getUint32(eocd + 16, true);
    expect(cd + v.getUint32(eocd + 12, true)).toBe(eocd);
    const dec = new TextDecoder();
    for (const e of entries) {
      expect(v.getUint32(cd, true)).toBe(0x02014b50);
      expect(v.getUint16(cd + 8, true) & 0x0800).toBe(0x0800); // UTF-8 names
      const size = v.getUint32(cd + 24, true);
      const nameLen = v.getUint16(cd + 28, true);
      const local = v.getUint32(cd + 42, true);
      expect(dec.decode(zip.subarray(cd + 46, cd + 46 + nameLen))).toBe(e.name);
      expect(v.getUint32(local, true)).toBe(0x04034b50);
      const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = zip.subarray(dataAt, dataAt + size);
      expect(Array.from(data)).toEqual(Array.from(e.data));
      expect(v.getUint32(cd + 16, true)).toBe(zlibCrc32(data)); // checked against Node's own CRC-32
      cd += 46 + nameLen + v.getUint16(cd + 30, true) + v.getUint16(cd + 32, true);
    }
  });
});

describe('export files', () => {
  const notes = [
    { id: 'n1', pitch: 64, startBeat: 0, endBeat: 1, velocity: 90, flagged: false, raw: {} },
    { id: 'n2', pitch: 62, startBeat: 1, endBeat: 1.5, velocity: 80, flagged: false, raw: {} },
  ] as unknown as ArrangedNote[];
  const input = { name: 'a/b:c', bpm: 120, beatsPerBar: 4, key: { tonic: 0, mode: 'major' as const }, program: 0, notes, voice: new Float32Array(100), sampleRate: 48000 };

  it('names files safely', () => {
    expect(safeName('a/b:c')).toBe('a-b-c');
    expect(safeName('   ')).toBe('musictool');
  });

  it('builds MIDI, WAV or both, and zips when needed', () => {
    expect(buildFiles('midi', input).map((f) => f.name)).toEqual(['a-b-c.mid']);
    expect(buildFiles('wav', input).map((f) => f.name)).toEqual(['a-b-c-voice.wav']);
    const both = buildFiles('both', input);
    expect(both.map((f) => f.name)).toEqual(['a-b-c.mid', 'a-b-c-voice.wav']);
    expect(packageFiles(both, input.name, false).name).toBe('a-b-c.zip');
    expect(packageFiles(both.slice(0, 1), input.name, false).name).toBe('a-b-c.mid');
    expect(packageFiles(both.slice(0, 1), input.name, true).name).toBe('a-b-c.zip');
    const midi = new Midi(both[0].data);
    expect(midi.tracks.find((t) => t.notes.length)!.notes.map((n) => [n.midi, n.ticks, n.durationTicks])).toEqual([
      [64, 0, 480],
      [62, 480, 240],
    ]);
  });
});
