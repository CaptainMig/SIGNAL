// ---------------------------------------------------------------------------
// One scheduled run: fetch feeds → dedupe by canonical link → sweep score →
// full-text escalate flagged rows → build the run record. Pure with respect
// to I/O: fetch, scorer, clock, and prior runs are injected, so the whole
// pipeline runs in a test without a network or a key. scripts/scan.js wires
// the real ones and writes the ledger.
//
// Carry-forward: an article stays in the feeds for up to 48h and would be
// re-scored every hour for no new information. When a prior run in the reuse
// window already scored the same row id with the same title, model, and
// prompt hash, that score is carried into this run's row (marked
// `carriedFrom`) and no tokens are spent. Headline edits, prompt edits, and
// model changes all force a fresh score. SOURCE BLOCKED extraction failures
// are carried too (the publisher's policy does not change hourly); timeouts
// and transient errors are retried.
//
// Scan files are deltas: run telemetry plus only the rows that were scored or
// re-scored this run. A carried row is referenced by article id and the run
// whose scan file holds its full record (`writtenIn`). latest.json is always
// the full current view.
// ---------------------------------------------------------------------------
import { EXTRACT_CONCURRENCY, FEEDS, METHODOLOGY, MODEL, PRICING, THINKING, EFFORT, BODY_CHARS } from './config.js';
import { collectHeadlines } from './feeds.js';
import { detectSlam } from './slam.js';
import { fetchArticle } from './extract.js';
import { escalationOutcome, needsEscalation } from './escalate.js';
import { summarizeRun } from './summarize.js';
import { promptHash } from './prompt.js';

export const REUSE_WINDOW_HOURS = 48;

export function runIdFor(startedAt) {
  return new Date(startedAt).toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
}

// Index prior rows by id, latest sighting first.
export function indexPriorRows(priorRuns) {
  const map = new Map();
  for (const run of priorRuns || []) {
    for (const row of run.rows || []) {
      if (!map.has(row.id)) map.set(row.id, { row, runId: run.id });
    }
  }
  return map;
}

function reusable(entry, row, hashes, model) {
  if (!entry) return null;
  const prior = entry.row;
  if (prior.title !== row.title) return null;
  const out = {};
  if (prior.sweep && prior.sweep.model === model && prior.sweep.promptHash === hashes[prior.sweep.mode]) {
    out.sweep = { ...prior.sweep, usage: null, latencyMs: null, carriedFrom: prior.sweep.carriedFrom || entry.runId };
  }
  if (prior.fulltext && prior.fulltext.model === model && prior.fulltext.promptHash === hashes.fulltext) {
    out.fulltext = { ...prior.fulltext, usage: null, latencyMs: null, carriedFrom: prior.fulltext.carriedFrom || entry.runId };
  } else if (prior.fulltextError?.reason === 'blocked') {
    out.fulltextError = { ...prior.fulltextError, carriedFrom: prior.fulltextError.carriedFrom || entry.runId };
  }
  return out;
}

function scoreRecord(result, mode, extra = {}) {
  return {
    mode,
    ...result.score,
    model: result.model,
    promptHash: result.promptHash,
    usage: result.usage,
    latencyMs: result.latencyMs,
    at: result.at,
    ...extra,
  };
}

function errorRecord(result, stage) {
  return { reason: result.reason, detail: result.detail || '', stage, model: result.model, promptHash: result.promptHash, usage: result.usage, at: result.at };
}

function finalize(row) {
  const ft = row.fulltext;
  if (ft) {
    return { verdict: ft.verdict, fidelity: ft.fidelity, sens: ft.sens, click: ft.click, rationale: ft.rationale, source: 'fulltext', provisional: false };
  }
  const sw = row.sweep;
  if (sw) {
    return {
      verdict: sw.verdict,
      fidelity: sw.fidelity,
      sens: sw.sens,
      click: sw.click,
      rationale: sw.rationale,
      source: sw.mode === 'tone' ? 'tone' : 'sweep',
      provisional: !!sw.provisional,
    };
  }
  return { verdict: null, fidelity: null, sens: null, click: null, rationale: '', source: 'unscored', provisional: false, reason: row.sweepError?.reason || 'unscored' };
}

// A row is written in full when something about it was produced THIS run: a
// fresh sweep, a fresh full-text score, or any error (errors are never
// carried, except SOURCE BLOCKED, which is marked carriedFrom).
export function isFreshRow(row) {
  if (row.sweepError) return true;
  if (row.sweep && !row.sweep.carriedFrom) return true;
  if (row.fulltext && !row.fulltext.carriedFrom) return true;
  if (row.fulltextError && !row.fulltextError.carriedFrom) return true;
  return false;
}

