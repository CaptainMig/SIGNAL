import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cohenKappa, computeAgreement, drawValidationSet, perVerdictKappa, readReviewerLabels, refreshAgreement, validationPaths } from '../pipeline/validation.js';

let n = 0;
const row = (verdict, outlet = 'A', source = 'sweep') => ({ id: `r${n++}`, title: `Headline ${n} about something`, link: `https://x/${n}`, outlet, publication: outlet, pubDate: '2026-11-23T12:00:00Z', final: { verdict, fidelity: 7, sens: 2, click: 3, source }, escalation: { eligible: false, unresolved: false } });

function runs() {
  n = 0; // ids repeat across calls so seeded draws can be compared
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(row('VERIFIED'));
  for (let i = 0; i < 40; i++) rows.push(row('CONTEXTUAL', 'B'));
  for (let i = 0; i < 8; i++) rows.push(row('CONTESTED', 'C'));
  for (let i = 0; i < 12; i++) rows.push(row('UNVERIFIED'));
  for (let i = 0; i < 5; i++) rows.push(row('MISLEADING', 'A', 'fulltext'));
  for (let i = 0; i < 9; i++) rows.push(row('PROVISIONAL', 'B'));
  rows.push(row(null, 'T', 'tone'));
  rows.push({ ...row('CONTESTED'), escalation: { eligible: true, unresolved: true } });
  rows.push({ ...row(null), final: { source: 'unscored' } });
  return [{ id: 'r1', startedAt: '2026-11-23T18:00:00Z', rows }];
}

test('the draw is stratified, fills shortfalls, is seeded, and keeps scores out of the served set', () => {
  const { set, modelLabels, shortfall, strata } = drawValidationSet(runs(), { size: 100, seed: 's', version: 1, drawnAt: 't' });
  assert.equal(set.size, 100);
  assert.equal(shortfall, 0);
  const taken = Object.fromEntries(strata.map((s) => [s.stratum, s.taken]));
  // Targets of 20: CONTESTED (8), UNVERIFIED (12) and MISLEADING+PROVISIONAL (14)
  // are short, so the 26 missing fill round-robin from VERIFIED and CONTEXTUAL.
  assert.deepEqual(taken, { VERIFIED: 33, CONTEXTUAL: 33, CONTESTED: 8, UNVERIFIED: 12, 'MISLEADING+PROVISIONAL': 14 });
  assert.equal(new Set(set.items.map((i) => i.id)).size, 100);
  for (const it of set.items) {
    assert.deepEqual(Object.keys(it).sort(), ['evidence', 'headline', 'id', 'link', 'outlet', 'pubDate', 'publication']);
  }
  assert.ok(!JSON.stringify(set).includes('verdict'), 'no verdicts in the served set');
  assert.equal(Object.keys(modelLabels.items).length, 100);
  assert.equal(modelLabels.items[set.items[0].id].fidelity, 7);
  assert.deepEqual(drawValidationSet(runs(), { size: 100, seed: 's', version: 1, drawnAt: 't' }).set.items.map((i) => i.id), set.items.map((i) => i.id), 'seeded');
  assert.notDeepEqual(drawValidationSet(runs(), { size: 100, seed: 'other', version: 1, drawnAt: 't' }).set.items.map((i) => i.id), set.items.map((i) => i.id));
  const small = drawValidationSet([{ id: 'r', startedAt: 'x', rows: [row('VERIFIED'), row('VERIFIED')] }], { size: 100 });
  assert.equal(small.set.size, 2);
  assert.equal(small.shortfall, 98);
});

test("Cohen's kappa: known values, chance-corrected, per verdict one-vs-rest", () => {
  const a = ['V', 'V', 'C', 'C', 'M', 'V', 'C', 'M', 'V', 'C'];
  const b = ['V', 'C', 'C', 'C', 'M', 'V', 'V', 'M', 'V', 'C'];
  const k = cohenKappa(a, b, ['V', 'C', 'M']);
  assert.equal(k.n, 10);
  assert.equal(k.agreement, 80);
  // po = 0.8; pe = (4/10)(4/10) + (4/10)(4/10) + (2/10)(2/10) = 0.36 → κ = 0.44/0.64
  assert.equal(k.kappa, 0.688);
  assert.equal(cohenKappa(a, a, ['V', 'C', 'M']).kappa, 1);
  assert.equal(cohenKappa(['V', 'V'], ['V', 'V'], ['V']).kappa, 1, 'no variation, full agreement');
  assert.equal(cohenKappa([], [], ['V']).kappa, null);
  const pv = perVerdictKappa(a, b, ['V', 'C', 'M']);
  assert.equal(pv.M, 1);
  assert.ok(pv.V < 1 && pv.C < 1);
});

