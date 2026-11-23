import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayOf, summarizeDay, updateDaily } from '../pipeline/daily.js';

const row = (id, outlet, sens, click, verdict, pubDate, model = 'm1', promptHash = 'p1') => ({
  id,
  title: `Headline ${id}`,
  outlet,
  publication: outlet,
  pubDate,
  sweep: { mode: 'sweep', model, promptHash },
  final: { verdict, fidelity: 8, sens, click, source: 'sweep' },
  escalation: { eligible: false, unresolved: false },
});

test('dayOf uses the Eastern calendar day', () => {
  assert.equal(dayOf('2026-11-24T03:30:00Z'), '2026-11-23'); // 22:30 ET the day before
  assert.equal(dayOf('2026-11-24T12:00:00Z'), '2026-11-24');
  assert.equal(dayOf('garbage'), null);
});

test('summarizeDay: centroid, per-outlet centroids, grid with dominant verdict, scorer sets', () => {
  const rows = [
    row('a', 'A', 2, 2, 'VERIFIED', '2026-11-23T12:00:00Z'),
    row('b', 'A', 2, 2, 'CONTEXTUAL', '2026-11-23T12:00:00Z'),
    row('c', 'A', 2, 2, 'VERIFIED', '2026-11-23T12:00:00Z'),
    row('d', 'B', 8, 6, 'MISLEADING', '2026-11-23T12:00:00Z', 'm2', 'p2'),
    { id: 'e', outlet: 'B', publication: 'B', pubDate: '2026-11-23T12:00:00Z', final: { source: 'unscored' } },
  ];
  const d = summarizeDay('2026-11-23', rows);
  assert.deepEqual([d.n, d.sens, d.click, d.rows], [4, 3.5, 3, 5]);
  assert.deepEqual(d.outlets.A, { n: 3, sens: 2, click: 2 });
  assert.deepEqual(d.outlets.B, { n: 1, sens: 8, click: 6 });
  assert.equal(d.grid.length, 2);
  assert.deepEqual(d.grid[0], { sens: 2, click: 2, n: 3, verdicts: { VERIFIED: 2, CONTEXTUAL: 1 }, ids: ['a', 'b', 'c'], dominant: 'VERIFIED' });
  assert.deepEqual(d.models, ['m1', 'm2']);
  assert.deepEqual(d.promptHashes, ['p1', 'p2']);
  assert.deepEqual(d.scorer.sweep, { models: ['m1', 'm2'], prompts: ['p1', 'p2'] });
});

test('a scorer change is per mode: a day with full-text rows is not a change against a day without', async () => {
  const { scorerChangedBetween } = await import('../pipeline/daily.js');
  const sweepOnly = summarizeDay('d1', [row('a', 'A', 1, 1, 'VERIFIED', '2026-11-22T12:00:00Z', 'm1', 'p1')]);
  const withFulltext = summarizeDay('d2', [{ ...row('b', 'A', 1, 1, 'MISLEADING', '2026-11-23T12:00:00Z', 'm1', 'p1'), fulltext: { mode: 'fulltext', model: 'm1', promptHash: 'pf' } }]);
  assert.equal(scorerChangedBetween(sweepOnly, withFulltext), false, 'an extra mode is not a scorer change');
  const newPrompt = summarizeDay('d3', [row('c', 'A', 1, 1, 'VERIFIED', '2026-11-24T12:00:00Z', 'm1', 'p9')]);
  assert.equal(scorerChangedBetween(withFulltext, newPrompt), true, 'the sweep prompt changed');
  const newModel = summarizeDay('d4', [row('d', 'A', 1, 1, 'VERIFIED', '2026-11-25T12:00:00Z', 'm2', 'p9')]);
  assert.equal(scorerChangedBetween(newPrompt, newModel), true);
  assert.equal(scorerChangedBetween(null, newModel), false);
  // Legacy entries without per-mode sets fall back to the aggregate sets.
  assert.equal(scorerChangedBetween({ models: ['m0'], promptHashes: ['p0'] }, { models: ['m0'], promptHashes: ['p0'] }), false);
  assert.equal(scorerChangedBetween({ models: ['m0'], promptHashes: ['p0'] }, { models: ['m1'], promptHashes: ['p0'] }), true);
});

test('updateDaily recomputes the window days, keeps older days, trims, and marks scorer changes', () => {
  const previous = {
    days: [
      { day: '2026-10-01', n: 1, sens: 1, click: 1, rows: 1, outlets: {}, grid: [], models: ['m0'], promptHashes: ['p0'] },
      { day: '2026-11-20', n: 1, sens: 1, click: 1, rows: 1, outlets: {}, grid: [], models: ['m0'], promptHashes: ['p0'] },
      { day: '2026-11-23', n: 99, sens: 9, click: 9, rows: 99, outlets: {}, grid: [], models: ['m0'], promptHashes: ['p0'] },
    ],
  };
  const runs = [
    { id: 'r2', startedAt: '2026-11-23T18:00:00Z', rows: [row('x', 'A', 4, 4, 'VERIFIED', '2026-11-23T12:00:00Z', 'm1', 'p1')] },
    { id: 'r1', startedAt: '2026-11-22T18:00:00Z', rows: [row('x', 'A', 1, 1, 'VERIFIED', '2026-11-23T12:00:00Z', 'm1', 'p1'), row('y', 'A', 2, 3, 'VERIFIED', '2026-11-22T12:00:00Z', 'm1', 'p1')] },
  ];
  const now = Date.parse('2026-11-23T19:00:00Z');
  const out = updateDaily(previous, runs, { now });
  assert.deepEqual(out.days.map((d) => d.day), ['2026-11-20', '2026-11-22', '2026-11-23'], 'October trimmed, Nov 20 kept untouched, window days rebuilt');
  const d23 = out.days.find((d) => d.day === '2026-11-23');
  assert.deepEqual([d23.n, d23.sens, d23.click], [1, 4, 4], 'latest sighting of row x wins; the stale 99-row entry is replaced');
  assert.equal(out.days.find((d) => d.day === '2026-11-22').n, 1);
  assert.equal(out.days[0].scorerChanged, false);
  assert.equal(out.days[1].scorerChanged, true, 'm0/p0 → m1/p1 between Nov 20 and Nov 22');
  assert.equal(out.days[2].scorerChanged, false);
  assert.equal(out.keepDays, 35);
  const fresh = updateDaily(null, runs, { now });
  assert.equal(fresh.days.length, 2);
  assert.deepEqual(d23.titles, { x: { t: 'Headline x', o: 'A', v: 'VERIFIED' } }, 'recent days keep headline text per id');
  const stale = updateDaily({ days: [{ ...previous.days[1], titles: { z: { t: 'old', o: 'A', v: 'VERIFIED' } } }] }, runs, { now, titleDays: 1 });
  assert.equal(stale.days.find((d) => d.day === '2026-11-20').titles, undefined, 'titles age out beyond titleDays');
  // titleDays 1 from Nov 23 (ET) keeps Nov 22 and Nov 23.
  assert.ok(stale.days.find((d) => d.day === '2026-11-22').titles);
  assert.ok(stale.days.find((d) => d.day === '2026-11-23').titles);
});
