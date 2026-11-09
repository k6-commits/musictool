// Standard MIDI File (format 1) writer: a conductor track and one melody track.

export interface SmfNote {
  pitch: number;
  startTick: number;
  endTick: number;
  velocity: number;
}

export interface SmfOptions {
  ppq?: number;
  bpm: number;
  timeSignature?: [number, number];
  keySignature?: { sf: number; mi: 0 | 1 };
  title?: string;
  trackName?: string;
  /** General MIDI program, 0-based (0 = Acoustic Grand Piano). */
  program?: number;
  channel?: number;
  notes: SmfNote[];
}

type Event = { tick: number; order: number; bytes: number[] };

const encoder = new TextEncoder();

export function vlq(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const bytes = [v & 0x7f];
  v = Math.floor(v / 128);
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  return bytes;
}

/**
 * Text meta events have no declared encoding: DAWs read them as Latin-1 or the system code page
 * (Shift_JIS on Japanese Windows), so UTF-8 names turn into garbage there. Keep them ASCII.
 */
export function asciiText(text: string, fallback: string): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
  return ascii || fallback;
}

function textEvent(type: number, text: string): number[] {
  const data = Array.from(encoder.encode(text));
  return [0xff, type, ...vlq(data.length), ...data];
}

function track(events: Event[]): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data: number[] = [];
  let last = 0;
  for (const ev of sorted) {
    data.push(...vlq(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  data.push(0, 0xff, 0x2f, 0x00);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(data.length), ...data];
}

function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function u16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff];
}

export function writeSmf(o: SmfOptions): Uint8Array {
  const ppq = o.ppq ?? 480;
  const channel = (o.channel ?? 0) & 0x0f;
  const [num, den] = o.timeSignature ?? [4, 4];
  const usPerQuarter = Math.round(60_000_000 / o.bpm);
  const key = o.keySignature ?? { sf: 0, mi: 0 };

  const conductor: Event[] = [
    { tick: 0, order: 0, bytes: textEvent(0x03, asciiText(o.title ?? '', 'musictool')) },
    { tick: 0, order: 1, bytes: [0xff, 0x58, 0x04, num, Math.round(Math.log2(den)), 24, 8] },
    { tick: 0, order: 2, bytes: [0xff, 0x59, 0x02, key.sf & 0xff, key.mi] },
    { tick: 0, order: 3, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] },
  ];

  const melody: Event[] = [
    { tick: 0, order: 0, bytes: textEvent(0x03, asciiText(o.trackName ?? '', 'Melody')) },
    { tick: 0, order: 1, bytes: [0xc0 | channel, (o.program ?? 0) & 0x7f] },
  ];
  for (const n of o.notes) {
    const pitch = Math.min(127, Math.max(0, Math.round(n.pitch)));
    const velocity = Math.min(127, Math.max(1, Math.round(n.velocity)));
    const start = Math.max(0, Math.round(n.startTick));
    const end = Math.max(start + 1, Math.round(n.endTick));
    // Note-offs sort before note-ons on the same tick so repeated pitches stay separate.
    melody.push({ tick: start, order: 3, bytes: [0x90 | channel, pitch, velocity] });
    melody.push({ tick: end, order: 2, bytes: [0x80 | channel, pitch, 0x40] });
  }

  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(2), ...u16(ppq)];
  return Uint8Array.from([...header, ...track(conductor), ...track(melody)]);
}
