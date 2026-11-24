// ---------------------------------------------------------------------------
// Outlet scorecards over a rolling window (default 7 days).
//
// Rows from every run in the window are deduped by id (latest sighting wins)
// and grouped by outlet. An outlet is RANKED only when it has at least
// SCORECARD_MIN_N rows with article text AND at least SCORECARD_MIN_DAYS
// distinct observation days (DEFECTS.md v2-19); otherwise its row carries a
// progress string such as "12 of 20 · 2 of 3 days". Ranked rates are
// beta-binomial shrunk toward the pooled rate; Wilson intervals are reported
// for the raw rate. Both the strict and the broad definition are published.
// ---------------------------------------------------------------------------
import { SCORECARD_MIN_N, SCORECARD_WINDOW_DAYS, SHRINK_STRENGTH } from './config.js';
import { countsForFI, framingIntegrity, groupByOutlet, isScored, meanOf } from './integrity.js';
import { shrink, wilson } from './stats.js';

export const SCORECARD_MIN_DAYS = 3;

// Latest sighting of every row across runs (newest first).
export function uniqueRows(runs) {
  const seen = new Map();
  for (const run of runs) {
    for (const row of run.rows || []) {
      if (!seen.has(row.id)) seen.set(row.id, { ...row, runId: run.id, runStartedAt: run.startedAt });
    }
  }
  return [...seen.values()];
}

function dayOf(row) {
  const t = row.pubDate || row.runStartedAt;
  return t ? String(t).slice(0, 10) : null;
}

// Rows grouped by metro (rows without one are skipped). Per-metro figures
// are gated exactly like outlets: n ≥ minN text rows over ≥ minDays days.
export function groupByMetro(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!r.metro) continue;
    if (!m.has(r.metro)) m.set(r.metro, []);
    m.get(r.metro).push(r);
  }
  return m;
}

export function buildScorecards(runs, { minN = SCORECARD_MIN_N, minDays = SCORECARD_MIN_DAYS, windowDays = SCORECARD_WINDOW_DAYS, strength = SHRINK_STRENGTH, groupBy = 'outlet' } = {}) {
  const rows = uniqueRows(runs);
  const fiRows = rows.filter(countsForFI);
  const pooled = { strict: framingIntegrity(fiRows, 'strict'), broad: framingIntegrity(fiRows, 'broad') };
  const groups = groupBy === 'metro' ? groupByMetro(rows) : groupByOutlet(rows);
  const cards = [];
  for (const [outlet, group] of groups) {
    const scored = group.filter(isScored);
    const text = group.filter(countsForFI);
    const days = new Set(text.map(dayOf).filter(Boolean));
    const ranked = text.length >= minN && days.size >= minDays;
    const strict = framingIntegrity(text, 'strict');
    const broad = framingIntegrity(text, 'broad');
    const card = {
      outlet,
      ...(groupBy === 'metro' ? { metro: outlet, outlets: [...new Set(group.map((r) => r.outlet || r.publication))].sort() } : {}),
      owner: groupBy === 'metro' ? null : group[0].owner,
      publications: [...new Set(group.map((r) => r.publication))],
      n: group.length,
      nText: text.length,
      days: days.size,
      toneOnly: scored.length > 0 && text.length === 0,
      ranked,
      progress: ranked ? null : `${Math.min(text.length, minN)} of ${minN} · ${Math.min(days.size, minDays)} of ${minDays} days`,
      sens: meanOf(scored.map((r) => r.final.sens)),
      click: meanOf(scored.map((r) => r.final.click)),
      strict: null,
      broad: null,
    };
    if (ranked) {
      for (const [key, fi, pool] of [['strict', strict, pooled.strict], ['broad', broad, pooled.broad]]) {
        const goodHigh = fi.good + fi.provisional;
        card[key] = {
          low: fi.low,
          high: fi.high,
          point: fi.point,
          wilsonLow: wilson(fi.good, fi.n),
          wilsonHigh: wilson(goodHigh, fi.n),
          shrunkLow: shrink(fi.good, fi.n, pool.low == null ? null : pool.low / 100, strength),
          shrunkHigh: shrink(goodHigh, fi.n, pool.high == null ? null : pool.high / 100, strength),
        };
      }
    }
    cards.push(card);
  }
  cards.sort((a, b) => (b.ranked - a.ranked) || (b.nText - a.nText) || a.outlet.localeCompare(b.outlet));
  return {
    groupBy,
    windowDays,
    minN,
    minDays,
    strength,
    runs: runs.length,
    rows: rows.length,
    pooled: { strict: { low: pooled.strict.low, high: pooled.strict.high, n: pooled.strict.n }, broad: { low: pooled.broad.low, high: pooled.broad.high, n: pooled.broad.n } },
    ranked: cards.filter((c) => c.ranked).length,
    cards,
  };
}
