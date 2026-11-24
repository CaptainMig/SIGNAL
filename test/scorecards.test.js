import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScorecards, uniqueRows, SCORECARD_MIN_DAYS } from '../pipeline/scorecards.js';

let n = 0;
const row = (outlet, verdict, day, { source = 'sweep', id } = {}) => ({
  id: id || `${outlet}-${n++}`,
  outlet,
  publication: outlet,
  owner: `${outlet} Owner`,
  pubDate: `${day}T12:00:00.000Z`,
  thinBody: source === 'tone',
  final: { verdict, fidelity: source === 'tone' ? null : 8, sens: 2, click: 3, source },
  escalation: { eligible: false, unresolved: false },
});

function runs() {
  const days = ['2026-11-21', '2026-11-22', '2026-11-23'];
  const rows = [];
  // A: 25 text rows over 3 days, 20 VERIFIED, 3 CONTEXTUAL, 2 MISLEADING → ranked.
  for (let i = 0; i < 25; i++) rows.push(row('A', i < 20 ? 'VERIFIED' : i < 23 ? 'CONTEXTUAL' : 'MISLEADING', days[i % 3], { source: i >= 23 ? 'fulltext' : 'sweep' }));
  // B: 12 rows over 2 days → short on both counts.
  for (let i = 0; i < 12; i++) rows.push(row('B', 'VERIFIED', days[i % 2]));
  // C: 25 rows on one day → enough rows, too few days.
  for (let i = 0; i < 25; i++) rows.push(row('C', 'VERIFIED', days[0]));
  // T: tone only.
  for (let i = 0; i < 10; i++) rows.push(row('T', null, days[i % 3], { source: 'tone' }));
  return [
    { id: 'r3', startedAt: '2026-11-23T12:00:00Z', rows: rows.filter((r) => r.pubDate.startsWith(days[2])) },
    { id: 'r2', startedAt: '2026-11-22T12:00:00Z', rows: rows.filter((r) => r.pubDate.startsWith(days[1])) },
    { id: 'r1', startedAt: '2026-11-21T12:00:00Z', rows: rows.filter((r) => r.pubDate.startsWith(days[0])) },
  ];
}

test('uniqueRows keeps the latest sighting of each id', () => {
  const rs = [
    { id: 'new', startedAt: 'b', rows: [{ id: 'x', final: { verdict: 'MISLEADING' } }] },
    { id: 'old', startedAt: 'a', rows: [{ id: 'x', final: { verdict: 'VERIFIED' } }, { id: 'y', final: { verdict: 'VERIFIED' } }] },
  ];
  const u = uniqueRows(rs);
  assert.equal(u.length, 2);
  assert.equal(u.find((r) => r.id === 'x').final.verdict, 'MISLEADING');
  assert.equal(u.find((r) => r.id === 'x').runId, 'new');
});

test('ranking needs n ≥ 20 with text AND ≥ 3 observation days; below that, progress is shown', () => {
  const sc = buildScorecards(runs());
  assert.equal(sc.minN, 20);
  assert.equal(sc.minDays, SCORECARD_MIN_DAYS);
  assert.equal(sc.ranked, 1);
  const by = Object.fromEntries(sc.cards.map((c) => [c.outlet, c]));
  assert.equal(by.A.ranked, true);
  assert.equal(by.A.progress, null);
  assert.equal(by.A.days, 3);
  assert.equal(by.B.ranked, false);
  assert.equal(by.B.progress, '12 of 20 · 2 of 3 days');
  assert.equal(by.C.ranked, false);
  assert.equal(by.C.progress, '20 of 20 · 1 of 3 days');
  assert.equal(by.T.toneOnly, true);
  assert.equal(by.T.progress, '0 of 20 · 3 of 3 days');
  assert.equal(sc.cards[0].outlet, 'A', 'ranked outlets first');
});

test('ranked cards carry raw range, Wilson bounds and shrunk rates for both definitions', () => {
  const sc = buildScorecards(runs());
  const a = sc.cards.find((c) => c.outlet === 'A');
  assert.equal(a.nText, 25);
  assert.equal(a.broad.low, 92);
  assert.equal(a.broad.high, 92);
  assert.equal(a.strict.low, 80);
  assert.equal(a.broad.wilsonLow.p, 92);
  assert.ok(a.broad.wilsonLow.lo < 92 && a.broad.wilsonLow.hi > 92);
  // Pooled broad rate over every FI row: A 23/25, B 12/12, C 25/25 → 60/62.
  assert.equal(sc.pooled.broad.n, 62);
  assert.equal(sc.pooled.broad.low, 96.8);
  // Shrinkage toward the pooled rate with strength 20: (23 + 20 × 0.968) / 45.
  assert.equal(a.broad.shrunkLow, 94.1);
  assert.equal(a.strict.shrunkLow, 85.3); // (20 + 20 × 0.919) / 45, pooled strict = 57/62
  assert.equal(a.sens, 2);
});

test('ranking days are the distinct ET days Signal scanned the outlet, not publication dates (DEFECTS.md v2-41)', () => {
  // 25 text rows with publication dates on three different days, all observed in ONE run: one scan day, not ranked.
  const days = ['2026-11-21', '2026-11-22', '2026-11-23'];
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(row('X', 'VERIFIED', days[i % 3]));
  const one = buildScorecards([{ id: 'r', startedAt: '2026-11-23T12:00:00Z', rows }]);
  const x = one.cards.find((c) => c.outlet === 'X');
  assert.deepEqual([x.nText, x.days, x.ranked, x.progress], [25, 1, false, '20 of 20 · 1 of 3 days']);
  // The same rows seen across three runs on three ET days: ranked.
  const three = buildScorecards([
    { id: 'r3', startedAt: '2026-11-23T12:00:00Z', rows },
    { id: 'r2', startedAt: '2026-11-22T12:00:00Z', rows },
    { id: 'r1', startedAt: '2026-11-21T12:00:00Z', rows },
  ]);
  assert.deepEqual([three.cards[0].days, three.cards[0].ranked], [3, true]);
  // Two runs on the same ET day (04:00Z and 23:00Z on Nov 23 are 23:00 ET Nov 22 and 18:00 ET Nov 23): two days.
  const sameUtcDay = buildScorecards([
    { id: 'a', startedAt: '2026-11-23T04:00:00Z', rows },
    { id: 'b', startedAt: '2026-11-23T23:00:00Z', rows },
  ]);
  assert.equal(sameUtcDay.cards[0].days, 2);
});
