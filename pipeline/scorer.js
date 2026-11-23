// ---------------------------------------------------------------------------
// The scorer: one Claude call per headline, through the official SDK, with a
// fixed-concurrency pool. The ONLY place in the repo that talks to the model.
//
// The API key is read server-side from ANTHROPIC_API_KEY. The client is
// injectable so every test runs without a network and without a key.
//
// A failed call is reported as UNSCORED with a reason from a closed set —
// never a default score dressed up as a verdict.
// ---------------------------------------------------------------------------
import Anthropic from '@anthropic-ai/sdk';
import {
  EFFORT,
  MODEL,
  SCORE_CONCURRENCY,
  SCORE_MAX_RETRIES,
  SCORE_MAX_TOKENS,
  SCORE_TIMEOUT_MS,
  THINKING,
} from './config.js';
import { parseScore, promptHash, schemaFor, systemPromptFor, userContent } from './prompt.js';

export const UNSCORED_REASONS = ['timeout', 'rate_limited', 'auth', 'bad_request', 'error', 'refusal', 'max_tokens', 'parse'];

export function createClient({ apiKey = process.env.ANTHROPIC_API_KEY, maxRetries = SCORE_MAX_RETRIES, timeout = SCORE_TIMEOUT_MS } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  return new Anthropic({ apiKey, maxRetries, timeout });
}

// Classify an SDK error into an UNSCORED reason. Typed classes first, status
// code fallback for anything else.
export function classifyError(e) {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (e instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return 'auth';
  if (e instanceof Anthropic.BadRequestError) return 'bad_request';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const status = e?.status;
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400) return 'bad_request';
  return 'error';
}

function usageOf(response) {
  const u = response?.usage || {};
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
  };
}

export function buildRequest({ headline, body, mode, model = MODEL, thinking = THINKING, effort = EFFORT, maxTokens = SCORE_MAX_TOKENS }) {
  const req = {
    model,
    max_tokens: maxTokens,
    // The system prompt is identical for every call of a mode, so it is the
    // cacheable prefix; the per-headline user turn follows it.
    system: [{ type: 'text', text: systemPromptFor(mode), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent(headline, body, mode) }],
    output_config: { effort, format: { type: 'json_schema', schema: schemaFor(mode) } },
  };
  // 'between_tools' is the only accepted thinking-off setting on Sonnet 5.5
  // (`disabled` is a 400 there). 'adaptive' lets the model think; any other
  // value means "omit the field" (the model's default).
  if (thinking === 'between_tools') req.thinking = { type: 'between_tools' };
  else if (thinking === 'adaptive') req.thinking = { type: 'adaptive' };
  return req;
}

/**
 * Create a scorer bound to a client.
 *   scoreOne({ headline, body, mode }) →
 *     { ok: true,  score, model, promptHash, usage, latencyMs, at }
 *     { ok: false, reason, detail, model, promptHash, usage, latencyMs, at }
 *   scoreAll(items, { onProgress }) → results in input order
 */
export function createScorer({ client, model = MODEL, concurrency = SCORE_CONCURRENCY, thinking = THINKING, effort = EFFORT, now = () => Date.now(), keepSamples = 1 } = {}) {
  if (!client) throw new Error('createScorer: client is required');
  const hashes = { sweep: promptHash('sweep'), fulltext: promptHash('fulltext'), tone: promptHash('tone') };
  // Raw responses kept for the run report (the first `keepSamples` of them).
  // Only the model's own output is kept — never the article body sent to it.
  const samples = [];

  async function scoreOne({ headline, body = '', mode = 'sweep' }) {
    const t0 = now();
    const base = { model, promptHash: hashes[mode], at: new Date(t0).toISOString() };
    let response;
    try {
      response = await client.messages.create(buildRequest({ headline, body, mode, model, thinking, effort }));
    } catch (e) {
      return { ok: false, reason: classifyError(e), detail: String(e?.message || e).slice(0, 300), usage: usageOf(null), latencyMs: now() - t0, ...base };
    }
    const latencyMs = now() - t0;
    const usage = usageOf(response);
    const served = response?.model || model;
    if (samples.length < keepSamples) {
      samples.push({
        headline,
        mode,
        model: served,
        stopReason: response?.stop_reason ?? null,
        text: (response?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
        usage,
        latencyMs,
      });
    }
    if (response?.stop_reason === 'refusal') {
      const d = response.stop_details;
      return { ok: false, reason: 'refusal', detail: d ? `${d.category || 'unspecified'}: ${d.explanation || ''}`.slice(0, 300) : '', usage, latencyMs, ...base, model: served };
    }
    if (response?.stop_reason === 'max_tokens') {
      return { ok: false, reason: 'max_tokens', detail: 'output truncated', usage, latencyMs, ...base, model: served };
    }
    const text = (response?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      const score = parseScore(text, mode);
      return { ok: true, score, usage, latencyMs, ...base, model: served };
    } catch (e) {
      return { ok: false, reason: 'parse', detail: String(e?.message || e).slice(0, 300), usage, latencyMs, ...base, model: served };
    }
  }

  async function scoreAll(items, { onProgress, shouldStop } = {}) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    async function worker() {
      while (true) {
        if (shouldStop?.()) return;
        const i = next++;
        if (i >= items.length) return;
        results[i] = await scoreOne(items[i]);
        done++;
        onProgress?.({ done, total: items.length, index: i, result: results[i] });
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
  }

  return { scoreOne, scoreAll, model, promptHashes: hashes, samples };
}
