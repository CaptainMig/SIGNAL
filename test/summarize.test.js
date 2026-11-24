import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyRecord, statsRecord, summarizeRun } from '../pipeline/summarize.js';
import { HISTORY_COLUMNS, STATS_COLUMNS } from '../pipeline/ledger.js';

const usage = { input: 100, output: 40, cacheRead: 800, cacheWrite: 0 };
const sweep = (verdict, extra = {}) => ({ mode: 'sweep', verdict, fidelity: 8, sens: 2, click: 2, usage, ...extra });
const esc = (reason, sweepVerdict, outcome, extra = {}) => ({ eligible: true, reason, sweepVerdict, outcome, unresolved: false, attempts: 0, ...extra });
const none = { eligible: false, reason: null, sweepVerdict: null, outcome: null, unresolved: false, attempts: 0 };
const fin = (verdict, source, f = 8, s = 2, c = 2) => ({ verdict, fidelity: f, sens: s, click: c, source });

function rows() {
  return [
    { outlet: 'A', publication: 'A', thinBody: false, slam: { matched: true }, sweep: sweep('VERIFIED'), final: fin('VERIFIED', 'sweep'), escalation: none },
    { outlet: 'A', publication: 'A', thinBody: false, slam: { matched: false }, sweep: sweep('PROVISIONAL'), fulltext: { mode: 'fulltext', verdict: 'MISLEADING', fidelity: 1, sens: 8, click: 6, usage }, final: fin('MISLEADING', 'fulltext', 1, 8, 6), escalation: esc('provisional', 'PROVISIONAL', 'confirmed') },
    { outlet: 'B', publication: 'B', thinBody: false, slam: { matched: false }, sweep: sweep('CONTESTED'), fulltextError: { reason: 'blocked', detail: 'HTTP 403', attempts: 1 }, final: fin('CONTESTED', 'sweep'), escalation: esc('contested', 'CONTESTED', 'pending', { attempts: 1 }) },
    { outlet: 'C', publication: 'C', thinBody: true, slam: { matched: false }, sweep: { mode: 'tone', verdict: null, fidelity: null, sens: 4, click: 4, usage }, final: fin(null, 'tone', null, 4, 4), escalation: none },
    { outlet: 'A', publication: 'A', thinBody: false, slam: { matched: false }, sweep: null, sweepError: { reason: 'timeout' }, final: { source: 'unscored', verdict: null }, escalation: none },
    { outlet: 'A', publication: 'A', thinBody: false, slam: { matched: false }, sweep: sweep('CONTEXTUAL', { usage: null, carriedFrom: 'r0' }), final: fin('CONTEXTUAL', 'sweep'), escalation: none },
    { outlet: 'B', publication: 'B', thinBody: false, slam: { matched: false }, sweep: sweep('CONTEXTUAL', { fidelity: 5 }), fulltext: { mode: 'fulltext', verdict: 'VERIFIED', fidelity: 9, sens: 1, click: 1, usage }, final: fin('VERIFIED', 'fulltext', 9, 1, 1), escalation: esc('low_fidelity_contextual', 'CONTEXTUAL', 'cleared') },
    { outlet: 'B', publication: 'B', thinBody: false, slam: { matched: false }, sweep: sweep('VERIFIED'), audit: true, auditOutcome: { scored: true, changed: true, overturned: true }, fulltext: { mode: 'fulltext', verdict: 'CONTESTED', fidelity: 6, sens: 3, click: 2, usage }, final: fin('CONTESTED', 'fulltext', 6, 3, 2), escalation: none },
    { outlet: 'B', publication: 'B', thinBody: false, slam: { matched: false }, sweep: sweep('CONTESTED'), fulltextError: { reason: 'timeout', detail: 'timeout', attempts: 4 }, final: fin('CONTESTED', 'sweep'), escalation: esc('contested', 'CONTESTED', 'unresolved', { unresolved: true, attempts: 4 }) },
  ];
}
const feeds = [{ status: 'live' }, { status: 'live' }, { status: 'stale' }, { status: 'dead' }, { status: 'blocked' }];
const golden = {
  calls: 2,
  usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0 },
  comparison: { n: 50, scored: 50, baseline: { runId: 'r0', model: 'm', promptHash: 'p', sameModel: true, samePrompt: true, n: 50, agree: 48, agreementPct: 96, fidelityDrift: 0.1, sensDrift: -0.2, clickDrift: 0, changed: [{}, {}] }, expected: { agreementPct: 90 }, alert: false, alertBelowPct: 90 },
};
const extraction = { attempts: 4, successes: 3, byOutlet: { A: { attempts: 1, successes: 1 }, B: { attempts: 3, successes: 2 } } };

