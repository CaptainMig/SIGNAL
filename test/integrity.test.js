import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  articleIntegrityV1,
  articleIntegrityV2,
  coverage,
  countsForFI,
  framingIntegrity,
  framingIntegrityBroad,
  framingIntegrityStrict,
  framingIntegrityV1,
  framingIntegrityV2,
  groupByOutlet,
  meanOf,
  medianOf,
  outletBalanced,
  outletBalancedV2,
} from '../pipeline/integrity.js';

const row = (verdict, source = 'sweep', outlet = 'P', extra = {}) => ({
  outlet,
  publication: outlet,
  thinBody: source === 'tone',
  final: { verdict, fidelity: source === 'tone' ? null : 8, sens: 2, click: 2, source },
  escalation: { eligible: false, unresolved: false },
  ...extra,
});
const unresolvedRow = (verdict, outlet = 'P') => row(verdict, 'sweep', outlet, { escalation: { eligible: true, unresolved: true, outcome: 'unresolved' } });

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

const SAMPLE = [
  row('VERIFIED'), row('CONTEXTUAL'), row('CONTESTED'), row('PROVISIONAL'),
  row('MISLEADING', 'fulltext'), row(null, 'tone'), { final: { source: 'unscored', verdict: null } },
  unresolvedRow('CONTESTED'),
];

test('Framing Integrity broad: text rows minus unresolved; PROVISIONAL widens the range', () => {
  assert.deepEqual(framingIntegrityBroad(SAMPLE), { definition: 'broad', n: 5, good: 2, provisional: 1, unresolved: 1, low: 40, high: 60, point: 50 });
  assert.deepEqual(framingIntegrityV2(SAMPLE), framingIntegrityBroad(SAMPLE), 'v2 alias is broad');
  assert.equal(SAMPLE.filter(countsForFI).length, 5);
});

test('Framing Integrity strict: VERIFIED only, same population, same range mechanics', () => {
  assert.deepEqual(framingIntegrityStrict(SAMPLE), { definition: 'strict', n: 5, good: 1, provisional: 1, unresolved: 1, low: 20, high: 40, point: 30 });
  assert.throws(() => framingIntegrity(SAMPLE, 'lenient'), /unknown definition/);
});

test('an UNRESOLVED row is excluded from both definitions and counted beside them', () => {
  const withIt = framingIntegrityBroad(SAMPLE);
  const without = framingIntegrityBroad(SAMPLE.filter((r) => !r.escalation?.unresolved));
  assert.equal(withIt.n, without.n);
  assert.equal(withIt.low, without.low);
  assert.equal(withIt.unresolved, 1);
  assert.equal(without.unresolved, 0);
});

test('Framing Integrity v1-compatible counts thin rows as VERIFIED (the old default)', () => {
  const rows = [row('VERIFIED'), row('MISLEADING', 'fulltext'), row(null, 'tone'), row(null, 'tone')];
  assert.deepEqual(framingIntegrityV1(rows), { n: 4, good: 3, value: 75 });
  assert.equal(framingIntegrityBroad(rows).low, 50);
});

test('empty inputs yield nulls, never zeros dressed as scores', () => {
  assert.deepEqual(framingIntegrityBroad([]), { definition: 'broad', n: 0, good: 0, provisional: 0, unresolved: 0, low: null, high: null, point: null });
  assert.deepEqual(framingIntegrityV1([]), { n: 0, good: 0, value: null });
  assert.equal(coverage([]).value, null);
  assert.equal(outletBalanced([]).value, null);
  assert.deepEqual(outletBalancedV2([]), { outlets: 0, value: null });
});

test('outlet-balanced mean: per-outlet midpoints, only outlets with n ≥ minN, qualified count reported', () => {
  const rows = [
    ...Array.from({ length: 9 }, () => row('VERIFIED', 'sweep', 'Big')),
    row('MISLEADING', 'fulltext', 'Big'),
    row('MISLEADING', 'fulltext', 'Small'),
    row(null, 'tone', 'ToneOnly'),
  ];
  const b = outletBalanced(rows, 'broad');
  assert.equal(b.minN, 5);
  assert.equal(b.outlets, 2, 'tone-only outlets have no FI rows');
  assert.equal(b.qualified, 1, 'Small has one row and does not qualify');
  assert.equal(b.value, 90);
  assert.deepEqual(b.perOutlet.find((o) => o.outlet === 'Small'), { outlet: 'Small', n: 1, point: 0, low: 0, high: 0, qualified: false });
  assert.equal(outletBalanced(rows, 'broad', { minN: 1 }).value, 45, '(90 + 0) / 2 when every outlet counts');
  assert.deepEqual(outletBalancedV2(rows), { outlets: 1, value: 90 });
  assert.equal(framingIntegrityBroad(rows).low, 81.8, 'headline-weighted for comparison');
});

test('grouping uses the outlet key and falls back to the publication for old rows', () => {
  const g = groupByOutlet([{ outlet: 'Washington Post', publication: 'WaPo World' }, { outlet: 'Washington Post', publication: 'WaPo Politics' }, { publication: 'Legacy' }]);
  assert.deepEqual([...g.keys()], ['Washington Post', 'Legacy']);
  assert.equal(g.get('Washington Post').length, 2);
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
