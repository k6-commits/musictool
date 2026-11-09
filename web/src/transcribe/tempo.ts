// Tempo guess for a take sung without a click (e.g. an uploaded voice memo).
// Puts the first note on the downbeat and picks the tempo whose eighth-note grid fits the onsets best,
// with a mild preference for tempos around 100 BPM.

export interface TempoGuess {
  bpm: number;
  /** Seconds in the take where bar 1 starts. */
  zero: number;
}

export function estimateTempo(onsets: number[], range: [number, number] = [60, 180]): TempoGuess | null {
  const sorted = [...onsets].sort((a, b) => a - b);
  if (sorted.length < 4) return null;
  const zero = sorted[0];
  const rel = sorted.map((t) => t - zero);
  const sigma = 0.035;
  let best: TempoGuess | null = null;
  let bestScore = -Infinity;
  for (let bpm = range[0]; bpm <= range[1]; bpm += 0.5) {
    const grid = 60 / bpm / 2;
    let fit = 0;
    for (const t of rel) {
      const d = t - Math.round(t / grid) * grid;
      fit += Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    fit /= rel.length;
    const chance = Math.min(1, (sigma * Math.sqrt(2 * Math.PI)) / grid);
    const prior = Math.exp(-(Math.log(bpm / 100) ** 2) / (2 * 0.3 ** 2));
    const score = (fit - chance) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = { bpm: Math.round(bpm), zero };
    }
  }
  return best;
}
