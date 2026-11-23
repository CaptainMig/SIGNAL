// End-to-end: feeds → dedupe → sweep → escalate → run record, with a mocked
// network and a mocked model. Then a second run proves carry-forward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScan } from '../pipeline/run.js';
import { createScorer } from '../pipeline/scorer.js';
import { fixture, mockClient, mockFetch, NOW } from './helpers.js';

const thin = (title) =>
  `<rss><channel><item><title>${title}</title><link>https://news.google.com/rss/articles/XYZ?oc=5</link><pubDate>${new Date(NOW - 3600e3).toUTCString()}</pubDate><description>snippet</description></item></channel></rss>`;

const FEEDS = [
  { name: 'A', outlet: 'Outlet A', owner: 'Owner A', url: 'https://feed-a/' },
  { name: 'B', owner: 'Owner B', url: 'https://feed-b/' },
  { name: 'Wire', owner: 'Owner W', url: 'https://feed-wire/', thinBody: true },
  { name: 'Dead', owner: 'Owner D', url: 'https://feed-dead/' },
];

function network(overrides = {}) {
  return mockFetch({
    'https://feed-a/': { status: 200, body: fixture('feed-a.xml') },
    'https://feed-b/': { status: 200, body: fixture('feed-b.xml') },
    'https://feed-wire/': { status: 200, body: thin('Wire: markets rally as talks resume - AP News') },
    'https://feed-dead/': { status: 503, body: '' },
    'https://www.example-a.com/local/transit-vote': { status: 200, body: fixture('article.html') },
    'https://example-b.com/fire-warehouse': { status: 200, body: fixture('stub.html') },
    ...overrides,
  });
}

function model() {
  return mockClient((req) => {
    const headline = req.messages[0].content.split('\n')[0].replace('HEADLINE: ', '');
    const tone = !req.output_config.format.schema.required.includes('verdict');
    const fulltext = req.system[0].text.includes('FULL-TEXT MODE');
    if (tone) return { sensationalism: 3, clickbait: 2, rationale: 'flat' };
    if (headline.startsWith('Mayor slams')) {
      return fulltext
        ? { verdict: 'MISLEADING', fidelity: 2, sensationalism: 8, clickbait: 5, rationale: 'The body does not support the headline.' }
        : { verdict: 'MISLEADING', fidelity: 3, sensationalism: 7, clickbait: 4, rationale: 'inverts' };
    }
    if (headline.startsWith('Fire guts')) return { verdict: 'CONTESTED', fidelity: 6, sensationalism: 5, clickbait: 3, rationale: 'disputed' };
    return { verdict: 'VERIFIED', fidelity: 9, sensationalism: 1, clickbait: 1, rationale: 'fine' };
  });
}

let clock = NOW;
const now = () => (clock += 1000);