async function pool(items, concurrency, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/**
 * Run the pipeline once.
 * @param scorer     createScorer(...) instance, or null for a dry run (no scoring).
 * @param priorRuns  recent scan records (newest first) for carry-forward.
 */
export async function runScan({
  scorer = null,
  fetch = globalThis.fetch,
  now = () => Date.now(),
  feeds = FEEDS,
  priorRuns = [],
  limit = 0,
  log = () => {},
  extractConcurrency = EXTRACT_CONCURRENCY,
  model = MODEL,
} = {}) {
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const hashes = { sweep: promptHash('sweep'), fulltext: promptHash('fulltext'), tone: promptHash('tone') };
  const dryRun = !scorer;

  log(`[signal] run ${runIdFor(startedAt)} started (${dryRun ? 'dry run' : model})`);
  const collected = await collectHeadlines({ feeds, fetch, now: startedMs });
  let rows = collected.rows.map((r) => ({
    ...r,
    slam: detectSlam(r.title),
    sweep: null,
    sweepError: null,
    fulltext: null,
    fulltextError: null,
    escalation: { eligible: false, sweepVerdict: null, outcome: null },
    final: null,
  }));
  if (limit > 0) rows = rows.slice(0, limit);
  const live = collected.feeds.filter((f) => f.status === 'live').length;
  log(`[signal] feeds: ${live}/${collected.feeds.length} live · ${rows.length} rows after dedupe`);

  // Carry-forward from prior runs.
  const prior = indexPriorRows(priorRuns);
  let carried = 0;
  for (const row of rows) {
    const entry = prior.get(row.id);
    const reuse = reusable(entry, row, hashes, model);
    if (reuse?.sweep) {
      row.sweep = reuse.sweep;
      carried++;
    }
    if (reuse?.fulltext) row.fulltext = reuse.fulltext;
    if (reuse?.fulltextError) row.fulltextError = reuse.fulltextError;
    if (reuse && (reuse.sweep || reuse.fulltext || reuse.fulltextError)) {
      row.writtenIn = entry.row.writtenIn || entry.runId;
    }
  }
  if (carried) log(`[signal] carried ${carried} sweep score(s) forward from prior runs`);

  // Sweep. Mode follows the evidence actually in hand: a thin-body feed or an
  // empty summary means tone only.
  const toSweep = rows.filter((r) => !r.sweep);
  if (dryRun) {
    for (const row of toSweep) row.sweepError = { reason: 'dry_run', detail: 'scoring skipped', stage: 'sweep' };
  } else if (toSweep.length) {
    const items = toSweep.map((r) => ({ headline: r.title, body: r.summary || '', mode: r.thinBody || !r.summary ? 'tone' : 'sweep' }));
    const results = await scorer.scoreAll(items, {
      onProgress: ({ done, total }) => {
        if (done % 25 === 0 || done === total) log(`[signal] sweep ${done}/${total}`);
      },
    });
    results.forEach((res, i) => {
      const row = toSweep[i];
      if (res.ok) row.sweep = scoreRecord(res, items[i].mode);
      else row.sweepError = errorRecord(res, 'sweep');
    });
  }

  // Escalation: flagged sweep rows get the article body and a full-text score.
  const flagged = rows.filter((r) => needsEscalation(r.sweep));
  for (const row of flagged) row.escalation = { eligible: true, sweepVerdict: row.sweep.verdict, outcome: null };
  const toEscalate = dryRun ? [] : flagged.filter((r) => !r.fulltext && !(r.fulltextError?.reason === 'blocked'));
  if (toEscalate.length) log(`[signal] escalating ${toEscalate.length} flagged row(s) to full text`);
  await pool(toEscalate, extractConcurrency, async (row) => {
    row.fulltextError = null;
    const ex = await fetchArticle(row.link, { fetch });
    if (!ex.ok) {
      row.fulltextError = { reason: ex.reason, detail: ex.detail, stage: 'extract', chars: ex.chars ?? null, at: new Date(now()).toISOString() };
      return;
    }
    const res = await scorer.scoreOne({ headline: row.title, body: ex.text, mode: 'fulltext' });
    if (res.ok) row.fulltext = scoreRecord(res, 'fulltext', { chars: ex.chars });
    else row.fulltextError = { ...errorRecord(res, 'score'), chars: ex.chars };
  });
  for (const row of flagged) {
    row.escalation.outcome = escalationOutcome(row.sweep.verdict, row.fulltext?.verdict || null);
  }

  const id = runIdFor(startedAt);
  for (const row of rows) {
    row.final = finalize(row);
    if (isFreshRow(row)) row.writtenIn = id;
  }
  // The article body is never stored; the summary snippet is dropped too.
  for (const row of rows) delete row.summary;
  const delta = {
    rows: rows.filter(isFreshRow),
    carried: rows.filter((r) => !isFreshRow(r)).map((r) => ({ id: r.id, run: r.writtenIn })),
  };

  const finishedMs = now();
  const summary = summarizeRun({ rows, feeds: collected.feeds });
  const run = {
    id,
    startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: finishedMs - startedMs,
    methodology: METHODOLOGY,
    model,
    promptHashes: hashes,
    dryRun,
    config: { thinking: THINKING, effort: EFFORT, bodyChars: BODY_CHARS, reuseWindowHours: REUSE_WINDOW_HOURS, pricing: PRICING },
    feeds: collected.feeds,
    summary,
  };
  log(`[signal] done in ${run.durationMs} ms · ${summary.rows.scored}/${summary.rows.total} scored · ${delta.rows.length} fresh row(s), ${delta.carried.length} carried · $${summary.costUsd}`);
  return { run, rows, delta };
}
