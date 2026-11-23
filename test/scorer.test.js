import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { buildRequest, classifyError, createScorer } from '../pipeline/scorer.js';
import { mockClient } from './helpers.js';

const V = { verdict: 'VERIFIED', fidelity: 9, sensationalism: 1, clickbait: 1, rationale: 'fine' };

test('buildRequest: model, cached system block, schema-constrained output, thinking off', () => {
  const req = buildRequest({ headline: 'H', body: 'B', mode: 'sweep', model: 'claude-sonnet-5-5', thinking: 'between_tools', effort: 'low' });
  assert.equal(req.model, 'claude-sonnet-5-5');
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(req.messages[0].content, 'HEADLINE: H\nARTICLE: B');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.output_config.effort, 'low');
  assert.deepEqual(req.thinking, { type: 'between_tools' });
  assert.equal('temperature' in req, false, 'temperature is rejected by the current API');
  const adaptive = buildRequest({ headline: 'H', body: 'B', mode: 'sweep', thinking: 'adaptive' });
  assert.deepEqual(adaptive.thinking, { type: 'adaptive' });
  const none = buildRequest({ headline: 'H', body: 'B', mode: 'sweep', thinking: 'default' });
  assert.equal('thinking' in none, false);
});

test('scoreOne returns a score with model, prompt hash, usage, latency', async () => {
  const client = mockClient(() => V);
  const scorer = createScorer({ client, model: 'claude-sonnet-5-5', now: (() => { let t = 1000; return () => (t += 250); })() });
  const r = await scorer.scoreOne({ headline: 'H', body: 'B', mode: 'fulltext' });
  assert.equal(r.ok, true);
  assert.equal(r.score.verdict, 'VERIFIED');
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(r.promptHash, scorer.promptHashes.fulltext);
  assert.deepEqual(r.usage, { input: 100, output: 40, cacheRead: 800, cacheWrite: 0 });
  assert.equal(r.latencyMs, 250);
  assert.match(r.at, /^\d{4}-/);
});

test('refusal, max_tokens, and unparseable output become UNSCORED with a reason', async () => {
  const base = { model: 'm', usage: { input_tokens: 10, output_tokens: 1 } };
  const refusing = mockClient(() => ({ ...base, stop_reason: 'refusal', stop_details: { category: 'general_harms', explanation: 'no' }, content: [] }));
  let r = await createScorer({ client: refusing }).scoreOne({ headline: 'H', body: 'B' });
  assert.deepEqual([r.ok, r.reason], [false, 'refusal']);
  assert.match(r.detail, /general_harms/);
  assert.equal(r.usage.input, 10, 'tokens spent on a refusal are still counted');

  const truncating = mockClient(() => ({ ...base, stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"verdict":' }] }));
  r = await createScorer({ client: truncating }).scoreOne({ headline: 'H', body: 'B' });
  assert.deepEqual([r.ok, r.reason], [false, 'max_tokens']);

  const garbage = mockClient(() => ({ ...base, stop_reason: 'end_turn', content: [{ type: 'text', text: 'sorry' }] }));
  r = await createScorer({ client: garbage }).scoreOne({ headline: 'H', body: 'B' });
  assert.deepEqual([r.ok, r.reason], [false, 'parse']);
});

test('thrown SDK errors are classified, never rethrown', async () => {
  const boom = (proto, extra = {}) => Object.assign(Object.create(proto), { message: 'x', ...extra });
  const cases = [
    [boom(Anthropic.RateLimitError.prototype), 'rate_limited'],
    [boom(Anthropic.AuthenticationError.prototype), 'auth'],
    [boom(Anthropic.BadRequestError.prototype), 'bad_request'],
    [boom(Anthropic.APIConnectionTimeoutError.prototype), 'timeout'],
    [boom(Anthropic.InternalServerError.prototype, { status: 500 }), 'error'],
    [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout'],
    [{ status: 429 }, 'rate_limited'],
    [new Error('plain'), 'error'],
  ];
  for (const [err, reason] of cases) {
    assert.equal(classifyError(err), reason);
    const client = mockClient(() => { throw err; });
    const r = await createScorer({ client }).scoreOne({ headline: 'H', body: 'B' });
    assert.deepEqual([r.ok, r.reason], [false, reason]);
  }
});

test('scoreAll keeps input order with a bounded pool and reports progress', async () => {
  let inFlight = 0;
  let peak = 0;
  const client = mockClient(async (req) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { ...V, rationale: req.messages[0].content };
  });
  const scorer = createScorer({ client, concurrency: 3 });
  const items = Array.from({ length: 10 }, (_, i) => ({ headline: `H${i}`, body: 'B', mode: 'sweep' }));
  const progress = [];
  const results = await scorer.scoreAll(items, { onProgress: (p) => progress.push(p.done) });
  assert.equal(results.length, 10);
  results.forEach((r, i) => assert.equal(r.score.rationale, `HEADLINE: H${i}\nARTICLE: B`));
  assert.equal(peak, 3);
  assert.equal(progress.at(-1), 10);
});

test('served model is recorded from the response, not assumed', async () => {
  const client = mockClient(() => ({ model: 'claude-sonnet-5-5-served', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(V) }], usage: {} }));
  const r = await createScorer({ client, model: 'claude-sonnet-5-5' }).scoreOne({ headline: 'H', body: 'B' });
  assert.equal(r.model, 'claude-sonnet-5-5-served');
});
