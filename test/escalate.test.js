import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditResult, auditSampleSize, emptyMatrix, escalationOutcome, escalationReason, needsEscalation, pickAuditRows, OUTCOMES } from '../pipeline/escalate.js';

test('escalation reasons: PROVISIONAL, CONTESTED, CONTEXTUAL at fidelity ≤ 6', () => {
  assert.equal(escalationReason({ verdict: 'PROVISIONAL', fidelity: 3 }), 'provisional');
  assert.equal(escalationReason({ verdict: 'CONTESTED', fidelity: 8 }), 'contested');
  assert.equal(escalationReason({ verdict: 'CONTEXTUAL', fidelity: 6 }), 'low_fidelity_contextual');
  assert.equal(escalationReason({ verdict: 'CONTEXTUAL', fidelity: 7 }), null);
  assert.equal(escalationReason({ verdict: 'VERIFIED', fidelity: 2 }), null);
  assert.equal(escalationReason({ verdict: 'UNVERIFIED', fidelity: 2 }), null);
  assert.equal(escalationReason({ verdict: null, fidelity: null }), null, 'tone rows never escalate');
  assert.equal(needsEscalation(null), false);
});

test('outcome labels keep the full verdict: cleared means VERIFIED or CONTEXTUAL only', () => {
  assert.equal(escalationOutcome('PROVISIONAL', 'MISLEADING'), 'confirmed');
  assert.equal(escalationOutcome('PROVISIONAL', 'VERIFIED'), 'cleared');
  assert.equal(escalationOutcome('PROVISIONAL', 'CONTEXTUAL'), 'cleared');
  assert.equal(escalationOutcome('PROVISIONAL', 'CONTESTED'), 'reclassified');
  assert.equal(escalationOutcome('PROVISIONAL', 'UNVERIFIED'), 'reclassified');
  assert.equal(escalationOutcome('CONTESTED', 'CONTESTED'), 'confirmed');
  assert.equal(escalationOutcome('CONTESTED', 'MISLEADING'), 'reclassified');
  assert.equal(escalationOutcome('CONTESTED', 'VERIFIED'), 'cleared');
  assert.equal(escalationOutcome('CONTEXTUAL', 'CONTEXTUAL'), 'confirmed');
  assert.equal(escalationOutcome('CONTEXTUAL', 'VERIFIED'), 'cleared');
  assert.equal(escalationOutcome('CONTEXTUAL', 'MISLEADING'), 'reclassified');
  assert.equal(escalationOutcome('PROVISIONAL', null), 'pending');
  assert.equal(escalationOutcome('PROVISIONAL', null, { pending: false }), 'unresolved');
  assert.deepEqual(OUTCOMES, ['confirmed', 'cleared', 'reclassified', 'pending', 'unresolved']);
});

test('the matrix has every sweep flag × every model verdict plus pending and unresolved', () => {
  const m = emptyMatrix();
  assert.deepEqual(Object.keys(m), ['PROVISIONAL', 'CONTESTED', 'CONTEXTUAL']);
  assert.deepEqual(Object.keys(m.PROVISIONAL), ['VERIFIED', 'CONTEXTUAL', 'CONTESTED', 'UNVERIFIED', 'MISLEADING', 'pending', 'unresolved']);
});

test('audit sample size: 10 per run for the first 14 days, then 5', () => {
  assert.equal(auditSampleSize('2026-11-25T10:00:00Z'), 10);
  assert.equal(auditSampleSize('2026-12-07T23:00:00Z'), 10);
  assert.equal(auditSampleSize('2026-12-08T00:00:00Z'), 5);
  assert.equal(auditSampleSize('2027-03-01T00:00:00Z'), 5);
  assert.equal(auditSampleSize('garbage'), 5);
});

function candidates() {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ id: `v${i}`, sweep: { verdict: 'VERIFIED', mode: 'sweep' }, escalation: { eligible: false } });
  for (let i = 0; i < 10; i++) rows.push({ id: `c${i}`, sweep: { verdict: 'CONTEXTUAL', mode: 'sweep' }, escalation: { eligible: false } });
  rows.push({ id: 'tone', sweep: { verdict: null, mode: 'tone' }, escalation: { eligible: false } });
  rows.push({ id: 'hasft', sweep: { verdict: 'VERIFIED', mode: 'sweep' }, fulltext: { verdict: 'VERIFIED' }, escalation: { eligible: false } });
  rows.push({ id: 'audited', sweep: { verdict: 'VERIFIED', mode: 'sweep' }, audit: true, escalation: { eligible: false } });
  rows.push({ id: 'flagged', sweep: { verdict: 'CONTEXTUAL', mode: 'sweep', fidelity: 4 }, escalation: { eligible: true } });
  rows.push({ id: 'failed', sweep: { verdict: 'VERIFIED', mode: 'sweep' }, fulltextError: { reason: 'timeout' }, escalation: { eligible: false } });
  return rows;
}

test('audit sample is seeded, stratified half VERIFIED / half CONTEXTUAL, and skips ineligible rows', () => {
  const rows = candidates();
  const a = pickAuditRows(rows, { runId: '2026-11-25T10', size: 10 });
  assert.equal(a.length, 10);
  assert.equal(a.filter((id) => id.startsWith('v')).length, 5);
  assert.equal(a.filter((id) => id.startsWith('c')).length, 5);
  for (const bad of ['tone', 'hasft', 'audited', 'flagged', 'failed']) assert.ok(!a.includes(bad), `${bad} must not be sampled`);
  assert.deepEqual(pickAuditRows(rows, { runId: '2026-11-25T10', size: 10 }), a, 'same run id → same sample');
  assert.notDeepEqual(pickAuditRows(rows, { runId: '2026-11-25T11', size: 10 }), a, 'different run id → different sample');
  const five = pickAuditRows(rows, { runId: 'x', size: 5 });
  assert.equal(five.filter((id) => id.startsWith('v')).length, 3);
  assert.equal(five.filter((id) => id.startsWith('c')).length, 2);
  assert.deepEqual(pickAuditRows(rows, { runId: 'x', size: 0 }), []);
  // Short strata: take what exists, never pad from the other stratum.
  const few = pickAuditRows(rows.filter((r) => !r.id.startsWith('c')), { runId: 'x', size: 10 });
  assert.equal(few.length, 5);
});

test('audit result: overturned when the full text leaves the integrity set; changed when the verdict differs', () => {
  assert.deepEqual(auditResult('VERIFIED', 'VERIFIED'), { scored: true, changed: false, overturned: false });
  assert.deepEqual(auditResult('VERIFIED', 'CONTEXTUAL'), { scored: true, changed: true, overturned: false });
  assert.deepEqual(auditResult('CONTEXTUAL', 'MISLEADING'), { scored: true, changed: true, overturned: true });
  assert.deepEqual(auditResult('CONTEXTUAL', 'UNVERIFIED'), { scored: true, changed: true, overturned: true });
  assert.deepEqual(auditResult('VERIFIED', null), { scored: false, changed: null, overturned: null });
});
