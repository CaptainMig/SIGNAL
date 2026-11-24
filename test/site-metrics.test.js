import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeSince, historySeries, latestAndPrevious, mergeStats, windowSum } from '../site/metrics.js';

const h = (run_id, started_at, lo, hi, extra = {}) => ({ run_id, started_at, fi_v2_low: lo, fi_v2_high: hi, coverage_pct: 80, rows_total: 200, rows_unscored: 0, cost_usd: 0.3, ...extra });

test('mergeStats joins by run_id and tolerates runs without stats', () => {
  const m = mergeStats([h('a', '2026-11-23T18:00:00Z', 80, 90), h('b', '2026-11-23T19:00:00Z', 82, 92)], [{ run_id: 'b', fi_strict_low: 60, fi_strict_high: 70, fi_broad_ci_low: 78, fi_broad_ci_high: 95 }]);
  assert.equal(m[0].stats, null);
  assert.equal(m[1].stats.fi_strict_low, 60);
});

test('latestAndPrevious orders by started_at; changeSince reports deltas or null', () => {
  const rows = mergeStats(
    [h('b', '2026-11-23T19:00:00Z', 82, 92, { coverage_pct: 81, rows_total: 210, cost_usd: 0.12, rows_unscored: 1 }), h('a', '2026-11-23T18:00:00Z', 80, 90)],
    [{ run_id: 'a', fi_strict_low: 60, fi_strict_high: 70 }, { run_id: 'b', fi_strict_low: 63, fi_strict_high: 71 }]
  );
  const { latest, previous } = latestAndPrevious(rows);
  assert.equal(latest.run_id, 'b');
  assert.equal(previous.run_id, 'a');
  assert.deepEqual(changeSince(latest, previous), { previousRunId: 'a', broadMid: 2, strictMid: 2, coverage: 1, rows: 10, cost: -0.18, unscored: 1 });
  assert.equal(changeSince(latest, null), null);
  assert.equal(changeSince(latest, { run_id: 'z', started_at: 'x' }).broadMid, null);
});

test('historySeries keeps the provisional-outcome range and the sampling interval apart', () => {
  const now = Date.parse('2026-11-23T20:00:00Z');
  const rows = mergeStats(
    [h('a', '2026-11-23T18:00:00Z', 80, 90), h('b', '2026-11-23T19:00:00Z', 82, 92), h('old', '2026-10-01T19:00:00Z', 50, 60)],
    [{ run_id: 'b', fi_strict_low: 60, fi_strict_high: 70, fi_strict_ci_low: 55, fi_strict_ci_high: 75, fi_broad_ci_low: 78, fi_broad_ci_high: 95 }]
  );
  const perRun = historySeries(rows, '24h', 'broad', now);
  assert.equal(perRun.length, 2);
  assert.deepEqual(perRun[0], { t: '2026-11-23T18:00:00Z', low: 80, high: 90, ciLo: null, ciHi: null, mid: 85, n: 1 });
  assert.deepEqual(perRun[1].ciLo, 78);
  const perDay = historySeries(rows, '30d', 'broad', now);
  assert.equal(perDay.length, 1, 'October is outside the window');
  assert.deepEqual([perDay[0].t, perDay[0].low, perDay[0].high, perDay[0].mid, perDay[0].n, perDay[0].ciLo, perDay[0].ciHi], ['2026-11-23', 81, 91, 86, 2, 78, 95]);
  const strict = historySeries(rows, '24h', 'strict', now);
  assert.equal(strict.length, 1, 'only the run with stats has a strict range');
  assert.deepEqual([strict[0].low, strict[0].high, strict[0].ciLo], [60, 70, 55]);
  assert.equal(windowSum(rows, 'rows_total', 1, now), 400);
});

test('staleness: null under two hours, an age beyond it; the deck banner renders only then', async () => {
  const { STALE_AFTER_MS, staleness } = await import('../site/metrics.js');
  const { staleBanner } = await import('../site/deck.js');
  const now = Date.parse('2026-11-24T03:00:00Z');
  assert.equal(STALE_AFTER_MS, 7200e3);
  assert.equal(staleness({ finishedAt: '2026-11-24T01:30:00Z' }, now), null, '90 minutes: fresh');
  assert.equal(staleness({ finishedAt: '2026-11-24T01:00:00Z' }, now), null, 'exactly two hours: not yet stale');
  assert.deepEqual(staleness({ finishedAt: '2026-11-24T00:59:00Z' }, now), { ageMs: 121 * 60000, ageMinutes: 121, finishedAt: '2026-11-24T00:59:00Z' });
  assert.equal(staleness(null, now), null);
  assert.equal(staleness({ finishedAt: 'garbage' }, now), null);
  assert.equal(staleBanner({ finishedAt: '2026-11-24T01:30:00Z' }, now), '');
  const b = staleBanner({ finishedAt: '2026-11-23T20:10:00Z' }, now);
  assert.ok(b.includes('data-stale-banner') && b.includes('LEDGER STALE · LAST RUN FINISHED 7H AGO') && b.includes('15:10 ET'));
});
