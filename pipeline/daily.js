// ---------------------------------------------------------------------------
// data/daily.json — a small derived summary per day for the tone trail and
// the tone-map scrubber, so the site never loads raw scan files.
//
// Per day (the ET calendar day Signal first saw the row):
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
import { DAY_TIME_ZONE, dayOf } from './days.js';
import { uniqueRows } from './scorecards.js';

export const DAILY_KEEP_DAYS = 35;
// Headline text is kept per day for this many recent days so a tapped grid
// point can list its headlines without loading a scan file; older days keep
// ids only.
export const DAILY_TITLE_DAYS = 7;
export const DAILY_TIME_ZONE = DAY_TIME_ZONE;

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

export { dayOf };

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

// Summarize one day's rows. `withTitles` keeps { id: title } for the day.
export function summarizeDay(day, rows, { withTitles = false } = {}) {
  const outlets = {};
  for (const [outlet, group] of groupByOutlet(rows)) outlets[outlet] = centroid(group);
  const models = new Set();
  const prompts = new Set();
  // Per mode, so a day that happens to have no full-text rows is not read
  // as a scorer change against a day that has some.
  const scorer = {};
  for (const r of rows) {
    for (const s of [r.sweep, r.fulltext]) {
      if (!s?.mode) continue;
      const m = (scorer[s.mode] ||= { models: new Set(), prompts: new Set() });
      if (s.model) {
        models.add(s.model);
        m.models.add(s.model);
      }
      if (s.promptHash) {
        prompts.add(s.promptHash);
        m.prompts.add(s.promptHash);
      }
    }
  }
  const out = {
    day,
    ...centroid(rows),
    rows: rows.length,
    outlets,
    grid: grid(rows),
    models: [...models].sort(),
    promptHashes: [...prompts].sort(),
    scorer: Object.fromEntries(Object.entries(scorer).map(([mode, m]) => [mode, { models: [...m.models].sort(), prompts: [...m.prompts].sort() }])),
  };
  if (withTitles) out.titles = Object.fromEntries(rows.filter((r) => isScored(r)).map((r) => [r.id, { t: r.title, o: r.outlet || r.publication, v: r.final.verdict }]));
  return out;
}

export function scorerChangedBetween(prev, cur) {
  if (!prev || !cur) return false;
  const a = prev.scorer || {};
  const b = cur.scorer || {};
  const modes = Object.keys(a).filter((m) => m in b);
  if (!modes.length) {
    // Entries written before per-mode tracking: fall back to the aggregate
    // sets only when both days have them.
    if (!prev.models?.length || !cur.models?.length) return false;
    return prev.models.join('|') !== cur.models.join('|') || prev.promptHashes.join('|') !== cur.promptHashes.join('|');
  }
  return modes.some((m) => a[m].models.join('|') !== b[m].models.join('|') || a[m].prompts.join('|') !== b[m].prompts.join('|'));
}

/**
 * Update the daily summary from a window of resolved runs.
 * @param previous  the existing daily.json ({ days: [...] }) or null
 * @param runs      resolved runs (newest first) covering the recompute window
 * @param now       ms; days older than DAILY_KEEP_DAYS are dropped
 * @param recomputeDays  which days to rebuild from `runs` (default: every day
 *                       any row in `runs` falls on)
 */
export function updateDaily(previous, runs, { now = Date.now(), keepDays = DAILY_KEEP_DAYS, titleDays = DAILY_TITLE_DAYS, timeZone = DAILY_TIME_ZONE } = {}) {
  const rows = uniqueRows(runs);
  const byDay = new Map();
  for (const r of rows) {
    // Bucket by the ET day Signal first saw the row (a scan day), never by
    // the publisher's date: a future-dated or backdated stamp made one-row
    // days (DEFECTS.md v2-43).
    const day = dayOf(r.firstSeen || r.runStartedAt, timeZone);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const days = new Map((previous?.days || []).map((d) => [d.day, d]));
  const titleCutoff = dayOf(new Date(now - titleDays * 86400e3).toISOString(), timeZone);
  for (const [day, dayRows] of byDay) days.set(day, summarizeDay(day, dayRows, { withTitles: day >= titleCutoff }));
  const cutoff = dayOf(new Date(now - keepDays * 86400e3).toISOString(), timeZone);
  const kept = [...days.values()].filter((d) => d.day >= cutoff).sort((a, b) => (a.day < b.day ? -1 : 1));
  // Titles age out of days older than titleDays even when the day itself is kept.
  for (const d of kept) if (d.titles && d.day < titleCutoff) delete d.titles;
  // Scorer-change markers: for every mode present on both days, the model
  // set or the prompt set differs from the previous day's.
  for (let i = 0; i < kept.length; i++) {
    kept[i].scorerChanged = scorerChangedBetween(kept[i - 1], kept[i]);
  }
  return { timeZone, keepDays, updatedAt: new Date(now).toISOString(), days: kept };
}
