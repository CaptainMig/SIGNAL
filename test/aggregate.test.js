import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAggregate } from '../pipeline/aggregate.js';

const row = (id, verdict, fidelity, source = 'sweep') => ({ id, final: { verdict, fidelity, sens: 2, click: 2, source } });

test('aggregate dedupes rows across runs (latest wins) and keeps the v1 contract shape', () => {
  const runs = [
    { id: 'r2', startedAt: '2026-11-23T11:00:00Z', finishedAt: '2026-11-23T11:02:00Z', rows: [row('a', 'VERIFIED', 10), row('t', null, null, 'tone')] },
    { id: 'r1', startedAt: '2026-11-23T10:00:00Z', finishedAt: '2026-11-23T10:02:00Z', rows: [row('a', 'MISLEADING', 0, 'fulltext'), row('b', 'VERIFIED', 7), { id: 'u', final: { source: 'unscored' } }] },
  ];
  const agg = computeAggregate(runs, { now: Date.parse('2026-11-23T11:05:00Z') });
  assert.equal(agg.asOf, '2026-11-23T11:02:00Z');
  assert.equal(agg.windowHours, 24);
  assert.equal(agg.total, 4);
  assert.equal(agg.scored, 2, 'rows with article text only');
  assert.equal(agg.scoredAny, 3);
  // a (latest): fidelity 10 → v1 (10+8+8)/30 = 87 ; b: (7+8+8)/30 = 77
  assert.equal(agg.meanIntegrity, 82);
  assert.equal(agg.medianIntegrity, 82);
  assert.equal(agg.meanIntegrityV2, 76.5); // v2(10,2,2)=90, v2(7,2,2)=63
  assert.equal(agg.runs, 2);
  assert.equal(agg.source, 'ledger');
});

test('an empty ledger yields the honest empty snapshot', () => {
  const agg = computeAggregate([]);
  assert.equal(agg.asOf, null);
  assert.equal(agg.scored, 0);
  assert.equal(agg.meanIntegrity, null);
});