test('summarizeRun: rows, verdicts, both FI definitions, matrix, audit, extraction, tokens, cost', () => {
  const s = summarizeRun({ rows: rows(), feeds, runId: '2026-11-23T18', extraction, golden, auditSampled: 1 });

  assert.deepEqual(s.feeds, { total: 5, live: 2, stale: 1, blocked: 1, dead: 1 });
  assert.deepEqual(s.rows, { total: 9, scored: 8, unscored: 1, fulltext: 3, feedSummary: 4, headlineOnly: 1, withText: 7 });
  assert.deepEqual(s.verdicts, { VERIFIED: 2, CONTEXTUAL: 1, CONTESTED: 3, UNVERIFIED: 0, PROVISIONAL: 0, MISLEADING: 1 });

  const fi = s.framingIntegrity;
  assert.deepEqual([fi.broad.n, fi.broad.good, fi.broad.low, fi.broad.high], [6, 3, 50, 50]);
  assert.deepEqual([fi.strict.n, fi.strict.good, fi.strict.low, fi.strict.high], [6, 2, 33.3, 33.3]);
  assert.equal(fi.unresolved, 1);
  assert.deepEqual([fi.v2Low, fi.v2High, fi.v2N, fi.provisionalPending], [50, 50, 6, 0], 'back-compatible broad fields');
  assert.equal(fi.v1, 50); // 8 scored rows; VERIFIED ×2, CONTEXTUAL ×1, tone-as-VERIFIED ×1 = 4 of 8
  assert.deepEqual(fi.broad.ci, { lo: 33.3, hi: 66.7, clusters: 2, iterations: 2000 });
  assert.equal(fi.broad.balanced.qualified, 0, 'no outlet reaches n ≥ 5 with text');
  assert.equal(fi.broad.balanced.value, null);
  assert.equal(fi.outletMinN, 5);
  assert.equal(s.coverage, 87.5);

  const e = s.escalation;
  assert.deepEqual([e.eligible, e.attempted, e.confirmed, e.cleared, e.reclassified, e.pending, e.unresolved], [4, 4, 1, 1, 0, 1, 1]);
  assert.deepEqual([e.blocked, e.timeout, e.error], [1, 1, 0]);
  assert.deepEqual(e.byReason, { provisional: 1, contested: 2, low_fidelity_contextual: 1 });
  assert.equal(e.bySweep.PROVISIONAL.confirmed, 1);
  assert.equal(e.bySweep.CONTESTED.pending, 1);
  assert.equal(e.bySweep.CONTESTED.unresolved, 1);
  assert.equal(e.bySweep.CONTEXTUAL.cleared, 1);
  assert.equal(e.matrix.PROVISIONAL.MISLEADING, 1);
  assert.equal(e.matrix.CONTESTED.pending, 1);
  assert.equal(e.matrix.CONTESTED.unresolved, 1);
  assert.equal(e.matrix.CONTEXTUAL.VERIFIED, 1);

  assert.deepEqual(s.audit, { sampledThisRun: 1, present: 1, fetched: 1, scored: 1, changed: 1, overturned: 1, overturnPct: 100, changedPct: 100 });
  assert.equal(s.extraction.successPct, 75);
  assert.equal(s.extraction.byOutlet.B.successPct, 66.7);
  assert.equal(s.slam.test.underpowered, true);
  assert.deepEqual(s.slam.flagged, 1);

  assert.equal(s.golden.agreementPct, 96);
  assert.equal(s.golden.alert, false);
  assert.equal(s.golden.costUsd, 0.0003);
  // 10 row calls + 2 golden calls; row usage 1000/400/8000 plus golden 50/20.
  assert.deepEqual(s.usage, { input: 1050, output: 420, cacheRead: 8000, cacheWrite: 0, calls: 12 });
  assert.equal(s.costUsd, (1050 * 2 + 420 * 10 + 8000 * 0.1) / 1e6);
});

test('history and stats records fill every frozen column, matrix cells included', () => {
  const s = summarizeRun({ rows: rows(), feeds, runId: 'r', extraction, golden, auditSampled: 1 });
  const run = { id: 'r', startedAt: 'a', finishedAt: 'b', durationMs: 1, methodology: 'v2', model: 'm', promptHashes: { sweep: 's', fulltext: 'f', tone: 't' }, summary: s };
  const h = historyRecord(run);
  for (const c of HISTORY_COLUMNS) assert.ok(c in h, `history missing ${c}`);
  assert.equal(h.esc_provisional_to_misleading, 1);
  assert.equal(h.esc_contested_to_contested, 0);
  assert.equal(h.audit_sampled, 1);
  assert.equal(h.audit_overturn_pct, 100);
  assert.equal(h.fi_v2_outlets_qualified, 0);
  assert.equal(h.fi_v2_outlet_min_n, 5);
  const st = statsRecord(run);
  for (const c of STATS_COLUMNS) assert.ok(c in st, `stats missing ${c}`);
  assert.equal(st.fi_strict_low, 33.3);
  assert.equal(st.fi_broad_low, 50);
  assert.equal(st.fi_broad_ci_low, 33.3);
  assert.equal(st.esc_unresolved, 1);
  assert.equal(st.esc_contextual_eligible, 1);
  assert.equal(st.esc_contextual_to_verified, 1);
  assert.equal(st.slam_p, null);
  assert.equal(st.golden_agreement_pct, 96);
  assert.equal(st.golden_alert, 0);
  assert.equal(st.extract_success_pct, 75);
  const empty = summarizeRun({ rows: [], feeds: [] });
  assert.equal(empty.golden, null);
  assert.equal(historyRecord({ ...run, summary: empty }).fi_v2_low, null);
  assert.equal(statsRecord({ ...run, summary: empty }).golden_alert, null);
});

test('the run summary is identical when the rows arrive in a different order', () => {
  const a = summarizeRun({ rows: rows(), feeds, runId: 'r', extraction, golden, auditSampled: 1 });
  const b = summarizeRun({ rows: rows().reverse(), feeds, runId: 'r', extraction, golden, auditSampled: 1 });
  assert.deepEqual(b.framingIntegrity.broad.ci, a.framingIntegrity.broad.ci);
  assert.deepEqual(b.framingIntegrity.strict.ci, a.framingIntegrity.strict.ci);
  assert.deepEqual(b.slam.test, a.slam.test);
  assert.deepEqual(b, a);
});
