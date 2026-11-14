// Accuracy measures for real recordings.
// Note level: the same matching as mir_eval.transcription (MIREX note tracking): a detected note matches a
// reference note when the onsets are within 50 ms, the pitches within 50 cents and (optionally) the offsets
// within 20 % of the reference note's length or 50 ms, whichever is larger; each note matches at most once
// (maximum bipartite matching). Frame level: raw pitch / chroma accuracy and voicing, as in mir_eval.melody.

export interface TimedNote {
  start: number;
  end: number;
  hz: number;
}

export interface MatchOptions {
  onsetTol?: number;
  /** null: pitch is not compared (onset-only matching). */
  pitchTolCents?: number | null;
  /** null: offsets are not compared. */
  offsetRatio?: number | null;
  offsetMin?: number;
}

export interface PRF {
  precision: number;
  recall: number;
  f1: number;
  matched: number;
}

// mir_eval rounds time differences to 4 decimals so that an exact 50 ms difference counts as a hit.
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const cents = (a: number, b: number) => Math.abs(1200 * Math.log2(a / b));

/** Reference index -> matched detected index (maximum matching). */
export function matchNotes(ref: TimedNote[], est: TimedNote[], o: MatchOptions = {}): Map<number, number> {
  const onsetTol = o.onsetTol ?? 0.05;
  const pitchTol = o.pitchTolCents === undefined ? 50 : o.pitchTolCents;
  const offsetRatio = o.offsetRatio === undefined ? null : o.offsetRatio;
  const offsetMin = o.offsetMin ?? 0.05;
  const edges: number[][] = ref.map((r) => {
    const out: number[] = [];
    const offsetTol = offsetRatio === null ? 0 : Math.max(offsetRatio * (r.end - r.start), offsetMin);
    est.forEach((e, j) => {
      if (round4(Math.abs(r.start - e.start)) > onsetTol) return;
      if (pitchTol !== null && cents(r.hz, e.hz) > pitchTol) return;
      if (offsetRatio !== null && round4(Math.abs(r.end - e.end)) > offsetTol) return;
      out.push(j);
    });
    return out;
  });
  // Kuhn's augmenting paths: small graphs (a few hundred notes per track).
  const estOf = new Map<number, number>();
  const refOfEst = new Int32Array(est.length).fill(-1);
  const augment = (i: number, seen: Uint8Array): boolean => {
    for (const j of edges[i]) {
      if (seen[j]) continue;
      seen[j] = 1;
      if (refOfEst[j] < 0 || augment(refOfEst[j], seen)) {
        refOfEst[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < ref.length; i++) augment(i, new Uint8Array(est.length));
  refOfEst.forEach((i, j) => {
    if (i >= 0) estOf.set(i, j);
  });
  return estOf;
}

export function prf(ref: TimedNote[], est: TimedNote[], o: MatchOptions = {}): PRF {
  if (!ref.length || !est.length) return { precision: 0, recall: 0, f1: 0, matched: 0 };
  const matched = matchNotes(ref, est, o).size;
  const precision = matched / est.length;
  const recall = matched / ref.length;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, matched };
}

/**
 * Octave errors: reference notes whose onset was found (a detected note within the onset tolerance) but
 * whose pitch only matches one or two octaves away. Returned as a share of the notes whose onset was found.
 */
export function octaveErrors(ref: TimedNote[], est: TimedNote[], onsetTol = 0.05, pitchTol = 50): { rate: number; count: number; found: number } {
  let found = 0;
  let count = 0;
  for (const r of ref) {
    const near = est.filter((e) => round4(Math.abs(r.start - e.start)) <= onsetTol);
    if (!near.length) continue;
    found++;
    if (near.some((e) => cents(r.hz, e.hz) <= pitchTol)) continue;
    if (near.some((e) => [1200, 2400].some((k) => Math.abs(cents(r.hz, e.hz) - k) <= pitchTol))) count++;
  }
  return { rate: found ? count / found : 0, count, found };
}

export interface FrameScores {
  /** Raw pitch accuracy: voiced reference frames whose estimated pitch is within 50 cents. */
  rpa: number;
  /** Raw chroma accuracy: the same, ignoring octave errors. */
  rca: number;
  /** Voicing recall: voiced reference frames that the engine calls voiced. */
  vr: number;
  /** Voicing false alarm: unvoiced reference frames that the engine calls voiced. */
  vfa: number;
  /** Overall accuracy: correct voicing decision and, where voiced, correct pitch. */
  oa: number;
  frames: number;
}

/**
 * Scores the engine's frames against a reference f0 track (hz 0 = unvoiced), evaluated at the engine's frame
 * times with the nearest reference sample. As in mir_eval, pitch accuracy uses the engine's pitch estimate
 * even where the engine calls the frame unvoiced.
 */
export function frameScores(
  ref: { t: number[]; hz: number[] },
  est: { t: number; hz: number; voiced: boolean }[],
  tolCents = 50,
): FrameScores {
  let refVoiced = 0;
  let refUnvoiced = 0;
  let pitchOk = 0;
  let chromaOk = 0;
  let voicedHit = 0;
  let falseAlarm = 0;
  let overall = 0;
  let n = 0;
  let k = 0;
  const end = ref.t[ref.t.length - 1] ?? 0;
  for (const e of est) {
    if (e.t < ref.t[0] || e.t > end) continue;
    while (k + 1 < ref.t.length && Math.abs(ref.t[k + 1] - e.t) <= Math.abs(ref.t[k] - e.t)) k++;
    const r = ref.hz[k];
    n++;
    if (r > 0) {
      refVoiced++;
      const d = e.hz > 0 ? 1200 * Math.log2(e.hz / r) : Infinity;
      const ok = Math.abs(d) < tolCents;
      const folded = Number.isFinite(d) ? Math.abs(d - 1200 * Math.round(d / 1200)) : Infinity;
      if (ok) pitchOk++;
      if (folded < tolCents) chromaOk++;
      if (e.voiced) voicedHit++;
      if (e.voiced && ok) overall++;
    } else {
      refUnvoiced++;
      if (e.voiced) falseAlarm++;
      else overall++;
    }
  }
  return {
    rpa: refVoiced ? pitchOk / refVoiced : 0,
    rca: refVoiced ? chromaOk / refVoiced : 0,
    vr: refVoiced ? voicedHit / refVoiced : 0,
    vfa: refUnvoiced ? falseAlarm / refUnvoiced : 0,
    oa: n ? overall / n : 0,
    frames: n,
  };
}

/** F1 of the longest common subsequence of two note-number sequences: right notes in the right order, timing ignored. */
export function sequenceF1(est: number[], ref: number[]): number {
  if (!est.length || !ref.length) return 0;
  let prev = new Int32Array(ref.length + 1);
  for (const x of est) {
    const cur = new Int32Array(ref.length + 1);
    for (let j = 0; j < ref.length; j++) cur[j + 1] = x === ref[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]);
    prev = cur;
  }
  const l = prev[ref.length];
  const p = l / est.length;
  const r = l / ref.length;
  return p + r ? (2 * p * r) / (p + r) : 0;
}