test('a full run: rows, modes, escalation outcomes, finals, summary', async () => {
  const client = model();
  const scorer = createScorer({ client, model: 'claude-sonnet-5-5', now });
  const { run, rows, delta } = await runScan({ scorer, fetch: network(), now, feeds: FEEDS, model: 'claude-sonnet-5-5', auditSize: 0 });

  assert.equal(run.id, '2026-11-23T17');
  assert.equal(run.methodology, 'v2');
  assert.equal(run.model, 'claude-sonnet-5-5');
  assert.equal(run.dryRun, false);
  assert.equal(run.feeds.length, 4);
  assert.equal(run.feeds.find((f) => f.name === 'Dead').status, 'dead');

  const byLink = Object.fromEntries(rows.map((r) => [r.canonical, r]));
  assert.equal(rows.length, 5);

  // No article text ever reaches a ledger row: not the feed snippet, not the
  // extracted body. Only the headline, link, outlet, scores, verdict,
  // rationale, and the body's character count.
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes('The Senate passed the budget bill 52'), 'feed summary must not be stored');
  assert.ok(!serialized.includes('late-night session that stretched'), 'extracted article text must not be stored');
  assert.ok(!serialized.includes('Subscribe to continue'), 'stub text must not be stored');
  const ALLOWED = ['id', 'title', 'link', 'canonical', 'publication', 'outlet', 'owner', 'pubDate', 'undated', 'thinBody', 'slam', 'sweep', 'sweepError', 'fulltext', 'fulltextError', 'escalation', 'final', 'writtenIn', 'audit', 'auditSampledIn', 'auditOutcome'];
  for (const r of rows) for (const k of Object.keys(r)) assert.ok(ALLOWED.includes(k), `unexpected row field ${k}`);
  const SCORE_KEYS = ['mode', 'verdict', 'fidelity', 'sens', 'click', 'rationale', 'provisional', 'model', 'promptHash', 'usage', 'latencyMs', 'at', 'chars', 'carriedFrom'];
  for (const r of rows) for (const s of [r.sweep, r.fulltext]) if (s) for (const k of Object.keys(s)) assert.ok(SCORE_KEYS.includes(k), `unexpected score field ${k}`);

  // First run: every row is fresh, so the delta is the whole run.
  assert.equal(delta.rows.length, 5);
  assert.deepEqual(delta.carried, []);
  assert.ok(rows.every((r) => r.writtenIn === run.id));

  const budget = byLink['https://example-a.com/politics/budget-bill'];
  assert.equal(budget.sweep.mode, 'sweep');
  assert.equal(budget.final.verdict, 'VERIFIED');
  assert.equal(budget.final.source, 'sweep');
  assert.equal(budget.sweep.model, 'claude-sonnet-5-5');
  assert.equal(budget.sweep.promptHash, scorer.promptHashes.sweep);
  assert.equal(budget.escalation.eligible, false);
  assert.equal(budget.outlet, 'Outlet A', 'outlet key from the feed config');

  const transit = byLink['https://example-a.com/local/transit-vote'];
  assert.equal(transit.slam.term, 'slams');
  assert.equal(transit.sweep.verdict, 'PROVISIONAL', 'sweep MISLEADING is provisionalized');
  assert.equal(transit.sweep.provisional, true);
  assert.equal(transit.fulltext.verdict, 'MISLEADING');
  assert.ok(transit.fulltext.chars > 400);
  assert.deepEqual(transit.escalation, { eligible: true, reason: 'provisional', sweepVerdict: 'PROVISIONAL', outcome: 'confirmed', unresolved: false, attempts: 0 });
  assert.equal(transit.final.verdict, 'MISLEADING');
  assert.equal(transit.final.source, 'fulltext');

  const fire = byLink['https://example-b.com/fire-warehouse'];
  assert.equal(fire.slam.matched, false, 'fire guts warehouse is literal');
  assert.equal(fire.sweep.verdict, 'CONTESTED');
  assert.equal(fire.fulltext, null);
  assert.deepEqual([fire.fulltextError.reason, fire.fulltextError.detail, fire.fulltextError.stage, fire.fulltextError.attempts], ['blocked', 'stub', 'extract', 1]);
  assert.equal(fire.escalation.outcome, 'pending');
  assert.equal(fire.escalation.unresolved, false);
  assert.equal(fire.outlet, 'B', 'no outlet key → the publication');
  assert.equal(fire.final.verdict, 'CONTESTED');
  assert.equal(fire.final.source, 'sweep');

  assert.equal(run.summary.extraction.attempts, 2);
  assert.equal(run.summary.extraction.successes, 1);
  assert.equal(run.summary.framingIntegrity.strict.low, 50);
  assert.equal(run.summary.audit.sampledThisRun, 0);
  const wire = byLink['https://news.google.com/rss/articles/XYZ'];
  assert.equal(wire.thinBody, true);
  assert.equal(wire.sweep.mode, 'tone');
  assert.equal(wire.final.verdict, null);
  assert.equal(wire.final.fidelity, null);
  assert.equal(wire.final.source, 'tone');
  assert.equal(wire.final.sens, 3);

  const undated = byLink['https://example-a.com/undated'];
  assert.equal(undated.undated, true);
  assert.equal(undated.final.verdict, 'VERIFIED');

  assert.equal(client.requests.length, 6, '5 sweep calls + 1 full-text call');
  assert.equal(scorer.samples.length, 1, 'one raw model response is kept for the run report');
  assert.equal(scorer.samples[0].stopReason, 'end_turn');
  assert.ok(scorer.samples[0].text.startsWith('{'));

  const s = run.summary;
  assert.deepEqual(s.rows, { total: 5, scored: 5, unscored: 0, fulltext: 1, feedSummary: 3, headlineOnly: 1, withText: 4 });
  assert.deepEqual(s.verdicts, { VERIFIED: 2, CONTEXTUAL: 0, CONTESTED: 1, UNVERIFIED: 0, PROVISIONAL: 0, MISLEADING: 1 });
  assert.equal(s.framingIntegrity.v2Low, 50);
  assert.equal(s.framingIntegrity.v2High, 50);
  assert.equal(s.framingIntegrity.v1, 60);
  assert.equal(s.coverage, 80);
  assert.deepEqual([s.escalation.eligible, s.escalation.attempted, s.escalation.confirmed, s.escalation.cleared, s.escalation.pending, s.escalation.blocked], [2, 2, 1, 0, 1, 1]);
  assert.deepEqual(s.usage, { input: 600, output: 240, cacheRead: 4800, cacheWrite: 0, calls: 6 });
  assert.equal(s.costUsd, 0.00408);
  assert.deepEqual(s.feeds, { total: 4, live: 3, stale: 0, blocked: 0, dead: 1 });
});

