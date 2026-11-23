// ---------------------------------------------------------------------------
// Integrity formulas — methodology v2, with v1 computed in parallel.
//
// Per-article:
//   v1 = 100 × (F + (10−S) + (10−C)) / 30          (v1, no gating; thin rows F=5)
//   v2 = 100 × F/10 × (1 − 0.25·S/10 − 0.25·C/10)  (fidelity gates the score)
//
// Framing Integrity is published TWO ways (DEFECTS.md v2-13), neither yet
// "the" number:
//   strict — share of text rows rated VERIFIED
//   broad  — share of text rows rated VERIFIED or CONTEXTUAL
// Each is a range while PROVISIONAL rows are pending: counted bad = low bound,
// counted good = high bound. Both are computed over rows WITH article text
// (feed summary or full text) that are not UNRESOLVED; unresolved rows are
// counted beside the numbers (DEFECTS.md v2-15). v1 reproduces the old
// population: thin-body rows counted VERIFIED, as the old prompt rule did.
//
// Every function is pure and takes ledger rows (see run.js for the shape).
// Outlet grouping uses `row.outlet` (DEFECTS.md v2-5).
// ---------------------------------------------------------------------------
import { OUTLET_MIN_N } from './config.js';

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export const STRICT_VERDICTS = ['VERIFIED'];
export const BROAD_VERDICTS = ['VERIFIED', 'CONTEXTUAL'];
export const DEFINITIONS = { strict: STRICT_VERDICTS, broad: BROAD_VERDICTS };

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
// Rows whose flagged sweep verdict could never be checked: retries exhausted.
export const isUnresolved = (row) => !!row.escalation?.unresolved;
// The Framing Integrity population.
export const countsForFI = (row) => hasText(row) && !isUnresolved(row);

/**
 * Framing Integrity for one definition ('strict' | 'broad') over rows.
 * @returns {{ n, good, provisional, unresolved, low, high, point }}
 */
export function framingIntegrity(rows, definition = 'broad') {
  const goodSet = DEFINITIONS[definition];
  if (!goodSet) throw new Error(`unknown definition ${definition}`);
  const text = rows.filter(countsForFI);
  const unresolved = rows.filter((r) => hasText(r) && isUnresolved(r)).length;
  const n = text.length;
  if (!n) return { definition, n: 0, good: 0, provisional: 0, unresolved, low: null, high: null, point: null };
  let good = 0;
  let provisional = 0;
  for (const r of text) {
    if (goodSet.includes(r.final.verdict)) good++;
    else if (r.final.verdict === 'PROVISIONAL') provisional++;
  }
  const low = round1((100 * good) / n);
  const high = round1((100 * (good + provisional)) / n);
  return { definition, n, good, provisional, unresolved, low, high, point: round1((low + high) / 2) };
}

export const framingIntegrityStrict = (rows) => framingIntegrity(rows, 'strict');
export const framingIntegrityBroad = (rows) => framingIntegrity(rows, 'broad');
// Back-compatible alias: v2 as first published (broad).
export const framingIntegrityV2 = framingIntegrityBroad;

// Midpoint statistic for one definition — the thing the cluster bootstrap resamples.
export function fiPoint(rows, definition) {
  return framingIntegrity(rows, definition).point;
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
    else if (BROAD_VERDICTS.includes(r.final.verdict)) good++;
  }
  return { n, good, value: round1((100 * good) / n) };
}

// Group FI-population rows by outlet (falls back to publication for rows
// written before the outlet key existed).
export function groupByOutlet(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = r.outlet || r.publication;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  return by;
}

/**
 * Outlet-balanced Framing Integrity: mean of per-outlet midpoints over
 * outlets with at least `minN` FI-population rows (DEFECTS.md v2-6).
 * @returns {{ definition, minN, outlets, qualified, value, perOutlet }}
 */
export function outletBalanced(rows, definition = 'broad', { minN = OUTLET_MIN_N } = {}) {
  const groups = groupByOutlet(rows.filter(countsForFI));
  const perOutlet = [];
  for (const [outlet, group] of groups) {
    const fi = framingIntegrity(group, definition);
    perOutlet.push({ outlet, n: fi.n, point: fi.point, low: fi.low, high: fi.high, qualified: fi.n >= minN });
  }
  const qualified = perOutlet.filter((o) => o.qualified);
  const value = qualified.length ? round1(qualified.reduce((a, o) => a + o.point, 0) / qualified.length) : null;
  return { definition, minN, outlets: perOutlet.length, qualified: qualified.length, value, perOutlet };
}

// Back-compatible alias (broad, min n).
export const outletBalancedV2 = (rows) => {
  const b = outletBalanced(rows, 'broad');
  return { outlets: b.qualified, value: b.value };
};

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
