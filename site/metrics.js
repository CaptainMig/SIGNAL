// Pure helpers for the deck, kept free of DOM so they can be unit-tested.
// Every number here is read from the ledger files; nothing is estimated.
import { groupBy, mean } from './ui.js';

export const DAY = 86400e3;

// history.csv rows joined with stats.csv rows by run_id (stats may be absent
// for runs recorded before phase 2).
export function mergeStats(history, stats) {
  const byRun = new Map((stats || []).map((r) => [r.run_id, r]));
  return (history || []).map((h) => ({ ...h, stats: byRun.get(h.run_id) || null }));
}

// The latest run row and the one before it, in started_at order.
export function latestAndPrevious(history) {
  const sorted = [...(history || [])].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  return { latest: sorted[sorted.length - 1] || null, previous: sorted[sorted.length - 2] || null };
}

const mid = (lo, hi) => (lo == null || hi == null ? null : (lo + hi) / 2);
const delta = (a, b) => (a == null || b == null ? null : Math.round((a - b) * 10) / 10);

// Change since the previous run: midpoint of the broad and strict ranges,
// coverage, rows, cost. Null when there is no previous run.
export function changeSince(latest, previous) {
  if (!latest || !previous) return null;
  return {
    previousRunId: previous.run_id,
    broadMid: delta(mid(latest.fi_v2_low, latest.fi_v2_high), mid(previous.fi_v2_low, previous.fi_v2_high)),
    strictMid: delta(mid(latest.stats?.fi_strict_low, latest.stats?.fi_strict_high), mid(previous.stats?.fi_strict_low, previous.stats?.fi_strict_high)),
    coverage: delta(latest.coverage_pct, previous.coverage_pct),
    rows: latest.rows_total != null && previous.rows_total != null ? latest.rows_total - previous.rows_total : null,
    cost: latest.cost_usd != null && previous.cost_usd != null ? Math.round((latest.cost_usd - previous.cost_usd) * 1e4) / 1e4 : null,
    unscored: latest.rows_unscored != null && previous.rows_unscored != null ? latest.rows_unscored - previous.rows_unscored : null,
  };
}

// Pick the range and interval columns for a definition.
function pick(row, def) {
  if (def === 'strict') {
    const s = row.stats;
    return s ? { low: s.fi_strict_low, high: s.fi_strict_high, ciLo: s.fi_strict_ci_low, ciHi: s.fi_strict_ci_high } : { low: null, high: null, ciLo: null, ciHi: null };
  }
  return { low: row.fi_v2_low, high: row.fi_v2_high, ciLo: row.stats?.fi_broad_ci_low ?? null, ciHi: row.stats?.fi_broad_ci_high ?? null };
}

/**
 * Series for the history chart. Per run (24h) or per UTC day (7d, 30d).
 * `low`/`high` is the provisional-outcome range; `ciLo`/`ciHi` the sampling
 * interval (null when no run in the bucket has one). Two different things;
 * the chart draws them separately.
 */
export function historySeries(merged, win, def = 'broad', now = Date.now()) {
  const span = win === '24h' ? DAY : win === '7d' ? 7 * DAY : 30 * DAY;
  const runs = (merged || []).filter((r) => Date.parse(r.started_at) >= now - span).map((r) => ({ t: r.started_at, ...pick(r, def) })).filter((r) => r.low != null);
  if (win === '24h') return runs.map((r) => ({ ...r, mid: mid(r.low, r.high), n: 1 }));
  const byDay = groupBy(runs, (r) => String(r.t).slice(0, 10));
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, rs]) => ({
    t: day,
    low: mean(rs.map((r) => r.low)),
    high: mean(rs.map((r) => r.high)),
    mid: mean(rs.map((r) => mid(r.low, r.high))),
    ciLo: mean(rs.map((r) => r.ciLo)),
    ciHi: mean(rs.map((r) => r.ciHi)),
    n: rs.length,
  }));
}

// Sum of a column over the runs in a window.
// Sums a column over the window. A merged row carries its stats.csv columns
// under `stats`, so a key that lives only there is read from there
// (DEFECTS.md v2-49).
export function windowSum(history, key, days, now = Date.now()) {
  const val = (r) => {
    const v = r[key] !== undefined && r[key] !== '' ? r[key] : r.stats?.[key];
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return (history || []).filter((r) => Date.parse(r.started_at) >= now - days * DAY).reduce((a, r) => a + val(r), 0);
}

export function windowRuns(history, days, now = Date.now()) {
  return (history || []).filter((r) => Date.parse(r.started_at) >= now - days * DAY);
}

// The ledger is stale when the latest run finished more than this long ago:
// the hourly scan has missed at least one slot. The deck says so at the top.
export const STALE_AFTER_MS = 2 * 3600e3;
export function staleness(latest, now = Date.now()) {
  const t = Date.parse(latest?.finishedAt || '');
  if (!Number.isFinite(t)) return null;
  const ageMs = now - t;
  if (ageMs <= STALE_AFTER_MS) return null;
  return { ageMs, ageMinutes: Math.round(ageMs / 60000), finishedAt: latest.finishedAt };
}
