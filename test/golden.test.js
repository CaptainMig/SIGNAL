import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareGolden, readBaseline, readGoldenSet, scoreGoldenSet, writeBaselineIfAbsent } from '../pipeline/golden.js';
import { MODEL_VERDICTS } from '../pipeline/verdicts.js';

test('the frozen set has 50 unique, well-formed synthetic items', async () => {
  const set = await readGoldenSet({ root: '.' });
  assert.equal(set.version, 1);
  assert.equal(set.items.length, 50);
  assert.equal(new Set(set.items.map((i) => i.id)).size, 50);
  for (const it of set.items) {
    assert.ok(MODEL_VERDICTS.includes(it.expected), `${it.id} expected verdict`);
    assert.ok(it.headline.length >= 15, `${it.id} headline`);
    assert.ok(it.article.length >= 150, `${it.id} article`);
  }
  const byExpected = {};
  for (const it of set.items) byExpected[it.expected] = (byExpected[it.expected] || 0) + 1;
  assert.deepEqual(byExpected, { VERIFIED: 18, CONTEXTUAL: 10, CONTESTED: 8, UNVERIFIED: 7, MISLEADING: 7 });
});

test('scoring the set keeps only compact results, never the article text', async () => {
  const set = { version: 1, items: [{ id: 'a', expected: 'VERIFIED', headline: 'H1', article: 'A1 text' }, { id: 'b', expected: 'MISLEADING', headline: 'H2', article: 'A2 text' }] };
  const scorer = {
    model: 'm',
    promptHashes: { fulltext: 'ph' },
    scoreAll: async (items) => items.map((it, i) => (i === 0 ? { ok: true, score: { verdict: 'VERIFIED', fidelity: 9, sens: 1, click: 1 }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } : { ok: false, reason: 'timeout', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  };
  const out = await scoreGoldenSet(scorer, set);
  assert.equal(out.calls, 2);
  assert.deepEqual(out.usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(out.results[0], { id: 'a', expected: 'VERIFIED', ok: true, verdict: 'VERIFIED', fidelity: 9, sens: 1, click: 1, reason: undefined });
  assert.equal(out.results[1].ok, false);
  assert.ok(!JSON.stringify(out).includes('A1 text'));
});

const res = (id, verdict, f, s, c, expected = verdict) => ({ id, expected, ok: true, verdict, fidelity: f, sens: s, click: c });

test('comparison: agreement, drift, alert, and authoring-intent agreement', () => {
  const current = { model: 'm', promptHash: 'p', results: [res('a', 'VERIFIED', 9, 1, 1), res('b', 'CONTEXTUAL', 7, 3, 2, 'VERIFIED'), res('c', 'MISLEADING', 2, 8, 6), { id: 'd', ok: false, reason: 'timeout' }] };
  const baseline = { runId: 'r0', model: 'm', promptHash: 'p', results: [res('a', 'VERIFIED', 8, 1, 1), res('b', 'VERIFIED', 8, 2, 2), res('c', 'MISLEADING', 2, 8, 6), res('d', 'VERIFIED', 9, 0, 0)] };
  const cmp = compareGolden(current, baseline);
  assert.equal(cmp.n, 4);
  assert.equal(cmp.scored, 3);
  assert.equal(cmp.baseline.n, 3);
  assert.equal(cmp.baseline.agree, 2);
  assert.equal(cmp.baseline.agreementPct, 66.7);
  assert.deepEqual(cmp.baseline.changed, [{ id: 'b', from: 'VERIFIED', to: 'CONTEXTUAL' }]);
  assert.equal(cmp.baseline.fidelityDrift, 0); // (+1, −1, 0) / 3
  assert.equal(cmp.baseline.sensDrift, 0.3);
  assert.equal(cmp.baseline.clickDrift, 0);
  assert.equal(cmp.baseline.sameModel, true);
  assert.equal(cmp.alert, true, '66.7% is below the 90% alert line');
  assert.equal(cmp.expected.agreementPct, 66.7);

  const same = compareGolden(current, { ...baseline, results: current.results });
  assert.equal(same.baseline.agreementPct, 100);
  assert.equal(same.alert, false);

  const none = compareGolden(current, null);
  assert.equal(none.baseline, null);
  assert.equal(none.alert, false);
  assert.equal(none.expected.agreementPct, 66.7);
});

test('the baseline is written once and never overwritten', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-golden-'));
  assert.equal(await readBaseline({ root }), null);
  assert.equal(await writeBaselineIfAbsent({ runId: 'r1', results: [] }, { root }), true);
  assert.equal(await writeBaselineIfAbsent({ runId: 'r2', results: [] }, { root }), false);
  assert.equal((await readBaseline({ root })).runId, 'r1');
});