test('carry-forward: a prior run supplies unchanged scores; a headline edit forces a re-score', async () => {
  const client1 = model();
  const scorer1 = createScorer({ client: client1, model: 'claude-sonnet-5-5', now });
  const first = await runScan({ scorer: scorer1, fetch: network(), now, feeds: FEEDS, model: 'claude-sonnet-5-5', auditSize: 0 });
  const prior = [{ ...first.run, rows: first.rows }];

  const client2 = model();
  const scorer2 = createScorer({ client: client2, model: 'claude-sonnet-5-5', now });
  const fetch2 = network();
  const second = await runScan({ scorer: scorer2, fetch: fetch2, now, feeds: FEEDS, priorRuns: prior, model: 'claude-sonnet-5-5', auditSize: 0 });
  assert.equal(client2.requests.length, 0, 'nothing changed → no tokens spent');
  assert.ok(fetch2.calls.some((u) => u.includes('example-b.com/fire-warehouse')), 'a failed fetch is retried while attempts remain');
  const fire2 = second.rows.find((r) => r.canonical === 'https://example-b.com/fire-warehouse');
  assert.equal(fire2.fulltextError.attempts, 2);
  assert.equal(fire2.escalation.outcome, 'pending');
  const transit = second.rows.find((r) => r.canonical === 'https://example-a.com/local/transit-vote');
  assert.equal(transit.sweep.carriedFrom, first.run.id);
  assert.equal(transit.fulltext.carriedFrom, first.run.id);
  assert.equal(transit.sweep.usage, null);
  assert.equal(transit.escalation.outcome, 'confirmed');
  assert.equal(second.run.summary.usage.calls, 0);
  assert.equal(second.run.summary.costUsd, 0);
  assert.equal(second.run.summary.framingIntegrity.v2Low, 50, 'carried rows still count in the summary');
  // Delta: only the retried row is fresh; four references to the first run.
  assert.deepEqual(second.delta.rows.map((r) => r.id), [fire2.id]);
  assert.equal(second.delta.carried.length, 4);
  assert.ok(second.delta.carried.every((c) => c.run === first.run.id));

  // Retries exhausted: the row is UNRESOLVED, not fetched again, and out of FI.
  const exhausted = prior[0].rows.map((r) => (r.id === fire2.id ? { ...r, fulltextError: { ...r.fulltextError, attempts: 4 } } : r));
  const fetchX = network();
  const clientX = model();
  const after = await runScan({ scorer: createScorer({ client: clientX, model: 'claude-sonnet-5-5', now }), fetch: fetchX, now, feeds: FEEDS, priorRuns: [{ ...prior[0], rows: exhausted }], model: 'claude-sonnet-5-5', auditSize: 0 });
  assert.ok(!fetchX.calls.some((u) => u.includes('example-b.com/fire-warehouse')), 'no fetch after the attempt limit');
  const fireX = after.rows.find((r) => r.id === fire2.id);
  assert.equal(fireX.escalation.unresolved, true);
  assert.equal(fireX.escalation.outcome, 'unresolved');
  assert.equal(after.run.summary.framingIntegrity.unresolved, 1);
  assert.equal(after.run.summary.framingIntegrity.broad.n, 3, 'unresolved row leaves the FI population');
  assert.equal(after.run.summary.framingIntegrity.broad.low, 66.7);
  assert.equal(after.run.summary.escalation.unresolved, 1);

  // Headline edited at the source → that row is re-scored, the rest carried.
  const edited = fixture('feed-a.xml').replace('Senate passes budget bill after late-night session', 'Senate narrowly passes budget bill in overnight vote');
  const client3 = model();
  const scorer3 = createScorer({ client: client3, model: 'claude-sonnet-5-5', now });
  const third = await runScan({ scorer: scorer3, fetch: network({ 'https://feed-a/': { status: 200, body: edited } }), now, feeds: FEEDS, priorRuns: prior, model: 'claude-sonnet-5-5', auditSize: 0 });
  assert.equal(client3.requests.length, 1);
  const budget = third.rows.find((r) => r.canonical === 'https://example-a.com/politics/budget-bill');
  assert.equal(budget.title, 'Senate narrowly passes budget bill in overnight vote');
  assert.equal(budget.sweep.carriedFrom, undefined);
  assert.deepEqual(third.delta.rows.map((r) => r.id).sort(), [budget.id, fire2.id].sort(), 'the re-scored row and the retried row are written in full');
  assert.equal(third.delta.carried.length, 3);
  assert.equal(budget.writtenIn, third.run.id);

  // A chain of carries keeps pointing at the run that holds the full row.
  const client5 = model();
  const scorer5 = createScorer({ client: client5, model: 'claude-sonnet-5-5', now });
  const fourth = await runScan({ scorer: scorer5, fetch: network(), now, feeds: FEEDS, priorRuns: [{ ...third.run, rows: third.rows }, ...prior], model: 'claude-sonnet-5-5', auditSize: 0 });
  assert.equal(client5.requests.length, 1, 'the title reverted, so the budget row is re-scored; the rest is carried');
  const transitRef = fourth.delta.carried.find((c) => c.id === transit.id);
  assert.equal(transitRef.run, first.run.id, 'carried through the third run, still referenced to the first');

  // A different model → nothing is carried.
  const client4 = model();
  const scorer4 = createScorer({ client: client4, model: 'claude-other', now });
  await runScan({ scorer: scorer4, fetch: network(), now, feeds: FEEDS, priorRuns: prior, model: 'claude-other', auditSize: 0 });
  assert.equal(client4.requests.length, 6);
});

