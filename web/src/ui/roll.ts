// Piano roll on canvas: key column, bar ruler, notes, the voice curve, the waveform lane and the playhead.
// The roll canvas is only as wide as the visible area; an invisible spacer inside a scroller provides the
// scroll range, and drawing is translated by the scroll position. So canvas size (and repaint cost) does
// not grow with the length of the take.
import { isBlackKey, pitchClass } from '../music/notes';

export interface RollNote {
  id: string;
  pitch: number;
  startBeat: number;
  endBeat: number;
  flagged: boolean;
  label: string;
}

export interface RollView {
  notes: RollNote[];
  /** Voice curve: song time in beats and tuning-corrected pitch (NaN = silence). */
  curve: { beats: Float32Array; pitch: Float32Array } | null;
  /** Peak envelope of the voice, one value per `step` beats, starting at `start` beats. */
  envelope: { start: number; step: number; peaks: Float32Array } | null;
  totalBeats: number;
  beatsPerBar: number;
  grid: number;
  /** Visible pitch range (MIDI, inclusive). */
  range: [number, number];
  playhead: number | null;
  selectedId: string | null;
  lit: { pitch: number; kind: 'voice' | 'note' } | null;
  keyLabel: (midi: number) => string | null;
  /** Notes fade in one after another from this time (performance.now()), or null. */
  appearAt: number | null;
}

const C = {
  bg: '#0C0D11',
  rowWhite: '#0E1015',
  rowBlack: '#0A0B0E',
  rowC: '#1A1D24',
  grid: '#13161B',
  beat: '#1B1E25',
  bar: '#2A2E36',
  ruler: '#7C8494',
  note: '#56C2FF',
  noteText: '#06121A',
  warn: '#FFC24A',
  voice: '#FF6B4A',
  white: '#D4D8DF',
  black: '#15181E',
  text: '#F4F5F7',
  keyLabel: '#5E6573',
  lane: '#0A0B0E',
};

export const KEYS_W = 56;
const RULER_H = 22;
const LANE_H = 54;
const FONT = "600 11px 'Space Grotesk', 'Noto Sans JP', system-ui, sans-serif";
/** Fade-in: notes appear 50 ms apart, but the whole animation never takes more than about a second. */
const STAGGER_MS = 50;
const STAGGER_MAX = 24;
const FADE_MS = 220;

