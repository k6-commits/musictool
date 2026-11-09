// Tempo guess for a take sung without a click (e.g. an uploaded voice memo).
// For each tempo, fit the phase of an eighth-note grid to the onsets (circular mean), score how well the
// onsets sit on that grid (with a mild preference for tempos around 100 BPM), and put bar 1 on the grid
// line nearest to the first note.

export interface TempoGuess {
  bpm: number;
  /** Seconds in the take where bar 1 starts. */
  zero: number;
}

export function estimateTempo(onsets: number[]): TempoGuess | null {
  const sorted = [...onsets].sort((a, b) => a - b);
  if (sorted.length < 4) return null;
  const sigma = 0.035;
  let best: TempoGuess | null = null;
  let bestScore = -Infinity;
  for (let bpm = 60; bpm <= 180; bpm++) {
    const grid = 60 / bpm / 2;
    let sx = 0;
    let sy = 0;
    for (const t of sorted) {
      const a = (2 * Math.PI * t) / grid;
      sx += Math.cos(a);
      sy += Math.sin(a);
    }
    const phase = (Math.atan2(sy, sx) / (2 * Math.PI)) * grid;
    let fit = 0;
    for (const t of sorted) {
      const r = t - phase;
      const d = r - Math.round(r / grid) * grid;
      fit += Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    fit /= sorted.length;
    const chance = Math.min(1, (sigma * Math.sqrt(2 * Math.PI)) / grid);
    const prior = Math.exp(-(Math.log(bpm / 100) ** 2) / (2 * 0.3 ** 2));
    const score = (fit - chance) * prior;
    if (score > bestScore) {
      bestScore = score;
      const zero = phase + Math.round((sorted[0] - phase) / grid) * grid;
      best = { bpm, zero: Math.max(0, zero) };
    }
  }
  return best;
}
