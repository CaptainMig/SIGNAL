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
import { DEFAULT_PACK, EXTRACT_CONCURRENCY, EXTRACT_MAX_ATTEMPTS, EXTRACT_TIMEOUT_MS, FEEDS, METHODOLOGY, MODEL, PRICING, THINKING, EFFORT, BODY_CHARS, GOLDEN_EVERY_N_RUNS, PACKS, packOf } from './config.js';
import { collectHeadlines } from './feeds.js';
import { detectSlam } from './slam.js';
import { fetchArticle, isVideoUrl } from './extract.js';
import { createRobotsChecker } from './robots.js';
import { bylineOf } from './bylines.js';
import { rowFingerprint } from './fingerprint.js';
import { hostOf } from './feeds.js';
import { auditResult, auditSampleSize, escalationOutcome, escalationReason, pickAuditRows } from './escalate.js';
import { summarizeRun } from './summarize.js';
import { promptHash } from './prompt.js';
import { compareGolden, scoreGoldenSet } from './golden.js';

export const REUSE_WINDOW_HOURS = 48;

// True when the previous run started less than `gapMs` before `now`: the
// external trigger and the GitHub cron can both fire in one hour, and a
// second scan would re-score nothing new at full cost.
export function tooSoon(previousLatest, now, gapMs) {
  const t = Date.parse(previousLatest?.startedAt || '');
  if (!Number.isFinite(t) || !(gapMs > 0)) return false;
  return now - t < gapMs;
}

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
  } else if (prior.fulltextError) {
    // Every extraction failure is carried with its attempt count; the retry
    // policy (EXTRACT_MAX_ATTEMPTS) decides whether this run tries again.
    out.fulltextError = { ...prior.fulltextError, attempts: prior.fulltextError.attempts || 1, carriedFrom: prior.fulltextError.carriedFrom || entry.runId };
  }
  if (prior.audit) out.audit = true;
  if (prior.extraction && (out.fulltext || out.fulltextError)) out.extraction = prior.extraction;
  // A byline read from the article page is kept with the carried score.
  if (prior.byline?.source === 'article' && out.fulltext) out.byline = prior.byline;
  // A fingerprint of the article text is kept with the carried full-text score.
  if (prior.fp?.source === 'fulltext' && out.fulltext) out.fp = prior.fp;
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
  maxAttempts = EXTRACT_MAX_ATTEMPTS,
  robots = null, // createRobotsChecker(...); built from `fetch` when absent
  golden = null, // { set, baseline, every } — scored when runIndex % every === 0
  runIndex = 0,
  auditSize = null, // override the audit sample size (tests); null = schedule
} = {}) {
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const id = runIdFor(startedAt);
  const hashes = { sweep: promptHash('sweep'), fulltext: promptHash('fulltext'), tone: promptHash('tone') };
  const dryRun = !scorer;

  log(`[signal] run ${runIdFor(startedAt)} started (${dryRun ? 'dry run' : model})`);
  const collected = await collectHeadlines({ feeds, fetch, now: startedMs });
  const feedByName = new Map(feeds.map((f) => [f.name, f]));
  let rows = collected.rows.map(({ authors, ...r }) => {
    const feed = feedByName.get(r.publication);
    const outlet = feed?.outlet || r.publication;
    return {
      ...r,
      slam: detectSlam(r.title),
      // Byline from the feed; the article page's structured data fills it in
      // when the article is fetched and the feed gave none.
      byline: bylineOf({ outlet, names: authors || [], source: 'feed' }),
      sweep: null,
      sweepError: null,
      fulltext: null,
      fulltextError: null,
      outlet,
      // Every row belongs to exactly one pack; nothing is blended across packs.
      pack: packOf(feed),
      metro: feed?.metro || null,
      // Two timestamps (schema brief §2): the publisher's own, flagged when
      // it is really an aggregator's, and the run clock at first sighting.
      timestampSource: hostOf(feed?.url || '') === 'news.google.com' ? 'aggregator' : 'feed',
      firstSeen: startedAt,
      firstSeenRun: id,
      pubDateChanged: false,
      // Fingerprint (schema brief §1) from the text already in hand; the
      // article text replaces it at escalation. Never the text itself.
      fp: rowFingerprint({ title: r.title, text: r.thinBody ? '' : r.summary || '', source: r.thinBody || !r.summary ? 'title' : 'summary' }),
      escalation: { eligible: false, reason: null, sweepVerdict: null, outcome: null, unresolved: false, attempts: 0 },
      final: null,
    };
  });
  if (limit > 0) rows = rows.slice(0, limit);
  const live = collected.feeds.filter((f) => f.status === 'live').length;
  log(`[signal] feeds: ${live}/${collected.feeds.length} live · ${rows.length} rows after dedupe`);

  // Carry-forward from prior runs.
  const prior = indexPriorRows(priorRuns);
  let carried = 0;
  for (const row of rows) {
    const entry = prior.get(row.id);
    if (entry) {
      // First sighting is the earliest run that saw this id; rows written
      // before this field existed get the run they were last written in.
      const p = entry.row;
      row.firstSeen = p.firstSeen || `${entry.runId}:00:00.000Z`;
      row.firstSeenRun = p.firstSeenRun || entry.runId;
      if (p.pubDate && row.pubDate && p.pubDate !== row.pubDate) {
        row.pubDateChanged = true;
        row.pubDateFirst = p.pubDateFirst || p.pubDate;
      } else if (p.pubDateChanged) {
        row.pubDateChanged = true;
        row.pubDateFirst = p.pubDateFirst;
      }
    }
    const reuse = reusable(entry, row, hashes, model);
    if (reuse?.sweep) {
      row.sweep = reuse.sweep;
      carried++;
    }
    if (reuse?.fulltext) row.fulltext = reuse.fulltext;
    if (reuse?.fulltextError) row.fulltextError = reuse.fulltextError;
    if (reuse?.extraction) row.extraction = reuse.extraction;
    if (reuse?.byline && row.byline.source === 'none') row.byline = reuse.byline;
    if (reuse?.fp) row.fp = reuse.fp;
    if (reuse?.audit) row.audit = true;
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

  // Escalation: flagged sweep rows (PROVISIONAL, CONTESTED, low-fidelity
  // CONTEXTUAL) get the article body and a full-text score.
  for (const row of rows) {
    const reason = escalationReason(row.sweep);
    if (reason) row.escalation = { eligible: true, reason, sweepVerdict: row.sweep.verdict, outcome: null, unresolved: false, attempts: row.fulltextError?.attempts || 0 };
  }
  // Audit sample: seeded, stratified sweep VERIFIED / CONTEXTUAL rows, the
  // only check on what the sweep does not flag (DEFECTS.md v2-8, v2-14).
  const auditIds = dryRun ? new Set() : new Set(pickAuditRows(rows, { runId: id, size: auditSize ?? auditSampleSize(startedAt) }));
  let auditSampled = 0;
  for (const row of rows) {
    if (auditIds.has(row.id)) {
      row.audit = true;
      row.auditSampledIn = id;
      auditSampled++;
    }
  }
  const flagged = rows.filter((r) => r.escalation.eligible);
  const wantsText = rows.filter((r) => r.escalation.eligible || r.audit);
  const newExtraction = () => ({ attempts: 0, successes: 0, byOutlet: {}, reasons: {}, routes: {}, skipped: { video: 0, robots: 0 } });
  const robotsChecker = robots || createRobotsChecker({ fetch });
  // Extraction telemetry is kept per pack (an aggregate, never blended).
  const extractionByPack = {};
  const extractionFor = (row) => (extractionByPack[packOf(row)] ||= newExtraction());
  // Video pages carry no article text: known from the URL, never fetched,
  // counted beside the rate, final on the first sighting (DEFECTS.md v2-35).
  if (!dryRun) {
    for (const row of wantsText) {
      if (row.fulltext || row.fulltextError || !isVideoUrl(row.link)) continue;
      row.fulltextError = { reason: 'no_article', detail: 'video page', stage: 'extract', chars: null, attempts: maxAttempts, at: new Date(now()).toISOString() };
      extractionFor(row).skipped.video++;
    }
  }
  // Retry policy: a failed fetch is retried on later runs until maxAttempts
  // total, then the row is UNRESOLVED (DEFECTS.md v2-15). A video page and a
  // paywall teaser are final at once: nothing about them changes hourly.
  const finalNow = (e) => e && (e.reason === 'no_article' || (e.reason === 'blocked' && (e.detail === 'paywall' || /^robots\.txt/.test(e.detail || ''))));
  const toEscalate = dryRun ? [] : wantsText.filter((r) => !r.fulltext && !finalNow(r.fulltextError) && (r.fulltextError?.attempts || 0) < maxAttempts);
  const videoSkipped = Object.values(extractionByPack).reduce((a, e) => a + e.skipped.video, 0);
  if (toEscalate.length) log(`[signal] escalating ${toEscalate.length} row(s) to full text (${auditSampled} audit${videoSkipped ? `, ${videoSkipped} video page(s) skipped` : ''})`);
  const timeoutFor = (row) => feeds.find((f) => f.name === row.publication)?.extractTimeoutMs || EXTRACT_TIMEOUT_MS;
  const count = (bag, key) => (bag[key] = (bag[key] || 0) + 1);
  await pool(toEscalate, extractConcurrency, async (row) => {
    const priorAttempts = row.fulltextError?.attempts || 0;
    row.fulltextError = null;
    const extraction = extractionFor(row);
    extraction.attempts++;
    const o = (extraction.byOutlet[row.outlet] ||= { attempts: 0, successes: 0, reasons: {}, routes: {} });
    o.attempts++;
    // robots.txt first: a publisher that disallows Signal, or refuses to
    // serve its robots.txt, is SOURCE BLOCKED without a fetch.
    const rb = await robotsChecker.check(row.link);
    let ex;
    let tried;
    if (rb.allowed) {
      ex = await fetchArticle(row.link, { fetch, timeoutMs: timeoutFor(row) });
      tried = ['robots', ...(ex.tried || [])];
    } else {
      ex = { ok: false, reason: rb.reason, detail: rb.detail, attempts: 0, ms: 0 };
      tried = ['robots'];
      if (rb.reason === 'blocked') extraction.skipped.robots++;
    }
    if (!ex.ok) {
      const key = ex.detail && ex.detail !== ex.reason && /^(HTTP \d+|paywall|stub|consent wall|video page|robots\.txt disallows|robots\.txt refused \(HTTP \d+\))$/.test(ex.detail) ? `${ex.reason}:${ex.detail}` : ex.reason;
      count(extraction.reasons, key);
      count(o.reasons, key);
      row.fulltextError = { reason: ex.reason, detail: ex.detail, stage: 'extract', chars: ex.chars ?? null, attempts: finalNow(ex) ? maxAttempts : priorAttempts + 1, at: new Date(now()).toISOString() };
      row.extraction = { route: null, tried, fetches: ex.attempts || 0, ms: ex.ms ?? null };
      return;
    }
    extraction.successes++;
    o.successes++;
    count(extraction.routes, ex.route);
    count(o.routes, ex.route);
    row.extraction = { route: ex.route, tried, fetches: ex.attempts || 1, ms: ex.ms ?? null, source: ex.source || 'markup' };
    if (row.byline.source === 'none' && ex.authors?.length) row.byline = bylineOf({ outlet: row.outlet, names: ex.authors, source: 'article' });
    row.fp = rowFingerprint({ title: row.title, text: ex.text, source: 'fulltext' });
    const res = await scorer.scoreOne({ headline: row.title, body: ex.text, mode: 'fulltext' });
    if (res.ok) row.fulltext = scoreRecord(res, 'fulltext', { chars: ex.chars });
    else row.fulltextError = { ...errorRecord(res, 'score'), chars: ex.chars, attempts: priorAttempts + 1 };
  });
  for (const row of flagged) {
    const attempts = row.fulltextError?.attempts || 0;
    row.escalation.attempts = attempts;
    const exhausted = !row.fulltext && !!row.fulltextError && attempts >= maxAttempts;
    row.escalation.unresolved = exhausted;
    row.escalation.outcome = escalationOutcome(row.sweep.verdict, row.fulltext?.verdict || null, { pending: !exhausted });
  }
  for (const row of rows) {
    if (row.audit) row.auditOutcome = auditResult(row.sweep?.verdict, row.fulltext?.verdict || null);
  }

  // Golden set: frozen pairs scored for drift, on the configured cadence.
  let goldenReport = null;
  if (!dryRun && golden?.set && runIndex % (golden.every || GOLDEN_EVERY_N_RUNS) === 0) {
    log(`[signal] scoring golden set (${golden.set.items.length} items)`);
    const scored = await scoreGoldenSet(scorer, golden.set);
    goldenReport = { ...scored, runId: id, comparison: compareGolden(scored, golden.baseline || null) };
  }

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
  // One summary per pack, each from that pack's rows and feeds only. The
  // run's `summary` is the national pack's, for the original ledger; `packs`
  // carries every pack's. The golden set is a property of the scorer, not of
  // a pack, so its report rides with the national summary.
  const feedPack = (f) => packOf(feedByName.get(f.name));
  const packs = {};
  for (const pack of PACKS) {
    const packRows = rows.filter((r) => packOf(r) === pack.key);
    const packFeeds = collected.feeds.filter((f) => feedPack(f) === pack.key);
    if (!packRows.length && !packFeeds.length) continue;
    packs[pack.key] = summarizeRun({
      rows: packRows,
      feeds: packFeeds,
      runId: id,
      extraction: extractionByPack[pack.key] || newExtraction(),
      golden: pack.key === DEFAULT_PACK ? goldenReport : null,
      auditSampled: packRows.filter((r) => r.auditSampledIn === id).length,
    });
  }
  const summary = packs[DEFAULT_PACK] || summarizeRun({ rows: [], feeds: [], runId: id, extraction: newExtraction(), golden: goldenReport, auditSampled: 0 });
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
    feeds: collected.feeds.map((f) => ({ ...f, pack: feedPack(f) })),
    summary,
    packs,
    golden: goldenReport,
  };
  log(`[signal] done in ${run.durationMs} ms · ${summary.rows.scored}/${summary.rows.total} scored · ${delta.rows.length} fresh row(s), ${delta.carried.length} carried · $${summary.costUsd}`);
  return { run, rows, delta, goldenReport };
}
