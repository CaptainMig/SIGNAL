import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  articleIntegrityV1,
  articleIntegrityV2,
  coverage,
  framingIntegrityV1,
  framingIntegrityV2,
  meanOf,
  medianOf,
  outletBalancedV2,
} from '../pipeline/integrity.js';

const row = (verdict, source = 'sweep', publication = 'P', extra = {}) => ({
  publication,
  thinBody: source === 'tone',
  final: { verdict, fidelity: source === 'tone' ? null : 8, sens: 2, click: 2, source },
  ...extra,
});

test('per-article v1: no gating; thin rows use the old placeholder fidelity 5', () => {
  assert.equal(articleIntegrityV1({ fidelity: 10, sens: 0, click: 0 }), 100);
  assert.equal(articleIntegrityV1({ fidelity: 0, sens: 0, click: 0 }), 67, 'v1 rewards a calm headline that contradicts its article');
  assert.equal(articleIntegrityV1({ fidelity: 6, sens: 3, click: 3 }), 67);
  assert.equal(articleIntegrityV1({ fidelity: null, sens: 2, click: 2 }, { thinBody: true }), 70);
  assert.equal(articleIntegrityV1({ fidelity: null, sens: 2, click: 2 }), null);
  assert.equal(articleIntegrityV1(null), null);
});

test('per-article v2: 100 × F/10 × (1 − 0.25·S/10 − 0.25·C/10); fidelity gates', () => {
  assert.equal(articleIntegrityV2({ fidelity: 10, sens: 0, click: 0 }), 100);
  assert.equal(articleIntegrityV2({ fidelity: 0, sens: 0, click: 0 }), 0);
  assert.equal(articleIntegrityV2({ fidelity: 10, sens: 10, click: 10 }), 50);
  assert.equal(articleIntegrityV2({ fidelity: 8, sens: 4, click: 2 }), 68);
  assert.equal(articleIntegrityV2({ fidelity: 7, sens: 3, click: 5 }), 56);
  assert.equal(articleIntegrityV2({ fidelity: null, sens: 2, click: 2 }), null);
});

test('Framing Integrity v2: text rows only; PROVISIONAL widens the range', () => {
  const rows = [
    row('VERIFIED'), row('CONTEXTUAL'), row('CONTESTED'), row('PROVISIONAL'),
    row('MISLEADING', 'fulltext'), row(null, 'tone'), { final: { source: 'unscored', verdict: null } },
  ];
  const fi = framingIntegrityV2(rows);
  assert.deepEqual(fi, { n: 5, good: 2, provisional: 1, low: 40, high: 60, point: 50 });
});

test('Framing Integrity v1-compatible counts thin rows as VERIFIED (the old default)', () => {
  const rows = [row('VERIFIED'), row('MISLEADING', 'fulltext'), row(null, 'tone'), row(null, 'tone')];
  assert.deepEqual(framingIntegrityV1(rows), { n: 4, good: 3, value: 75 });
  assert.equal(framingIntegrityV2(rows).low, 50);
});

test('empty inputs yield nulls, never zeros dressed as scores', () => {
  assert.deepEqual(framingIntegrityV2([]), { n: 0, good: 0, provisional: 0, low: null, high: null, point: null });
  assert.deepEqual(framingIntegrityV1([]), { n: 0, good: 0, value: null });
  assert.equal(coverage([]).value, null);
  assert.equal(outletBalancedV2([]).value, null);
});

test('outlet-balanced v2 is the mean of per-outlet rates, not headline-weighted', () => {
  const rows = [
    ...Array.from({ length: 9 }, () => row('VERIFIED', 'sweep', 'Big')),
    row('MISLEADING', 'fulltext', 'Big'),
    row('MISLEADING', 'fulltext', 'Small'),
    row(null, 'tone', 'ToneOnly'),
  ];
  assert.deepEqual(outletBalancedV2(rows), { outlets: 2, value: 45 }); // (90 + 0) / 2
  assert.equal(framingIntegrityV2(rows).low, 81.8);
});

test('coverage = rows with article text / scored rows', () => {
  const rows = [row('VERIFIED'), row('VERIFIED', 'fulltext'), row(null, 'tone'), row(null, 'tone'), { final: { source: 'unscored' } }];
  assert.deepEqual(coverage(rows), { n: 4, withText: 2, value: 50 });
});

test('meanOf / medianOf ignore nulls', () => {
  assert.equal(meanOf([1, null, 3]), 2);
  assert.equal(medianOf([5, 1, null, 3, 4]), 3.5);
  assert.equal(meanOf([]), null);
});
