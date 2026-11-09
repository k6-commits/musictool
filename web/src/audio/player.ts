// Playback: a small synth for the notes, the original voice, and metronome clicks.
// Notes are scheduled a little ahead of time from a timer (not all at once), so long takes start
// instantly and the audio thread only ever holds the notes that are about to sound.
import { midiToHz } from '../music/notes';

export type Instrument = 'piano' | 'synth' | 'flute';

export const INSTRUMENTS: { id: Instrument; label: string; program: number }[] = [
  { id: 'piano', label: 'PIANO', program: 0 },
  { id: 'synth', label: 'SYNTH', program: 81 },
  { id: 'flute', label: 'FLUTE', program: 73 },
];

export interface PlayNote {
  pitch: number;
  /** Seconds on the song timeline. */
  start: number;
  dur: number;
  velocity: number;
}

export interface PlayOptions {
  notes: PlayNote[];
  voice: AudioBuffer | null;
  /** Position in the voice buffer (seconds) that corresponds to song time 0. */
  voiceZero: number;
  /** Song time to start from, seconds. */
  from: number;
  /** Stop at this song time (defaults to the end of the material). */
  to?: number;
  /** 0 = only voice, 1 = only instrument. */
  balance: number;
  instrument: Instrument;
  onEnd?: () => void;
}

/** How far ahead notes are scheduled. Background tabs run timers about once a second, so stay above that. */
const LOOKAHEAD = 1.5;
const TICK_MS = 200;

interface Session {
  gain: GainNode;
  sources: Set<AudioScheduledSourceNode>;
  t0: number;
  from: number;
  endTimer: number;
  tick: number;
}

export class Player {
  readonly ctx: AudioContext;
  private session: Session | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  get playing(): boolean {
    return this.session !== null;
  }

  /** Current song time in seconds, or null when stopped. */
  get position(): number | null {
    if (!this.session) return null;
    return this.session.from + Math.max(0, this.ctx.currentTime - this.session.t0);
  }

  play(o: PlayOptions): void {
    this.stop();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.06;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    out.connect(ctx.destination);
    const sources = new Set<AudioScheduledSourceNode>();
    const track = (n: AudioScheduledSourceNode) => {
      sources.add(n);
      n.addEventListener('ended', () => sources.delete(n));
    };

    const voiceLevel = Math.min(1, 2 * (1 - o.balance));
    const instLevel = Math.min(1, 2 * o.balance);
    let end = o.from;

    if (o.voice && voiceLevel > 0) {
      const src = ctx.createBufferSource();
      src.buffer = o.voice;
      const g = ctx.createGain();
      g.gain.value = voiceLevel;
      src.connect(g).connect(out);
      const offset = o.voiceZero + o.from;
      const startAt = offset < 0 ? t0 - offset : t0;
      const dur = o.to !== undefined ? Math.max(0, o.to - o.from) : undefined;
      src.start(startAt, Math.max(0, offset), dur);
      track(src);
      end = Math.max(end, o.voice.duration - o.voiceZero);
    }

    const queue = instLevel > 0 ? o.notes.filter((n) => n.start + n.dur > o.from && (o.to === undefined || n.start < o.to)) : [];
    queue.sort((a, b) => a.start - b.start);
    for (const n of queue) end = Math.max(end, n.start + n.dur);
    if (o.to !== undefined) end = Math.min(end, o.to);

    let next = 0;
    const schedule = () => {
      const horizon = o.from + (ctx.currentTime - t0) + LOOKAHEAD;
      while (next < queue.length && queue[next].start < horizon) {
        const n = queue[next++];
        const start = Math.max(n.start, o.from);
        const stop = o.to !== undefined ? Math.min(n.start + n.dur, o.to) : n.start + n.dur;
        for (const node of this.voiceNote(out, o.instrument, n.pitch, t0 + start - o.from, stop - start, (n.velocity / 127) * instLevel)) {
          track(node);
        }
      }
    };
    schedule();
    const tick = window.setInterval(schedule, TICK_MS);
    const endTimer = window.setTimeout(() => {
      this.stop();
      o.onEnd?.();
    }, (end - o.from + 0.15) * 1000 + 60);
    this.session = { gain: out, sources, t0, from: o.from, endTimer, tick };
  }