test('dry run scores nothing and marks every row UNSCORED (dry_run)', async () => {
  const { run, rows, delta } = await runScan({ scorer: null, fetch: network(), now, feeds: FEEDS });
  assert.equal(run.dryRun, true);
  assert.equal(delta.rows.length, 5, 'dry-run rows carry an error, so they are written in full');
  assert.ok(rows.every((r) => r.final.source === 'unscored' && r.sweepError.reason === 'dry_run'));
  assert.equal(run.summary.rows.unscored, 5);
  assert.equal(run.summary.costUsd, 0);
});

test('limit caps the rows scored', async () => {
  const client = model();
  const scorer = createScorer({ client, now });
  const { rows } = await runScan({ scorer, fetch: network(), now, feeds: FEEDS, limit: 2, auditSize: 0 });
  assert.equal(rows.length, 2);
  assert.equal(client.requests.length, 3, '2 sweep calls + 1 full-text call for the PROVISIONAL row');
});

test('audit sample: sweep VERIFIED/CONTEXTUAL rows get the article, a flag, and stay out of the matrix', async () => {
  const client = model();
  const scorer = createScorer({ client, model: 'claude-sonnet-5-5', now });
  const fetch = network({
    'https://www.example-a.com/politics/budget-bill': { status: 200, body: fixture('article.html') },
    'https://www.example-a.com/undated': { status: 200, body: fixture('article.html') },
  });
  const { run, rows } = await runScan({ scorer, fetch, now, feeds: FEEDS, model: 'claude-sonnet-5-5', auditSize: 10 });
  const audited = rows.filter((r) => r.audit);
  assert.equal(audited.length, 2, 'only the two sweep VERIFIED text rows are eligible');
  assert.ok(audited.every((r) => r.auditSampledIn === run.id));
  assert.ok(audited.every((r) => r.fulltext && r.fulltext.verdict === 'VERIFIED'));
  assert.ok(audited.every((r) => r.auditOutcome.scored && !r.auditOutcome.changed && !r.auditOutcome.overturned));
  assert.ok(audited.every((r) => r.escalation.eligible === false), 'audit rows are not escalation rows');
  assert.equal(client.requests.length, 8, '5 sweep + 1 escalation + 2 audit full-text calls');
  assert.deepEqual([run.summary.audit.sampledThisRun, run.summary.audit.present, run.summary.audit.scored, run.summary.audit.overturned, run.summary.audit.overturnPct], [2, 2, 2, 0, 0]);
  assert.equal(run.summary.escalation.eligible, 2, 'matrix untouched by the audit');

  // Carried forward: the audit mark and the full-text verdict travel with the row; no re-sampling.
  const again = await runScan({ scorer: createScorer({ client: model(), model: 'claude-sonnet-5-5', now }), fetch: network(), now, feeds: FEEDS, priorRuns: [{ ...run, rows }], model: 'claude-sonnet-5-5', auditSize: 10 });
  assert.equal(again.rows.filter((r) => r.audit).length, 2);
  assert.equal(again.run.summary.audit.sampledThisRun, 0);
  assert.equal(again.run.summary.audit.present, 2);
});

