// Playback: a small synth for the notes, the original voice, and metronome clicks.
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

export class Player {
  readonly ctx: AudioContext;
  private session: { gain: GainNode; sources: AudioScheduledSourceNode[]; t0: number; from: number; timer: number } | null = null;

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
    const sources: AudioScheduledSourceNode[] = [];

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
      const dur = o.to !== undefined ? o.to - o.from : undefined;
      src.start(startAt, Math.max(0, offset), dur);
      sources.push(src);
      end = Math.max(end, o.voice.duration - o.voiceZero);
    }

    if (instLevel > 0) {
      for (const n of o.notes) {
        if (n.start + n.dur <= o.from) continue;
        if (o.to !== undefined && n.start >= o.to) continue;
        const start = Math.max(n.start, o.from);
        const stop = o.to !== undefined ? Math.min(n.start + n.dur, o.to) : n.start + n.dur;
        sources.push(...this.voiceNote(out, o.instrument, n.pitch, t0 + start - o.from, stop - start, (n.velocity / 127) * instLevel));
        end = Math.max(end, n.start + n.dur);
      }
    }
    if (o.to !== undefined) end = Math.min(end, o.to);

    const timer = window.setTimeout(() => {
      this.stop();
      o.onEnd?.();
    }, (end - o.from + 0.15) * 1000 + 60);
    this.session = { gain: out, sources, t0, from: o.from, timer };
  }

  stop(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    window.clearTimeout(s.timer);
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
  preview(pitch: number, instrument: Instrument, dur = 0.35): void {
    const out = this.ctx.createGain();
    out.gain.value = 0.9;
    out.connect(this.ctx.destination);
    this.voiceNote(out, instrument, pitch, this.ctx.currentTime + 0.01, dur, 0.75);
    window.setTimeout(() => out.disconnect(), (dur + 1.5) * 1000);
  }

  click(time: number, accent: boolean, dest: AudioNode = this.ctx.destination): void {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(g).connect(dest);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  private voiceNote(dest: AudioNode, inst: Instrument, pitch: number, at: number, dur: number, level: number): AudioScheduledSourceNode[] {
    const ctx = this.ctx;
    const f = midiToHz(pitch);
    const g = ctx.createGain();
    g.connect(dest);
    const peak = 0.28 * level;
    const end = at + Math.max(0.05, dur);
    const nodes: AudioScheduledSourceNode[] = [];
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
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.008);
      g.gain.exponentialRampToValueAtTime(peak * 0.35, at + 0.4);
      g.gain.setTargetAtTime(peak * 0.2, at + 0.4, 0.8);
      g.gain.setTargetAtTime(0.0001, end, 0.06);
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
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak * 0.6, at + 0.015);
      g.gain.setTargetAtTime(peak * 0.45, at + 0.015, 0.1);
      g.gain.setTargetAtTime(0.0001, end, 0.04);
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
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak * 1.2, at + 0.06);
      g.gain.setTargetAtTime(0.0001, end, 0.05);
    }
    for (const n of nodes) {
      n.start(at);
      n.stop(end + 0.5);
    }
    window.setTimeout(() => g.disconnect(), (end - ctx.currentTime + 1) * 1000);
    return nodes;
  }
}
