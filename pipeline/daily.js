// ---------------------------------------------------------------------------
// data/daily.json — a small derived summary per day for the tone trail and
// the tone-map scrubber, so the site never loads raw scan files.
//
// Per day (ET calendar day of the row's publication, else of the run):
//   overall centroid (mean sensationalism, mean clickbait), row counts,
//   per-outlet centroids and counts, the (sens, click) grid with counts and
//   the dominant verdict, and the set of model strings and prompt hashes
//   seen — so a jump caused by a scorer change can be marked, not misread as
//   a change in the news.
//
// Updated incrementally: each run recomputes the days that intersect the
// reuse window it already loads (rows are deduped by id, latest sighting
// wins) and keeps older days as they were. Kept for DAILY_KEEP_DAYS.
// ---------------------------------------------------------------------------
import { groupByOutlet, isScored, meanOf } from './integrity.js';
import { uniqueRows } from './scorecards.js';

export const DAILY_KEEP_DAYS = 35;
export const DAILY_TIME_ZONE = 'America/New_York';

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// ET calendar day of an ISO timestamp.
export function dayOf(iso, timeZone = DAILY_TIME_ZONE) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t));
  const get = (k) => parts.find((p) => p.type === k)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function centroid(rows) {
  const scored = rows.filter((r) => isScored(r) && r.final.sens != null && r.final.click != null);
  return { n: scored.length, sens: round2(meanOf(scored.map((r) => r.final.sens))), click: round2(meanOf(scored.map((r) => r.final.click))) };
}

function grid(rows) {
  const cells = new Map();
  for (const r of rows) {
    if (!isScored(r) || r.final.sens == null || r.final.click == null) continue;
    const key = `${r.final.sens},${r.final.click}`;
    if (!cells.has(key)) cells.set(key, { sens: r.final.sens, click: r.final.click, n: 0, verdicts: {}, ids: [] });
    const c = cells.get(key);
    c.n++;
    const v = r.final.verdict || 'TONE';
    c.verdicts[v] = (c.verdicts[v] || 0) + 1;
    if (c.ids.length < 50) c.ids.push(r.id);
  }
  return [...cells.values()]
    .map((c) => ({ ...c, dominant: Object.entries(c.verdicts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0] }))
    .sort((a, b) => a.sens - b.sens || a.click - b.click);
}

// Summarize one day's rows.
export function summarizeDay(day, rows) {
  const outlets = {};
  for (const [outlet, group] of groupByOutlet(rows)) outlets[outlet] = centroid(group);
  const models = new Set();
  const prompts = new Set();
  for (const r of rows) {
    for (const s of [r.sweep, r.fulltext]) {
      if (s?.model) models.add(s.model);
      if (s?.promptHash) prompts.add(s.promptHash);
    }
  }
  return { day, ...centroid(rows), rows: rows.length, outlets, grid: grid(rows), models: [...models].sort(), promptHashes: [...prompts].sort() };
}

/**
 * Update the daily summary from a window of resolved runs.
 * @param previous  the existing daily.json ({ days: [...] }) or null
 * @param runs      resolved runs (newest first) covering the recompute window
 * @param now       ms; days older than DAILY_KEEP_DAYS are dropped
 * @param recomputeDays  which days to rebuild from `runs` (default: every day
 *                       any row in `runs` falls on)
 */
export function updateDaily(previous, runs, { now = Date.now(), keepDays = DAILY_KEEP_DAYS, timeZone = DAILY_TIME_ZONE } = {}) {
  const rows = uniqueRows(runs);
  const byDay = new Map();
  for (const r of rows) {
    const day = dayOf(r.pubDate || r.runStartedAt, timeZone);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const days = new Map((previous?.days || []).map((d) => [d.day, d]));
  for (const [day, dayRows] of byDay) days.set(day, summarizeDay(day, dayRows));
  const cutoff = dayOf(new Date(now - keepDays * 86400e3).toISOString(), timeZone);
  const kept = [...days.values()].filter((d) => d.day >= cutoff).sort((a, b) => (a.day < b.day ? -1 : 1));
  // Scorer-change markers: a day whose model or prompt set differs from the
  // previous day's.
  for (let i = 0; i < kept.length; i++) {
    const prev = kept[i - 1];
    kept[i].scorerChanged = !!prev && (prev.models.join('|') !== kept[i].models.join('|') || prev.promptHashes.join('|') !== kept[i].promptHashes.join('|'));
  }
  return { timeZone, keepDays, updatedAt: new Date(now).toISOString(), days: kept };
}
