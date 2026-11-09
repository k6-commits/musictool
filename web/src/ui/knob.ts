// Rotary knob: an SVG dial over an invisible native range input (keeps keyboard and screen reader support).

const CX = 32;
const CY = 32;
const R = 26;

function point(v: number): [number, number] {
  const a = ((135 + 270 * v) * Math.PI) / 180;
  return [CX + R * Math.cos(a), CY + R * Math.sin(a)];
}

export function arcPath(v: number): string {
  const t = Math.max(0, Math.min(1, v));
  if (t < 0.005) return '';
  const [x0, y0] = point(0);
  const [x1, y1] = point(t);
  const large = 270 * t > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export class Knob {
  readonly input: HTMLInputElement;
  private readonly arc: SVGPathElement;
  private readonly dot: SVGCircleElement;
  private readonly text: SVGTextElement;

  constructor(root: HTMLElement, value: number, onInput: (v: number) => void) {
    const label = root.dataset.label ?? '';
    const title = root.dataset.title ?? label;
    root.innerHTML = `
      <svg width="56" height="56" viewBox="0 0 64 64" aria-hidden="true">
        <circle class="face" cx="32" cy="32" r="31" fill="#15181E"/>
        <path d="${arcPath(1)}" fill="none" stroke="#23272F" stroke-width="4" stroke-linecap="round"/>
        <path class="arc" fill="none" stroke="#56C2FF" stroke-width="4" stroke-linecap="round"/>
        <circle class="dot" r="3.5" fill="#F4F5F7"/>
        <text x="32" y="37" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-size="15" font-weight="700" fill="#F4F5F7"></text>
      </svg>
      <span class="eyebrow">${label}</span>
      <input type="range" min="0" max="100" step="1" aria-label="${title}" title="${title}">`;
    this.input = root.querySelector('input') as HTMLInputElement;
    this.arc = root.querySelector('path.arc') as SVGPathElement;
    this.dot = root.querySelector('circle.dot') as SVGCircleElement;
    this.text = root.querySelector('text') as SVGTextElement;
    this.set(value);
    this.input.addEventListener('input', () => {
      const v = Number(this.input.value) / 100;
      this.paint(v);
      onInput(v);
    });
    releaseFocusAfterPointer(this.input);
  }

  set(v: number): void {
    this.input.value = String(Math.round(v * 100));
    this.paint(v);
  }

  private paint(v: number): void {
    this.arc.setAttribute('d', arcPath(v));
    const [x, y] = point(v);
    this.dot.setAttribute('cx', x.toFixed(2));
    this.dot.setAttribute('cy', y.toFixed(2));
    this.text.textContent = String(Math.round(v * 100));
  }
}

/**
 * After a mouse or touch drag, give focus back to the page so shortcuts such as Home or the arrow keys
 * do not silently move the slider. Keyboard users who tab to it keep the native slider keys.
 */
export function releaseFocusAfterPointer(input: HTMLInputElement): void {
  input.addEventListener('pointerup', () => input.blur());
}
