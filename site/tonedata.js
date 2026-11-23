// Pure helpers for the tone map and tone trail, built only from daily.json.
// No scan files are ever loaded by the site.

export const TRAIL_DAYS = 30;
export const OUTLET_MIN_ROWS = 20;

// The last `days` entries of daily.json, oldest first.
export function trailDays(daily, days = TRAIL_DAYS) {
  return (daily?.days || []).slice(-days);
}

// Overall tone trail: one point per day with a centroid; age 0 = latest day.
export function overallTrail(daily, days = TRAIL_DAYS) {
  const list = trailDays(daily, days).filter((d) => d.sens != null && d.click != null);
  return list.map((d, i) => ({ day: d.day, sens: d.sens, click: d.click, n: d.n, age: list.length - 1 - i, scorerChanged: !!d.scorerChanged, models: d.models || [], promptHashes: d.promptHashes || [] }));
}

// Outlets with at least `minRows` scored rows across the window, with their
// totals, sorted by rows descending.
export function eligibleOutlets(daily, { days = TRAIL_DAYS, minRows = OUTLET_MIN_ROWS } = {}) {
  const totals = new Map();
  for (const d of trailDays(daily, days)) {
    for (const [outlet, c] of Object.entries(d.outlets || {})) totals.set(outlet, (totals.get(outlet) || 0) + (c.n || 0));
  }
  return [...totals.entries()].filter(([, n]) => n >= minRows).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([outlet, rows]) => ({ outlet, rows }));
}

// One outlet's trail: days where it had a centroid.
export function outletTrail(daily, outlet, days = TRAIL_DAYS) {
  const list = trailDays(daily, days);
  const pts = [];
  list.forEach((d, i) => {
    const c = d.outlets?.[outlet];
    if (c && c.sens != null && c.click != null) pts.push({ day: d.day, sens: c.sens, click: c.click, n: c.n, age: list.length - 1 - i });
  });
  return pts;
}

// Grid points for a day: [{ sens, click, n, dominant, ids }], plus the day's
// title map when it is recent enough to carry one.
export function dayGrid(daily, day) {
  const d = (daily?.days || []).find((x) => x.day === day);
  if (!d) return { day, grid: [], titles: null, n: 0 };
  return { day: d.day, grid: d.grid || [], titles: d.titles || null, n: d.n || 0 };
}

// Dot radius in px: area proportional to count, bounded.
export function dotRadius(count, { min = 3, max = 14 } = {}) {
  return Math.max(min, Math.min(max, Math.round(2.2 * Math.sqrt(count) + 1.5)));
}

// Headlines for a tapped grid point, resolved from the day's titles or the
// current view's rows; unknown ids are counted, never invented.
export function pointHeadlines(cell, titles, latestRows) {
  const byId = new Map((latestRows || []).map((r) => [r.id, r]));
  const out = [];
  let unknown = 0;
  for (const id of cell.ids || []) {
    const t = titles?.[id];
    if (t) out.push({ id, title: t.t, outlet: t.o, verdict: t.v });
    else if (byId.has(id)) out.push({ id, title: byId.get(id).title, outlet: byId.get(id).outlet || byId.get(id).publication, verdict: byId.get(id).final?.verdict ?? null });
    else unknown++;
  }
  return { items: out, unknown, more: Math.max(0, (cell.n || 0) - (cell.ids || []).length) };
}
