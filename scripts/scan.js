#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Scheduled scan entry point (GitHub Actions, hourly). Runs the pipeline and
// writes the ledger. Never runs in a browser; the API key is read from the
// environment here and nowhere else.
//
//   node scripts/scan.js [--dry-run] [--limit N] [--root DIR] [--report FILE]
//
// --dry-run  fetches and dedupes feeds, writes a run with every row UNSCORED
//            (reason dry_run), and spends no tokens.
// --report   also writes a Markdown run report (per-feed HTTP status, rows
//            scored vs unscored by reason, tokens, cost, one raw model
//            response) — the Actions job appends it to the step summary.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import { runScan, REUSE_WINDOW_HOURS } from '../pipeline/run.js';
import { createClient, createScorer } from '../pipeline/scorer.js';
import { appendHistory, appendStats, countHistoryRuns, readDaily, readLatest, readRecentScans, resolveRuns, writeAggregate, writeDaily, writeLatest, writeScan } from '../pipeline/ledger.js';
import { updateDaily } from '../pipeline/daily.js';
import { refreshAgreement } from '../pipeline/validation.js';
import { historyRecord, statsRecord } from '../pipeline/summarize.js';
import { computeAggregate, WINDOW_HOURS } from '../pipeline/aggregate.js';
import { readBaseline, readGoldenSet, writeBaselineIfAbsent } from '../pipeline/golden.js';
import { buildScorecards } from '../pipeline/scorecards.js';
import { GOLDEN_EVERY_N_RUNS, SCORECARD_WINDOW_DAYS } from '../pipeline/config.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const dryRun = process.argv.includes('--dry-run');
const limit = Number(arg('--limit', 0)) || 0;
const root = String(arg('--root', '.'));
const reportPath = arg('--report', null);
const log = (m) => console.log(m);

const fmtRange = (a, b) => (a == null || b == null ? '—' : `${a}–${b}`);