test('golden set is scored on its cadence and compared with the baseline', async () => {
  const set = { version: 1, items: [{ id: 'g1', expected: 'VERIFIED', headline: 'Golden headline one here', article: 'A'.repeat(200) }, { id: 'g2', expected: 'MISLEADING', headline: 'Mayor slams the golden council', article: 'B'.repeat(200) }] };
  const baseline = { runId: 'r0', model: 'claude-sonnet-5-5', promptHash: 'x', results: [{ id: 'g1', ok: true, verdict: 'VERIFIED', fidelity: 9, sens: 1, click: 1 }, { id: 'g2', ok: true, verdict: 'VERIFIED', fidelity: 9, sens: 1, click: 1 }] };
  const client = model();
  const scorer = createScorer({ client, model: 'claude-sonnet-5-5', now });
  const { run, goldenReport } = await runScan({ scorer, fetch: network(), now, feeds: FEEDS, model: 'claude-sonnet-5-5', auditSize: 0, golden: { set, baseline, every: 1 }, runIndex: 0 });
  assert.equal(goldenReport.results.length, 2);
  assert.equal(goldenReport.results[1].verdict, 'MISLEADING', 'full-text mode may emit MISLEADING');
  assert.equal(goldenReport.comparison.baseline.agreementPct, 50);
  assert.equal(run.summary.golden.alert, true);
  assert.equal(run.golden.results.length, 2);
  assert.ok(!JSON.stringify(run).includes('AAAA'), 'golden article text never enters the run record');
  assert.equal(client.requests.length, 8, '6 row calls + 2 golden calls');

  const skipped = await runScan({ scorer: createScorer({ client: model(), model: 'claude-sonnet-5-5', now }), fetch: network(), now, feeds: FEEDS, model: 'claude-sonnet-5-5', auditSize: 0, golden: { set, baseline, every: 24 }, runIndex: 5 });
  assert.equal(skipped.goldenReport, null);
  assert.equal(skipped.run.summary.golden, null);
});
