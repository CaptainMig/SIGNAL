// ---------------------------------------------------------------------------
// Integrity formulas — methodology v2, with v1 computed in parallel.
//
// Per-article:
//   v1 = 100 × (F + (10−S) + (10−C)) / 30          (v1, no gating; thin rows F=5)
//   v2 = 100 × F/10 × (1 − 0.25·S/10 − 0.25·C/10)  (fidelity gates the score)
//
// Framing Integrity (share of rows whose headline fairly represents its own
// article). v2 is computed over rows WITH article text only, and shown as a
// range while PROVISIONAL rows are pending: counted bad = low bound, counted
// good = high bound. v1 reproduces the old population: thin-body rows counted
// as VERIFIED, which is what the old empty-body prompt rule did.
//
// Every function is pure and takes ledger rows (see run.js for the shape).
// ---------------------------------------------------------------------------
import { INTEGRITY_VERDICTS } from './verdicts.js';

const round1 = (n) => Math.round(n * 10) / 10;

export function articleIntegrityV1(score, { thinBody = false } = {}) {
  if (!score || score.sens == null || score.click == null) return null;
  const f = score.fidelity == null ? (thinBody ? 5 : null) : score.fidelity;
  if (f == null) return null;
  return Math.round((100 * (f + (10 - score.sens) + (10 - score.click))) / 30);
}

export function articleIntegrityV2(score) {
  if (!score || score.fidelity == null || score.sens == null || score.click == null) return null;
  const v = 100 * (score.fidelity / 10) * (1 - 0.25 * (score.sens / 10) - 0.25 * (score.click / 10));
  return Math.round(v * 10) / 10;
}

// Rows that have a final score of any kind (not UNSCORED).
export const isScored = (row) => !!row.final && row.final.source !== 'unscored';
// Rows whose final verdict was judged against article text (feed or fulltext).
export const hasText = (row) => isScored(row) && row.final.verdict != null && row.final.source !== 'tone';

/**
 * Framing Integrity v2 over rows with article text.
 * @returns {{ n, good, provisional, low, high, point }} percentages 0–100, or
 *          nulls when n is 0. `point` is the midpoint for sparklines.
 */
export function framingIntegrityV2(rows) {
  const text = rows.filter(hasText);
  const n = text.length;
  if (!n) return { n: 0, good: 0, provisional: 0, low: null, high: null, point: null };
  let good = 0;
  let provisional = 0;
  for (const r of text) {
    if (INTEGRITY_VERDICTS.includes(r.final.verdict)) good++;
    else if (r.final.verdict === 'PROVISIONAL') provisional++;
  }
  const low = round1((100 * good) / n);
  const high = round1((100 * (good + provisional)) / n);
  return { n, good, provisional, low, high, point: round1((low + high) / 2) };
}

/**
 * Framing Integrity v1-compatible: every scored row counts; thin-body rows
 * (no verdict) count as VERIFIED, as the old empty-body rule produced.
 */
export function framingIntegrityV1(rows) {
  const scored = rows.filter(isScored);
  const n = scored.length;
  if (!n) return { n: 0, good: 0, value: null };
  let good = 0;
  for (const r of scored) {
    if (r.final.verdict == null) good++; // thin row: old rule defaulted to VERIFIED
    else if (INTEGRITY_VERDICTS.includes(r.final.verdict)) good++;
  }
  return { n, good, value: round1((100 * good) / n) };
}

// Outlet-balanced Framing Integrity v2: mean of per-outlet rates (point
// estimate of each outlet's range midpoint), so a high-volume outlet cannot
// dominate. Outlets with no text rows are skipped.
export function outletBalancedV2(rows) {
  const byPub = new Map();
  for (const r of rows.filter(hasText)) {
    if (!byPub.has(r.publication)) byPub.set(r.publication, []);
    byPub.get(r.publication).push(r);
  }
  const rates = [];
  for (const [, group] of byPub) {
    const fi = framingIntegrityV2(group);
    if (fi.point != null) rates.push(fi.point);
  }
  if (!rates.length) return { outlets: 0, value: null };
  return { outlets: rates.length, value: round1(rates.reduce((a, b) => a + b, 0) / rates.length) };
}

// Coverage: share of rows (excluding unscored) that carry article text.
export function coverage(rows) {
  const scored = rows.filter(isScored);
  if (!scored.length) return { n: 0, withText: 0, value: null };
  const withText = scored.filter(hasText).length;
  return { n: scored.length, withText, value: round1((100 * withText) / scored.length) };
}

export function meanOf(values) {
  const xs = values.filter((v) => v != null && Number.isFinite(v));
  if (!xs.length) return null;
  return round1(xs.reduce((a, b) => a + b, 0) / xs.length);
}

export function medianOf(values) {
  const xs = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return round1(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2);
}