// Markdown run report. Nothing in it is article text: feed status, counts,
// tokens, and the model's own JSON output for one headline.
export function renderReport({ run, rows, scorer, paths }) {
  const s = run.summary;
  const fi = s.framingIntegrity;
  const L = [];
  L.push(`# Signal scan ${run.id}${run.dryRun ? ' (dry run)' : ''}`);
  L.push('');
  L.push(`Started ${run.startedAt} · finished ${run.finishedAt} · ${run.durationMs} ms · model \`${run.model}\` · thinking \`${run.config.thinking}\` · effort \`${run.config.effort}\``);
  L.push(`Prompt hashes: sweep \`${run.promptHashes.sweep}\` · fulltext \`${run.promptHashes.fulltext}\` · tone \`${run.promptHashes.tone}\``);
  L.push('');
  L.push('## Feeds');
  L.push('');
  L.push(`${s.feeds.live}/${s.feeds.total} live · ${s.feeds.stale} stale · ${s.feeds.blocked} blocked · ${s.feeds.dead} dead`);
  L.push('');
  L.push('| Feed | Status | HTTP | Fetched | Kept | Stale | Malformed | Dupes | Excluded | ms | Reason |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const f of run.feeds) {
    L.push(`| ${f.name} | ${f.status} | ${f.httpStatus ?? '—'} | ${f.fetched} | ${f.kept} | ${f.stale} | ${f.malformed} | ${f.dupes} | ${f.excluded ?? 0} | ${f.ms} | ${f.reason || ''} |`);
  }
  const blocked = run.feeds.filter((f) => f.status === 'blocked');
  if (blocked.length) {
    L.push('');
    L.push(`**Blocked feeds (publisher refused the runner):** ${blocked.map((f) => `${f.name} (${f.reason})`).join(', ')}. Not dropped: listed in run health.`);
  }
  L.push('');
  L.push('## Rows');
  L.push('');
  L.push(`${s.rows.total} after dedupe · **${s.rows.scored} scored** (${s.rows.fulltext} full text, ${s.rows.feedSummary} feed summary, ${s.rows.headlineOnly} headline only) · **${s.rows.unscored} unscored**`);
  const reasons = {};
  for (const r of rows) if (r.final?.source === 'unscored') reasons[r.final.reason] = (reasons[r.final.reason] || 0) + 1;
  if (Object.keys(reasons).length) L.push(`Unscored by reason: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const carried = rows.filter((r) => r.sweep?.carriedFrom).length;
  if (carried) L.push(`Carried forward from prior runs: ${carried} sweep score(s); the scan file holds ${rows.length - carried} full row(s) and ${carried} reference(s)`);
  L.push('');
  L.push(`Verdicts: ${Object.entries(s.verdicts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  L.push(`Framing Integrity · broad ${fmtRange(fi.broad?.low, fi.broad?.high)}% (95% CI ${fmtRange(fi.broad?.ci?.lo, fi.broad?.ci?.hi)}, balanced ${fi.broad?.balanced?.value ?? '—'}% over ${fi.broad?.balanced?.qualified ?? 0} outlets) · strict ${fmtRange(fi.strict?.low, fi.strict?.high)}% (95% CI ${fmtRange(fi.strict?.ci?.lo, fi.strict?.ci?.hi)}) · n ${fi.broad?.n ?? 0} · unresolved ${fi.unresolved ?? 0} · v1 ${fi.v1 ?? '—'}% · coverage ${s.coverage ?? '—'}%`);
  L.push(`Escalation: ${s.escalation.eligible} eligible · ${s.escalation.attempted} attempted · ${s.escalation.confirmed} confirmed · ${s.escalation.cleared} cleared · ${s.escalation.reclassified} reclassified · ${s.escalation.pending} pending · ${s.escalation.unresolved} unresolved (${s.escalation.blocked} blocked, ${s.escalation.timeout} timeout)`);
  L.push(`Audit: ${s.audit.sampledThisRun} sampled this run · ${s.audit.present} present · ${s.audit.scored} scored · ${s.audit.overturned} overturned (${s.audit.overturnPct ?? '—'}%) · ${s.audit.changed} changed`);
  L.push(`Extraction: ${s.extraction.successes}/${s.extraction.attempts} fetched (${s.extraction.successPct ?? '—'}%)`);
  if (s.slam.test) {
    const t = s.slam.test;
    L.push(`Slam: index ${s.slam.index ?? '—'}% · ${t.underpowered ? `underpowered (${t.nFlagged} flagged)` : `gap ${t.observedDiff} (CI ${fmtRange(t.ci.lo, t.ci.hi)}), p = ${t.p}, within-outlet permutation, consistency check`}`);
  }
  if (s.golden) {
    const g = s.golden;
    L.push(`Golden set: ${g.scored}/${g.n} scored · agreement vs baseline ${g.agreementPct ?? '— (baseline written this run)'}% · vs authoring intent ${g.expectedAgreementPct ?? '—'}% · drift F ${g.fidelityDrift ?? '—'} S ${g.sensDrift ?? '—'} C ${g.clickDrift ?? '—'}${g.alert ? ' · **ALERT**' : ''} · $${g.costUsd}`);
  }
  L.push('');
  L.push('## Tokens and cost');
  L.push('');
  L.push('| Calls | Input | Output | Cache read | Cache write | Cost (USD, est.) |');
  L.push('|---|---|---|---|---|---|');
  L.push(`| ${s.usage.calls} | ${s.usage.input} | ${s.usage.output} | ${s.usage.cacheRead} | ${s.usage.cacheWrite} | ${s.costUsd} |`);
  L.push('');
  L.push('## One raw model response');
  L.push('');
  const sample = scorer?.samples?.[0];
  if (sample) {
    L.push(`Headline: ${sample.headline}`);
    L.push(`Mode: ${sample.mode} · served by \`${sample.model}\` · stop_reason \`${sample.stopReason}\` · ${sample.latencyMs} ms · tokens in ${sample.usage.input} / out ${sample.usage.output} / cache read ${sample.usage.cacheRead}`);
    L.push('');
    L.push('```json');
    L.push(sample.text);
    L.push('```');
  } else {
    L.push('_No model call was made (dry run or every call failed before a response)._');
  }
  L.push('');
  L.push('## Files');
  L.push('');
  for (const p of paths) L.push(`- \`${p}\``);
  L.push('');
  return L.join('\n');
}

async function main() {
  let scorer = null;
  if (!dryRun) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[signal] ANTHROPIC_API_KEY is not set (use --dry-run to skip scoring)');
      process.exit(1);
    }
    scorer = createScorer({ client: createClient() });
  }

  const now = Date.now();
  const reuseMs = REUSE_WINDOW_HOURS * 60 * 60 * 1000;
  const windowMs = Math.max(reuseMs, SCORECARD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // Scan files are deltas; resolve carried references against the window and
  // the previous full view before carry-forward, scorecards and aggregation.
  const previousLatest = await readLatest({ root });
  const window = resolveRuns(await readRecentScans({ root, now, windowMs }), { latest: previousLatest });
  const priorRuns = window.filter((r) => Date.parse(r.startedAt) >= now - reuseMs);

  // Golden set: scored on the configured cadence; the baseline is written once.
  const runIndex = await countHistoryRuns({ root });
  let golden = null;
  if (!dryRun) {
    try {
      golden = { set: await readGoldenSet({ root }), baseline: await readBaseline({ root }), every: GOLDEN_EVERY_N_RUNS };
    } catch (e) {
      log(`[signal] golden set unavailable: ${e.message}`);
    }
  }

  const { run, rows, delta, goldenReport } = await runScan({ scorer, priorRuns, limit, log, golden, runIndex });

  const paths = [];
  paths.push(await writeScan(run, delta, { root }));
  paths.push(await appendHistory(historyRecord(run), { root }));
  paths.push(await appendStats(statsRecord(run), { root }));
  if (goldenReport && !golden?.baseline) {
    const written = await writeBaselineIfAbsent({ runId: run.id, writtenAt: run.finishedAt, version: goldenReport.version, model: goldenReport.model, promptHash: goldenReport.promptHash, results: goldenReport.results }, { root });
    if (written) log('[signal] golden baseline written (first scoring run)');
  }

  const after = Date.now();
  const allRuns = resolveRuns(await readRecentScans({ root, now: after, windowMs }), { latest: { rows } });
  const scorecards = buildScorecards(allRuns.filter((r) => Date.parse(r.startedAt) >= after - SCORECARD_WINDOW_DAYS * 86400e3));
  paths.push(await writeLatest({ ...run, scorecards }, rows, { root }));
  const recent = allRuns.filter((r) => Date.parse(r.startedAt) >= after - WINDOW_HOURS * 60 * 60 * 1000);
  paths.push(await writeAggregate(computeAggregate(recent, { now: after }), { root }));
  // Daily tone summary for the site's tone trail: recompute the days the
  // reuse window covers, keep older days as recorded.
  paths.push(await writeDaily(updateDaily(await readDaily({ root }), allRuns.filter((r) => Date.parse(r.startedAt) >= after - reuseMs), { now: after }), { root }));
  // Human validation agreement, from any labels files committed since.
  const agreement = await refreshAgreement({ root });
  if (agreement) log(`[signal] validation: ${agreement.statement} (${agreement.complete} complete of ${agreement.minReviewers})`);

  log(`[signal] wrote ${paths.join(', ')}`);
  const s = run.summary;
  const fi = s.framingIntegrity;
  log(
    `[signal] FI broad ${fmtRange(fi.broad?.low, fi.broad?.high)}% strict ${fmtRange(fi.strict?.low, fi.strict?.high)}% (n ${fi.broad?.n}) · v1 ${fi.v1 ?? '—'}% · coverage ${s.coverage ?? '—'}% · feeds ${s.feeds.live}/${s.feeds.total} live (${s.feeds.blocked} blocked) · tokens ${s.usage.input}/${s.usage.output} · $${s.costUsd}`
  );

  if (reportPath) {
    const report = renderReport({ run, rows, scorer, paths });
    await fs.writeFile(String(reportPath), report);
    log(`[signal] report written to ${reportPath}`);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, '/'));
if (invokedDirectly) {
  main().catch((e) => {
    console.error('[signal] fatal:', e);
    process.exit(1);
  });
}
