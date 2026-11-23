import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyRecord, summarizeRun } from '../pipeline/summarize.js';
import { HISTORY_COLUMNS } from '../pipeline/ledger.js';

const usage = { input: 100, output: 40, cacheRead: 800, cacheWrite: 0 };
const sweep = (verdict, extra = {}) => ({ mode: 'sweep', verdict, fidelity: 8, sens: 2, click: 2, usage, ...extra });

test('summarizeRun counts rows, verdicts, escalations, tokens, and cost', () => {
  const rows = [
    { thinBody: false, slam: { matched: true }, sweep: sweep('VERIFIED'), final: { verdict: 'VERIFIED', fidelity: 8, sens: 2, click: 2, source: 'sweep' }, escalation: { eligible: false } },
    {
      thinBody: false, slam: { matched: false }, sweep: sweep('PROVISIONAL'),
      fulltext: { mode: 'fulltext', verdict: 'MISLEADING', fidelity: 1, sens: 8, click: 6, usage },
      final: { verdict: 'MISLEADING', fidelity: 1, sens: 8, click: 6, source: 'fulltext' },
      escalation: { eligible: true, sweepVerdict: 'PROVISIONAL', outcome: 'confirmed' },
    },
    {
      thinBody: false, slam: { matched: false }, sweep: sweep('CONTESTED'),
      fulltextError: { reason: 'blocked', detail: 'HTTP 403' },
      final: { verdict: 'CONTESTED', fidelity: 8, sens: 2, click: 2, source: 'sweep' },
      escalation: { eligible: true, sweepVerdict: 'CONTESTED', outcome: 'pending' },
    },
    { thinBody: true, slam: { matched: false }, sweep: { mode: 'tone', verdict: null, fidelity: null, sens: 4, click: 4, usage }, final: { verdict: null, fidelity: null, sens: 4, click: 4, source: 'tone' }, escalation: { eligible: false } },
    { thinBody: false, slam: { matched: false }, sweep: null, sweepError: { reason: 'timeout' }, final: { source: 'unscored', verdict: null }, escalation: { eligible: false } },
    // carried-forward row: no usage this run
    { thinBody: false, slam: { matched: false }, sweep: sweep('CONTEXTUAL', { usage: null, carriedFrom: 'r0' }), final: { verdict: 'CONTEXTUAL', fidelity: 8, sens: 2, click: 2, source: 'sweep' }, escalation: { eligible: false } },
  ];
  const feeds = [{ status: 'live' }, { status: 'live' }, { status: 'stale' }, { status: 'dead' }, { status: 'blocked' }];
  const s = summarizeRun({ rows, feeds });

  assert.deepEqual(s.feeds, { total: 5, live: 2, stale: 1, blocked: 1, dead: 1 });
  assert.deepEqual(s.rows, { total: 6, scored: 5, unscored: 1, fulltext: 1, feedSummary: 3, headlineOnly: 1, withText: 4 });
  assert.deepEqual(s.verdicts, { VERIFIED: 1, CONTEXTUAL: 1, CONTESTED: 1, UNVERIFIED: 0, PROVISIONAL: 0, MISLEADING: 1 });
  assert.equal(s.framingIntegrity.v2Low, 50);
  assert.equal(s.framingIntegrity.v2High, 50);
  assert.equal(s.framingIntegrity.v1, 60); // 2 good + 1 tone-as-verified out of 5 scored
  assert.equal(s.coverage, 80);
  assert.deepEqual(s.slam, { flagged: 1, index: 16.7 });
  assert.equal(s.escalation.eligible, 2);
  assert.equal(s.escalation.attempted, 2);
  assert.equal(s.escalation.confirmed, 1);
  assert.equal(s.escalation.pending, 1);
  assert.equal(s.escalation.blocked, 1);
  assert.deepEqual(s.escalation.bySweep.PROVISIONAL, { confirmed: 1, cleared: 0, pending: 0 });
  assert.deepEqual(s.escalation.bySweep.CONTESTED, { confirmed: 0, cleared: 0, pending: 1 });
  // 4 scored calls with usage + 1 fulltext = 5 (carried row and failed row add none)
  assert.deepEqual(s.usage, { input: 500, output: 200, cacheRead: 4000, cacheWrite: 0, calls: 5 });
  assert.equal(s.costUsd, (500 * 2 + 200 * 10 + 4000 * 0.1) / 1e6);
  assert.equal(s.axes.fidelity, 6.3); // (8+1+8+8)/4 = 6.25, one decimal
  assert.equal(s.integrity.meanV2, 55.6); // (72 + 6.5 + 72 + 72) / 4 = 55.625
});

test('historyRecord fills every frozen column', () => {
  const s = summarizeRun({ rows: [], feeds: [] });
  const rec = historyRecord({ id: 'r', startedAt: 'a', finishedAt: 'b', durationMs: 1, methodology: 'v2', model: 'm', promptHashes: { sweep: 's', fulltext: 'f', tone: 't' }, summary: s });
  for (const c of HISTORY_COLUMNS) assert.ok(c in rec, `missing column ${c}`);
  assert.equal(rec.fi_v2_low, null);
  assert.equal(rec.rows_total, 0);
});
