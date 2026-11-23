// ---------------------------------------------------------------------------
// The Signal → AnthonyCharts aggregate, computed from the ledger.
//
// Same response shape as v1's /api/aggregate so the anthonycharts generator
// keeps working: { asOf, windowHours: 24, scored, total, meanIntegrity,
// medianIntegrity, source }. Rows from every run in the window are deduped by
// row id (an article is re-seen by many hourly runs; the latest row wins).
//
// meanIntegrity is per-article integrity v1 over rows WITH article text —
// v1's thin-body rows carried a placeholder fidelity of 5 that contaminated
// the meter (DEFECTS.md). v2 fields ride alongside for the cutover.
// ---------------------------------------------------------------------------
import { METHODOLOGY } from './config.js';
import { articleIntegrityV1, articleIntegrityV2, hasText, isScored, meanOf, medianOf } from './integrity.js';

export const WINDOW_HOURS = 24;

export function computeAggregate(runs, { now = Date.now() } = {}) {
  const latestById = new Map();
  // runs are newest first; keep the first (latest) sighting of each row id.
  for (const run of runs) {
    for (const row of run.rows || []) {
      if (!latestById.has(row.id)) latestById.set(row.id, row);
    }
  }
  const rows = [...latestById.values()];
  const textRows = rows.filter(hasText);
  const v1 = textRows.map((r) => articleIntegrityV1(r.final));
  const v2 = textRows.map((r) => articleIntegrityV2(r.final));
  const asOf = runs.length ? runs[0].finishedAt || runs[0].startedAt : null;
  return {
    asOf,
    windowHours: WINDOW_HOURS,
    scored: textRows.length,
    total: rows.length,
    meanIntegrity: meanOf(v1),
    medianIntegrity: medianOf(v1),
    meanIntegrityV2: meanOf(v2),
    medianIntegrityV2: medianOf(v2),
    scoredAny: rows.filter(isScored).length,
    runs: runs.length,
    methodology: METHODOLOGY,
    source: 'ledger',
    computedAt: new Date(now).toISOString(),
  };
}
