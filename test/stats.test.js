import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterBootstrap, permutationWithinOutlet, shrink, wilson } from '../pipeline/stats.js';
import { mulberry32, seedFrom } from '../pipeline/prng.js';

test('seeded PRNG is deterministic and seedFrom hashes structure', () => {
  const a = mulberry32(seedFrom('run', 1));
  const b = mulberry32(seedFrom('run', 1));
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(seedFrom('run', 1), seedFrom('run', 2));
  assert.notEqual(seedFrom([1, 2]), seedFrom([2, 1]));
  assert.equal(seedFrom('x', [true, null, 1.5]), seedFrom('x', [true, null, 1.5]));
});

test('Wilson interval: known value for 8 of 10, degenerate cases', () => {
  const w = wilson(8, 10);
  assert.deepEqual(w, { p: 80, lo: 49, hi: 94.3 });
  assert.deepEqual(wilson(0, 0), { p: null, lo: null, hi: null });
  assert.deepEqual(wilson(10, 10), { p: 100, lo: 72.2, hi: 100 });
  assert.equal(wilson(0, 10).lo, 0);
});

test('cluster bootstrap resamples outlets, is seeded, and brackets the point', () => {
  const groups = [[10, 12, 11], [30, 31, 29], [20, 21, 19, 20], [50, 52]];
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const a = clusterBootstrap(groups, mean, { seed: 7, iterations: 500 });
  const b = clusterBootstrap(groups, mean, { seed: 7, iterations: 500 });
  assert.deepEqual(a, b, 'same seed → same interval');
  assert.equal(a.clusters, 4);
  assert.equal(a.iterations, 500);
  assert.ok(a.lo <= a.point && a.point <= a.hi);
  assert.ok(a.lo >= 10 && a.hi <= 52);
  const one = clusterBootstrap([[1, 2, 3]], mean, { seed: 1 });
  assert.deepEqual(one, { point: 2, lo: null, hi: null, clusters: 1, iterations: 0 });
  assert.deepEqual(clusterBootstrap([], mean, { seed: 1 }).point, NaN);
});

// Unseeded shuffle on purpose: the routines under test must give identical
// output whatever order their input arrives in.
function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test('cluster bootstrap: identical output on shuffled input (groups and members), twice', () => {
  const groups = [
    [{ id: 'a1', v: 10 }, { id: 'a2', v: 12 }, { id: 'a3', v: 11 }],
    [{ id: 'b1', v: 30 }, { id: 'b2', v: 31 }],
    [{ id: 'c1', v: 20 }, { id: 'c2', v: 21 }, { id: 'c3', v: 19 }, { id: 'c4', v: 20 }],
    [{ id: 'd1', v: 50 }, { id: 'd2', v: 52 }],
    [{ id: 'e1', v: 5 }],
  ];
  const mean = (xs) => xs.reduce((a, r) => a + r.v, 0) / xs.length;
  const base = clusterBootstrap(groups, mean, { seed: 11, iterations: 300 });
  for (let k = 0; k < 2; k++) {
    const shuffled = shuffle(groups.map((g) => shuffle(g)));
    assert.deepEqual(clusterBootstrap(shuffled, mean, { seed: 11, iterations: 300 }), base, 'order of groups and of members must not change the interval');
  }
  assert.ok(base.lo != null && base.hi != null && base.lo <= base.point && base.point <= base.hi);
});

test('within-outlet permutation: identical output on shuffled rows, twice', () => {
  const rows = [];
  let id = 0;
  for (const outlet of ['X', 'Y', 'Z']) {
    for (let i = 0; i < 5; i++) rows.push({ id: `r${id++}`, outlet, flagged: true, value: 5 + (i % 3) });
    for (let i = 0; i < 7; i++) rows.push({ id: `r${id++}`, outlet, flagged: false, value: 2 + (i % 4) });
  }
  const base = permutationWithinOutlet(rows, { seed: 5, iterations: 400, bootstrapIterations: 150 });
  for (let k = 0; k < 2; k++) {
    assert.deepEqual(permutationWithinOutlet(shuffle(rows), { seed: 5, iterations: 400, bootstrapIterations: 150 }), base, 'row order must not change p or the interval');
  }
  assert.equal(base.underpowered, false);
});

test('beta-binomial shrinkage pulls toward the pooled rate by strength', () => {
  assert.equal(shrink(9, 10, 0.5, 20), 63.3); // (9 + 10) / 30
  assert.equal(shrink(9, 10, 0.5, 0), 90);
  assert.equal(shrink(90, 100, 0.5, 20), 83.3);
  assert.equal(shrink(9, 10, null), 90, 'no pooled rate → raw rate');
  assert.equal(shrink(0, 0, null), null);
});

test('within-outlet permutation: a real gap is significant; outlet tone alone is not', () => {
  const rows = [];
  for (const outlet of ['X', 'Y']) {
    for (let i = 0; i < 6; i++) rows.push({ outlet, flagged: true, value: 8 + (i % 2) });
    for (let i = 0; i < 8; i++) rows.push({ outlet, flagged: false, value: 1 + (i % 2) });
  }
  const real = permutationWithinOutlet(rows, { seed: 3, iterations: 999, bootstrapIterations: 200 });
  assert.equal(real.underpowered, false);
  assert.equal(real.nFlagged, 12);
  assert.equal(real.nRest, 16);
  assert.equal(real.observedDiff, 7);
  assert.ok(real.p < 0.01 && real.p > 0, 'p = (count + 1) / (iterations + 1) is never 0');
  assert.equal(real.label, 'consistency check');
  assert.ok(real.ci.lo <= 7 && 7 <= real.ci.hi);
  assert.deepEqual(permutationWithinOutlet(rows, { seed: 3, iterations: 999, bootstrapIterations: 200 }), real, 'seeded');

  // Flags concentrated in a hot outlet whose unflagged rows are just as hot:
  // the global gap is large, the within-outlet test says it is outlet tone.
  const hot = [];
  for (let i = 0; i < 5; i++) hot.push({ outlet: 'H', flagged: true, value: 8 });
  for (let i = 0; i < 5; i++) hot.push({ outlet: 'H', flagged: false, value: 8 });
  for (let i = 0; i < 10; i++) hot.push({ outlet: 'L', flagged: false, value: 1 });
  const tone = permutationWithinOutlet(hot, { seed: 3, iterations: 499, bootstrapIterations: 100 });
  assert.equal(tone.observedDiff, 4.7);
  assert.equal(tone.p, 1, 'every within-outlet permutation reproduces the gap');

  const few = permutationWithinOutlet(rows.slice(0, 8), { seed: 1 }); // 6 flagged, 2 rest
  assert.equal(few.underpowered, true);
  assert.equal(few.p, null);
});