  stop(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    window.clearTimeout(s.endTimer);
    window.clearInterval(s.tick);
    const now = this.ctx.currentTime;
    s.gain.gain.cancelScheduledValues(now);
    s.gain.gain.setValueAtTime(s.gain.gain.value, now);
    s.gain.gain.linearRampToValueAtTime(0, now + 0.03);
    for (const src of s.sources) {
      try {
        src.stop(now + 0.04);
      } catch {
        /* already stopped */
      }
    }
    window.setTimeout(() => s.gain.disconnect(), 100);
  }

  /** One short note for previews (e.g. when picking a candidate pitch). */
  preview(pitch: number, instrument: Instrument): void {
    const out = this.ctx.createGain();
    out.gain.value = 0.9;
    out.connect(this.ctx.destination);
    const nodes = this.voiceNote(out, instrument, pitch, this.ctx.currentTime + 0.01, 0.35, 0.75);
    nodes[0]?.addEventListener('ended', () => out.disconnect());
  }

  /** A metronome click; returns the oscillator so a caller can cancel clicks that have not sounded yet. */
  click(time: number, accent: boolean): OscillatorNode {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
    osc.addEventListener('ended', () => g.disconnect());
    return osc;
  }

  /**
   * One synth note. Every envelope event is scheduled at or before the note's end, so the release that
   * starts at `end` is always the last event, however short the note is.
   */
  private voiceNote(dest: AudioNode, inst: Instrument, pitch: number, at: number, dur: number, level: number): AudioScheduledSourceNode[] {
    const ctx = this.ctx;
    const f = midiToHz(pitch);
    const g = ctx.createGain();
    g.connect(dest);
    const peak = 0.28 * level;
    const len = Math.max(0.05, dur);
    const end = at + len;
    const nodes: AudioScheduledSourceNode[] = [];
    g.gain.setValueAtTime(0, at);
    if (inst === 'piano') {
      for (const [mult, amp, type] of [
        [1, 1, 'triangle'],
        [2, 0.35, 'sine'],
        [3, 0.12, 'sine'],
      ] as [number, number, OscillatorType][]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f * mult;
        const og = ctx.createGain();
        og.gain.value = amp;
        o.connect(og).connect(g);
        nodes.push(o);
      }
      // Hammer, then a decay toward 35 % over 0.4 s (cut short if the note ends first), then a slow fade.
      const attack = Math.min(0.008, len / 4);
      g.gain.linearRampToValueAtTime(peak, at + attack);
      const decayEnd = Math.min(at + 0.4, end);
      const decayed = peak * Math.pow(0.35, (decayEnd - at - attack) / (0.4 - attack));
      g.gain.exponentialRampToValueAtTime(decayed, decayEnd);
      if (end > at + 0.4) g.gain.setTargetAtTime(peak * 0.2, at + 0.4, 0.8);
    } else if (inst === 'synth') {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(8000, f * 6);
      lp.Q.value = 2;
      o.connect(lp).connect(g);
      nodes.push(o);
      const attack = Math.min(0.015, len / 4);
      g.gain.linearRampToValueAtTime(peak * 0.6, at + attack);
      g.gain.setTargetAtTime(peak * 0.45, at + attack, 0.1);
    } else {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = f * 0.004;
      lfo.connect(lfoGain).connect(o.frequency);
      o.connect(g);
      nodes.push(o, lfo);
      g.gain.linearRampToValueAtTime(peak * 1.2, at + Math.min(0.06, len / 2));
    }
    g.gain.setTargetAtTime(0.0001, end, 0.06);
    for (const n of nodes) {
      n.start(at);
      n.stop(end + 0.5);
    }
    nodes[0].addEventListener('ended', () => g.disconnect());
    return nodes;
  }
}
