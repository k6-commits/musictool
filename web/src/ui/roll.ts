// Piano roll on canvas: key column, bar ruler, notes, the voice curve, the waveform lane and the playhead.

export interface RollNote {
  id: string;
  pitch: number;
  startBeat: number;
  endBeat: number;
  flagged: boolean;
  label: string;
  /** 0..1, for the "notes appear" animation. */
  alpha?: number;
}

export interface RollView {
  notes: RollNote[];
  /** Voice curve: song time in beats and tuning-corrected pitch (NaN = silence). */
  curve: { beats: Float32Array; pitch: Float32Array } | null;
  /** Peak envelope of the voice, one value per `envStep` beats, starting at `envStart` beats. */
  envelope: { start: number; step: number; peaks: Float32Array } | null;
  totalBeats: number;
  beatsPerBar: number;
  grid: number;
  playhead: number | null;
  selectedId: string | null;
  lit: { pitch: number; kind: 'voice' | 'note' } | null;
  keyLabel: (midi: number) => string | null;
  /** Fixed pitch range, or null to fit the material. */
  range: [number, number] | null;
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

const KEYS_W = 56;
const RULER_H = 22;
const LANE_H = 54;
const BLACK = new Set([1, 3, 6, 8, 10]);
const FONT = "600 11px 'Space Grotesk', 'Noto Sans JP', system-ui, sans-serif";

export class PianoRoll {
  readonly root: HTMLElement;
  private readonly keys: HTMLCanvasElement;
  private readonly scroller: HTMLElement;
  private readonly roll: HTMLCanvasElement;
  private view: RollView | null = null;
  private pxPerBeat = 48;
  private rowH = 16;
  private lo = 55;
  private hi = 76;
  private width = 600;
  private height = 400;
  onPick: ((id: string | null, beat: number) => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.keys = root.querySelector('canvas.keys') as HTMLCanvasElement;
    this.scroller = root.querySelector('.scroller') as HTMLElement;
    this.roll = root.querySelector('canvas.roll') as HTMLCanvasElement;
    new ResizeObserver(() => this.layout()).observe(root);
    this.scroller.addEventListener('scroll', () => this.draw());
    this.roll.addEventListener('pointerdown', (e) => {
      const rect = this.roll.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.onPick?.(this.hit(x, y), Math.max(0, x / this.pxPerBeat));
    });
  }

  setView(view: RollView): void {
    const resize = !this.view || this.view.totalBeats !== view.totalBeats || this.rangeChanged(view);
    this.view = view;
    if (resize) this.layout();
    else this.draw();
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

  private rangeChanged(v: RollView): boolean {
    const [lo, hi] = this.fitRange(v);
    return lo !== this.lo || hi !== this.hi;
  }

  private fitRange(v: RollView): [number, number] {
    if (v.range) return v.range;
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of v.notes) {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    }
    if (v.curve) {
      for (const p of v.curve.pitch) {
        if (Number.isNaN(p)) continue;
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
      }
    }
    if (!Number.isFinite(lo)) return [55, 76];
    lo = Math.floor(lo) - 2;
    hi = Math.ceil(hi) + 2;
    // Show at least 12-18 rows, fewer on short screens so rows stay tall enough to read.
    const usable = (this.root.clientHeight || 400) - RULER_H - LANE_H;
    const minRows = Math.max(12, Math.min(18, Math.floor(usable / 20)));
    while (hi - lo < minRows) {
      lo--;
      hi++;
    }
    return [Math.max(24, lo), Math.min(108, hi)];
  }

  private layout(): void {
    const v = this.view;
    const rect = this.root.getBoundingClientRect();
    this.height = Math.max(240, rect.height);
    const visibleW = Math.max(200, rect.width - KEYS_W);
    if (v) [this.lo, this.hi] = this.fitRange(v);
    const rows = this.hi - this.lo + 1;
    this.rowH = (this.height - RULER_H - LANE_H) / rows;
    const beats = v?.totalBeats ?? 16;
    const visibleBeats = Math.min(beats, 16);
    this.pxPerBeat = Math.max(28, visibleW / visibleBeats);
    this.width = Math.max(visibleW, beats * this.pxPerBeat);
    sizeCanvas(this.keys, KEYS_W, this.height);
    sizeCanvas(this.roll, this.width, this.height);
    this.draw();
  }

  /** Pixel position helpers (CSS px, roll canvas coordinates). */
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

  draw(): void {
    const v = this.view;
    this.drawKeys(v);
    const ctx = this.roll.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.width;
    const H = this.height;
    const left = this.scroller.scrollLeft;
    const right = left + this.scroller.clientWidth;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // Rows.
    for (let p = this.lo; p <= this.hi; p++) {
      const y = this.y(p);
      ctx.fillStyle = BLACK.has(((p % 12) + 12) % 12) ? C.rowBlack : C.rowWhite;
      ctx.fillRect(0, y, W, this.rowH);
      if (p % 12 === 0) {
        ctx.fillStyle = C.rowC;
        ctx.fillRect(0, y + this.rowH - 1, W, 1);
      }
    }

    // Grid, beats, bars and the ruler.
    const total = v?.totalBeats ?? 16;
    const bpb = v?.beatsPerBar ?? 4;
    const grid = v?.grid ?? 0.5;
    const laneTop = H - LANE_H;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    for (let b = 0; b <= total + 1e-6; b += grid) {
      const x = Math.round(b * this.pxPerBeat) + 0.5;
      if (x < left - 2 || x > right + 2) continue;
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
    ctx.fillRect(0, laneTop, W, LANE_H);
    ctx.fillStyle = C.bar;
    ctx.fillRect(0, laneTop, W, 1);
    if (v?.envelope) {
      const e = v.envelope;
      const mid = laneTop + LANE_H / 2;
      const half = (LANE_H - 12) / 2;
      ctx.fillStyle = 'rgba(255,107,74,0.55)';
      ctx.beginPath();
      const xs: number[] = [];
      const hs: number[] = [];
      for (let i = 0; i < e.peaks.length; i++) {
        const x = (e.start + i * e.step) * this.pxPerBeat;
        if (x < left - 8 || x > right + 8) continue;
        xs.push(x);
        hs.push(Math.max(0.5, e.peaks[i] * half));
      }
      if (xs.length) {
        ctx.moveTo(xs[0], mid - hs[0]);
        for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], mid - hs[i]);
        for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], mid + hs[i]);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Note bodies.
    const boxes: { n: RollNote; x0: number; y: number; w: number; h: number; a: number }[] = [];
    if (v) {
      for (const n of v.notes) {
        const x0 = n.startBeat * this.pxPerBeat;
        const x1 = n.endBeat * this.pxPerBeat;
        if (x1 < left - 4 || x0 > right + 4) continue;
        const a = n.alpha ?? 1;
        if (a <= 0) continue;
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
      }
    }

    // Voice curve, between the note bodies and their labels.
    if (v?.curve) {
      const { beats, pitch } = v.curve;
      ctx.strokeStyle = C.voice;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      let pen = false;
      let lastB = -1;
      for (let i = 0; i < beats.length; i++) {
        const p = pitch[i];
        const x = beats[i] * this.pxPerBeat;
        if (Number.isNaN(p) || x < left - 40 || x > right + 40 || p < this.lo - 1 || p > this.hi + 1) {
          pen = false;
          continue;
        }
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
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
      const black = BLACK.has(((p % 12) + 12) % 12);
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
      if (label && (isLit || p % 12 === 0) && this.rowH >= 9) {
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

function sizeCanvas(c: HTMLCanvasElement, w: number, h: number): void {
  const dpr = window.devicePixelRatio || 1;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
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