export class PianoRoll {
  readonly root: HTMLElement;
  private readonly keys: HTMLCanvasElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly roll: HTMLCanvasElement;
  private view: RollView | null = null;
  private pxPerBeat = 48;
  private rowH = 16;
  private lo = 55;
  private hi = 76;
  private visibleW = 600;
  private height = 400;
  private dpr = 1;
  onPick: ((id: string | null, beat: number) => void) | null = null;
  /** Called after the roll changed size (the number of rows it wants may have changed). */
  onResize: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.keys = root.querySelector('canvas.keys') as HTMLCanvasElement;
    this.roll = root.querySelector('canvas.roll') as HTMLCanvasElement;
    this.scroller = root.querySelector('.scroller') as HTMLElement;
    this.spacer = root.querySelector('.spacer') as HTMLElement;
    new ResizeObserver(() => {
      const rows = this.minRows;
      this.layout();
      if (this.minRows !== rows) this.onResize?.();
    }).observe(root);
    this.watchPixelRatio();
    this.scroller.addEventListener('scroll', () => this.draw());
    // `click` fires for a tap or a mouse click, but not at the start of a swipe that scrolls the roll.
    this.scroller.addEventListener('click', (e) => {
      const rect = this.scroller.getBoundingClientRect();
      const x = e.clientX - rect.left + this.scroller.scrollLeft;
      const y = e.clientY - rect.top;
      this.onPick?.(this.hit(x, y), Math.max(0, x / this.pxPerBeat));
    });
  }

  /** Rows the roll wants to show at least, given its height (fewer on short screens so rows stay readable). */
  get minRows(): number {
    const usable = this.height - RULER_H - LANE_H;
    return Math.max(12, Math.min(18, Math.floor(usable / 20)));
  }

  setView(view: RollView): void {
    const prev = this.view;
    this.view = view;
    if (!prev || prev.totalBeats !== view.totalBeats || prev.range[0] !== view.range[0] || prev.range[1] !== view.range[1]) {
      this.layout();
    } else {
      this.draw();
    }
  }

  /** True while the fade-in of the notes is still running. */
  get animating(): boolean {
    const v = this.view;
    if (!v || v.appearAt === null) return false;
    return performance.now() - v.appearAt < Math.min(v.notes.length, STAGGER_MAX) * STAGGER_MS + FADE_MS;
  }

  /** Keep the playhead in view while playing or recording. */
  follow(beat: number): void {
    const x = beat * this.pxPerBeat;
    const left = this.scroller.scrollLeft;
    const w = this.scroller.clientWidth;
    if (x > left + w * 0.8 || x < left) this.scroller.scrollLeft = Math.max(0, x - w * 0.2);
  }

  scrollToStart(): void {
    this.scroller.scrollLeft = 0;
  }

  private watchPixelRatio(): void {
    // Moving the window to a screen with another pixel density changes no CSS size, so watch it directly.
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener(
      'change',
      () => {
        this.layout();
        this.watchPixelRatio();
      },
      { once: true },
    );
  }

  private layout(): void {
    const v = this.view;
    const rect = this.root.getBoundingClientRect();
    this.height = Math.max(240, rect.height);
    this.visibleW = Math.max(200, rect.width - KEYS_W);
    this.dpr = window.devicePixelRatio || 1;
    if (v) [this.lo, this.hi] = v.range;
    const rows = this.hi - this.lo + 1;
    this.rowH = (this.height - RULER_H - LANE_H) / rows;
    const beats = v?.totalBeats ?? 16;
    this.pxPerBeat = Math.max(28, this.visibleW / Math.min(beats, 16));
    this.spacer.style.width = `${Math.max(this.visibleW, beats * this.pxPerBeat)}px`;
    sizeCanvas(this.keys, KEYS_W, this.height, this.dpr);
    sizeCanvas(this.roll, this.visibleW, this.height, this.dpr);
    this.draw();
  }

  private y(pitch: number): number {
    return RULER_H + (this.hi - pitch) * this.rowH;
  }

  private hit(x: number, y: number): string | null {
    const v = this.view;
    if (!v) return null;
    const beat = x / this.pxPerBeat;
    let best: string | null = null;
    let bestD = Infinity;
    for (const n of v.notes) {
      if (beat < n.startBeat - 0.05 || beat > n.endBeat + 0.05) continue;
      const cy = this.y(n.pitch) + this.rowH / 2;
      const d = Math.abs(cy - y);
      if (d < Math.max(12, this.rowH) && d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  }

  private alpha(index: number): number {
    const at = this.view?.appearAt;
    if (at === null || at === undefined) return 1;
    const t = performance.now() - at - Math.min(index, STAGGER_MAX) * STAGGER_MS;
    return Math.max(0, Math.min(1, t / FADE_MS));
  }

  draw(): void {
    if ((window.devicePixelRatio || 1) !== this.dpr) {
      this.layout();
      return;
    }
    const v = this.view;
    this.drawKeys(v);
    const ctx = this.roll.getContext('2d');
    if (!ctx) return;
    const H = this.height;
    const left = this.scroller.scrollLeft;
    const right = left + this.visibleW;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, -left * this.dpr, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(left, 0, this.visibleW, H);

    // Rows.
    for (let p = this.lo; p <= this.hi; p++) {
      const y = this.y(p);
      ctx.fillStyle = isBlackKey(p) ? C.rowBlack : C.rowWhite;
      ctx.fillRect(left, y, this.visibleW, this.rowH);
      if (pitchClass(p) === 0) {
        ctx.fillStyle = C.rowC;
        ctx.fillRect(left, y + this.rowH - 1, this.visibleW, 1);
      }
    }

    // Grid, beats, bars and the ruler.
    const total = v?.totalBeats ?? 16;
    const bpb = v?.beatsPerBar ?? 4;
    const grid = v?.grid ?? 0.5;
    const laneTop = H - LANE_H;
    ctx.fillStyle = C.bg;
    ctx.fillRect(left, 0, this.visibleW, RULER_H);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    const firstLine = Math.max(0, Math.floor(left / this.pxPerBeat / grid) * grid);
    for (let i = 0; ; i++) {
      const b = firstLine + i * grid;
      if (b > total + 1e-6) break;
      const x = Math.round(b * this.pxPerBeat) + 0.5;
      if (x > right + 2) break;
      const isBar = Math.abs(b / bpb - Math.round(b / bpb)) < 1e-6;
      const isBeat = Math.abs(b - Math.round(b)) < 1e-6;
      ctx.strokeStyle = isBar ? C.bar : isBeat ? C.beat : C.grid;
      ctx.beginPath();
      ctx.moveTo(x, isBar ? 4 : RULER_H);
      ctx.lineTo(x, laneTop);
      ctx.stroke();
      if (isBar && b < total) {
        ctx.fillStyle = C.ruler;
        ctx.fillText(String(Math.round(b / bpb) + 1), x + 5, RULER_H / 2 + 1);
      }
    }

    // Waveform lane.
    ctx.fillStyle = C.lane;
    ctx.fillRect(left, laneTop, this.visibleW, LANE_H);
    ctx.fillStyle = C.bar;
    ctx.fillRect(left, laneTop, this.visibleW, 1);
    if (v?.envelope && v.envelope.peaks.length) {
      const e = v.envelope;
      const mid = laneTop + LANE_H / 2;
      const half = (LANE_H - 12) / 2;
      const i0 = Math.max(0, Math.floor((left / this.pxPerBeat - e.start) / e.step) - 1);
      const i1 = Math.min(e.peaks.length - 1, Math.ceil((right / this.pxPerBeat - e.start) / e.step) + 1);
      if (i1 > i0) {
        ctx.fillStyle = 'rgba(255,107,74,0.55)';
        ctx.beginPath();
        ctx.moveTo((e.start + i0 * e.step) * this.pxPerBeat, mid);
        for (let i = i0; i <= i1; i++) ctx.lineTo((e.start + i * e.step) * this.pxPerBeat, mid - Math.max(0.5, e.peaks[i] * half));
        for (let i = i1; i >= i0; i--) ctx.lineTo((e.start + i * e.step) * this.pxPerBeat, mid + Math.max(0.5, e.peaks[i] * half));
        ctx.closePath();
        ctx.fill();
      }
    }

    // Note bodies.
    const boxes: { n: RollNote; x0: number; y: number; w: number; h: number; a: number }[] = [];
    if (v) {
      v.notes.forEach((n, index) => {
        const x0 = n.startBeat * this.pxPerBeat;
        const x1 = n.endBeat * this.pxPerBeat;
        if (x1 < left - 4 || x0 > right + 4) return;
        const a = this.alpha(index);
        if (a <= 0) return;
        const y = this.y(n.pitch) + 1 + (1 - a) * 6;
        const h = Math.max(6, this.rowH - 2);
        const w = Math.max(4, x1 - x0 - 2);
        boxes.push({ n, x0, y, w, h, a });
        ctx.globalAlpha = a;
        roundRect(ctx, x0 + 1, y, w, h, Math.min(5, h / 2));
        if (n.flagged) {
          ctx.fillStyle = 'rgba(255,194,74,0.16)';
          ctx.fill();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = C.warn;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = C.note;
          ctx.fill();
        }
        if (n.id === v.selectedId) {
          ctx.strokeStyle = C.text;
          ctx.lineWidth = 2;
          roundRect(ctx, x0 - 0.5, y - 1.5, w + 3, h + 3, Math.min(6, h / 2 + 1));
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      });
    }

    // Voice curve, between the note bodies and their labels.
    if (v?.curve && v.curve.beats.length) {
      const { beats, pitch } = v.curve;
      const fromBeat = (left - 40) / this.pxPerBeat;
      const toBeat = (right + 40) / this.pxPerBeat;
      let i = lowerBound(beats, fromBeat);
      ctx.strokeStyle = C.voice;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      let pen = false;
      let lastB = -1;
      for (; i < beats.length && beats[i] <= toBeat; i++) {
        const p = pitch[i];
        if (Number.isNaN(p) || p < this.lo - 1 || p > this.hi + 1) {
          pen = false;
          continue;
        }
        const x = beats[i] * this.pxPerBeat;
        const y = this.y(p) + this.rowH / 2;
        if (pen && beats[i] - lastB < 0.2) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
        lastB = beats[i];
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Labels and "check" badges.
    for (const { n, x0, y, w, h, a } of boxes) {
      ctx.globalAlpha = a;
      if (w > 24 && h >= 11) {
        const tw = ctx.measureText(n.label).width;
        if (!n.flagged) {
          ctx.fillStyle = C.note;
          roundRect(ctx, x0 + 3, y + h / 2 - 7, tw + 6, 14, 3);
          ctx.fill();
        }
        ctx.fillStyle = n.flagged ? C.warn : C.noteText;
        ctx.textBaseline = 'middle';
        ctx.fillText(n.label, x0 + 6, y + h / 2 + 0.5);
      }
      if (n.flagged) {
        const bx = x0 + 1 + w;
        ctx.fillStyle = C.warn;
        ctx.beginPath();
        ctx.arc(bx, y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1A1204';
        ctx.textAlign = 'center';
        ctx.fillText('!', bx, y + 0.5);
        ctx.textAlign = 'left';
      }
      ctx.globalAlpha = 1;
    }

    // Playhead.
    if (v?.playhead !== null && v?.playhead !== undefined) {
      const x = Math.round(v.playhead * this.pxPerBeat) + 0.5;
      ctx.strokeStyle = C.text;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 2);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.beginPath();
      ctx.moveTo(x - 5, RULER_H - 9);
      ctx.lineTo(x + 5, RULER_H - 9);
      ctx.lineTo(x, RULER_H - 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawKeys(v: RollView | null): void {
    const ctx = this.keys.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const H = this.height;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, KEYS_W, H);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    const lit = v?.lit ?? null;
    const litPitch = lit ? Math.round(lit.pitch) : null;
    const litColor = lit?.kind === 'voice' ? C.voice : C.note;
    for (let p = this.lo; p <= this.hi; p++) {
      const y = this.y(p);
      const black = isBlackKey(p);
      const isLit = p === litPitch;
      ctx.fillStyle = isLit && !black ? litColor : C.white;
      ctx.fillRect(0, y, KEYS_W - 2, this.rowH);
      ctx.fillStyle = '#A9AFB9';
      ctx.fillRect(0, y + this.rowH - 0.5, KEYS_W - 2, 0.5);
      if (black) {
        ctx.fillStyle = isLit ? litColor : C.black;
        roundRect(ctx, 0, y + 1, KEYS_W * 0.58, this.rowH - 2, 2);
        ctx.fill();
      }
      const label = v?.keyLabel(p) ?? null;
      if (label && (isLit || pitchClass(p) === 0) && this.rowH >= 9) {
        ctx.fillStyle = isLit ? (black ? C.text : '#08090C') : C.keyLabel;
        ctx.textAlign = 'right';
        ctx.fillText(label, KEYS_W - 7, y + this.rowH / 2 + 0.5);
        ctx.textAlign = 'left';
      }
    }
    // Lane label: a small microphone.
    const laneTop = H - LANE_H;
    ctx.fillStyle = C.lane;
    ctx.fillRect(0, laneTop, KEYS_W, LANE_H);
    ctx.fillStyle = C.bar;
    ctx.fillRect(0, laneTop, KEYS_W, 1);
    ctx.strokeStyle = C.voice;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    const cx = KEYS_W / 2;
    const cy = laneTop + LANE_H / 2;
    roundRect(ctx, cx - 3.5, cy - 10, 7, 12, 3.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy - 1, 7, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.moveTo(cx, cy + 6);
    ctx.lineTo(cx, cy + 9);
    ctx.stroke();
  }
}

/** Visible pitch range for a set of notes and a voice curve, at least `minRows` semitones tall. */
export function fitRange(pitches: Iterable<number>, minRows: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pitches) {
    if (Number.isNaN(p)) continue;
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  if (!Number.isFinite(lo)) return [55, 76];
  lo = Math.floor(lo) - 2;
  hi = Math.ceil(hi) + 2;
  while (hi - lo < minRows) {
    lo--;
    hi++;
  }
  return [Math.max(24, lo), Math.min(108, hi)];
}

function lowerBound(a: Float32Array, value: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sizeCanvas(c: HTMLCanvasElement, w: number, h: number, dpr: number): void {
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (c.width !== bw) c.width = bw;
  if (c.height !== bh) c.height = bh;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