test('agreement report: completeness, model-vs-human, human-vs-human, validated only at two complete reviewers', () => {
  const { set, modelLabels } = drawValidationSet(runs(), { size: 10, seed: 's', version: 1, drawnAt: 't' });
  const ids = set.items.map((i) => i.id);
  const perfect = Object.fromEntries(ids.map((id) => [id, { ...modelLabels.items[id], at: 't' }]));
  const flipped = Object.fromEntries(ids.map((id, i) => [id, { verdict: i % 2 ? modelLabels.items[id].verdict : 'MISLEADING', fidelity: 3, sens: 5, click: 5 }]));
  const partial = Object.fromEntries(ids.slice(0, 4).map((id) => [id, { verdict: 'UNAVAILABLE' }]));

  const one = computeAgreement({ set, modelLabels, reviewers: [{ reviewer: 'ann', labels: perfect }], computedAt: 't' });
  assert.equal(one.validated, false);
  assert.equal(one.statement, 'Not yet validated against human reviewers.');
  assert.equal(one.modelVsHuman[0].overall.kappa, 1);
  assert.equal(one.modelVsHuman[0].axes.fidelity, 0);

  const two = computeAgreement({ set, modelLabels, reviewers: [{ reviewer: 'ann', labels: perfect }, { reviewer: 'bo', labels: flipped }, { reviewer: 'cy', labels: partial }], computedAt: 't' });
  assert.equal(two.complete, 2);
  assert.equal(two.validated, true);
  assert.equal(two.statement, 'Validated against 2 human reviewers.');
  assert.deepEqual(two.reviewers.map((r) => [r.reviewer, r.labelled, r.unavailable, r.complete]), [['ann', 10, 0, true], ['bo', 10, 0, true], ['cy', 4, 4, false]]);
  const bo = two.modelVsHuman.find((m) => m.reviewer === 'bo');
  assert.equal(bo.n, 10);
  assert.ok(bo.overall.kappa < 1);
  assert.equal(bo.axes.fidelity, 4);
  assert.equal(two.humanVsHuman.length, 3);
  const annBo = two.humanVsHuman.find((h) => h.a === 'ann' && h.b === 'bo');
  assert.equal(annBo.n, 10);
  const annCy = two.humanVsHuman.find((h) => h.a === 'ann' && h.b === 'cy');
  assert.equal(annCy.n, 0, 'UNAVAILABLE labels are not judgments');
});

test('labels files are read from the labels directory for the set version; agreement.json is refreshed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-validation-'));
  const p = validationPaths(root);
  assert.equal(await refreshAgreement({ root }), null, 'no set yet');
  const { set, modelLabels } = drawValidationSet(runs(), { size: 6, seed: 's', version: 1, drawnAt: 't' });
  await fs.mkdir(p.labels, { recursive: true });
  await fs.writeFile(p.set, JSON.stringify(set));
  await fs.writeFile(p.modelLabels(1), JSON.stringify(modelLabels));
  const labels = Object.fromEntries(set.items.map((i) => [i.id, modelLabels.items[i.id]]));
  await fs.writeFile(path.join(p.labels, 'labels-ann-v1.json'), JSON.stringify({ reviewer: 'ann', version: 1, labels }));
  await fs.writeFile(path.join(p.labels, 'labels-old-v0.json'), JSON.stringify({ reviewer: 'old', version: 0, labels }));
  await fs.writeFile(path.join(p.labels, 'broken.json'), '{not json');
  const files = await readReviewerLabels(1, { root });
  assert.deepEqual(files.map((f) => f.reviewer), ['ann']);
  const report = await refreshAgreement({ root });
  assert.equal(report.complete, 1);
  assert.equal(JSON.parse(await fs.readFile(p.agreement, 'utf8')).statement, 'Not yet validated against human reviewers.');
});
