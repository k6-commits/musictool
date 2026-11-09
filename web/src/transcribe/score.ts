// Note-level accuracy against a known melody (used by tests and the eval script).
// A detected note matches a reference note when the rounded pitch is equal and the onsets are within `onsetTol` seconds.
import type { SungNote } from '../synth/voice';

export interface Score {
  precision: number;
  recall: number;
  f1: number;
  matched: number;
  detected: number;
  reference: number;
}

export function scoreNotes(
  detected: { pitch: number; start: number }[],
  reference: SungNote[],
  onsetTol = 0.07,
): Score {
  const used = new Set<number>();
  let matched = 0;
  for (const ref of reference) {
    const target = Math.round(ref.pitch + (ref.cents ?? 0) / 100);
    let best = -1;
    let bestDist = Infinity;
    detected.forEach((d, i) => {
      if (used.has(i) || Math.round(d.pitch) !== target) return;
      const dist = Math.abs(d.start - ref.start);
      if (dist <= onsetTol && dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    });
    if (best >= 0) {
      used.add(best);
      matched++;
    }
  }
  const precision = detected.length ? matched / detected.length : 0;
  const recall = reference.length ? matched / reference.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, matched, detected: detected.length, reference: reference.length };
}
