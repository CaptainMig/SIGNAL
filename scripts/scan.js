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
import { appendHistory, readRecentScans, writeAggregate, writeLatest, writeScan } from '../pipeline/ledger.js';
import { historyRecord } from '../pipeline/summarize.js';
import { computeAggregate, WINDOW_HOURS } from '../pipeline/aggregate.js';

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

// Markdown run report. Nothing in it is article text: feed status, counts,
// tokens, and the model's own JSON output for one headline.
export function renderReport({ run, rows, scorer, paths }) {
  const s = run.summary;
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
  L.push('| Feed | Status | HTTP | Fetched | Kept | Stale | Malformed | Dupes | ms | Reason |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const f of run.feeds) {
    L.push(`| ${f.name} | ${f.status} | ${f.httpStatus ?? '—'} | ${f.fetched} | ${f.kept} | ${f.stale} | ${f.malformed} | ${f.dupes} | ${f.ms} | ${f.reason || ''} |`);
  }
  const blocked = run.feeds.filter((f) => f.status === 'blocked');
  if (blocked.length) {
    L.push('');
    L.push(`**Blocked feeds (publisher refused the runner):** ${blocked.map((f) => `${f.name} (${f.reason})`).join(', ')}. Not dropped: listed in run health. Candidate fixes: a Google News \`site:\` fallback feed, or a fetch from the Vercel edge.`);
  }
  L.push('');
  L.push('## Rows');
  L.push('');
  L.push(`${s.rows.total} after dedupe · **${s.rows.scored} scored** (${s.rows.fulltext} full text, ${s.rows.feedSummary} feed summary, ${s.rows.headlineOnly} headline only) · **${s.rows.unscored} unscored**`);
  const reasons = {};
  for (const r of rows) if (r.final?.source === 'unscored') reasons[r.final.reason] = (reasons[r.final.reason] || 0) + 1;
  if (Object.keys(reasons).length) L.push(`Unscored by reason: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const carried = rows.filter((r) => r.sweep?.carriedFrom).length;
  if (carried) L.push(`Carried forward from prior runs: ${carried} sweep score(s)`);
  L.push('');
  L.push(`Verdicts: ${Object.entries(s.verdicts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  L.push(`Framing Integrity v2 ${s.framingIntegrity.v2Low ?? '—'}–${s.framingIntegrity.v2High ?? '—'}% (n ${s.framingIntegrity.v2N}) · outlet-balanced ${s.framingIntegrity.outletBalanced ?? '—'}% · v1 ${s.framingIntegrity.v1 ?? '—'}% · coverage ${s.coverage ?? '—'}%`);
  L.push(`Escalation: ${s.escalation.eligible} eligible · ${s.escalation.attempted} attempted · ${s.escalation.confirmed} confirmed · ${s.escalation.cleared} cleared · ${s.escalation.pending} pending (${s.escalation.blocked} blocked, ${s.escalation.timeout} timeout)`);
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
  const priorRuns = await readRecentScans({ root, now, windowMs: REUSE_WINDOW_HOURS * 60 * 60 * 1000 });
  const { run, rows } = await runScan({ scorer, priorRuns, limit, log });

  const scanPath = await writeScan(run, rows, { root });
  const historyPath = await appendHistory(historyRecord(run), { root });
  const latestPath = await writeLatest(run, rows, { root });
  const recent = await readRecentScans({ root, now: Date.now(), windowMs: WINDOW_HOURS * 60 * 60 * 1000 });
  const aggregatePath = await writeAggregate(computeAggregate(recent), { root });
  const paths = [scanPath, historyPath, latestPath, aggregatePath];

  log(`[signal] wrote ${paths.join(', ')}`);
  const s = run.summary;
  log(
    `[signal] FI v2 ${s.framingIntegrity.v2Low ?? '—'}–${s.framingIntegrity.v2High ?? '—'}% (n ${s.framingIntegrity.v2N}) · v1 ${s.framingIntegrity.v1 ?? '—'}% · coverage ${s.coverage ?? '—'}% · feeds ${s.feeds.live}/${s.feeds.total} live (${s.feeds.blocked} blocked) · tokens ${s.usage.input}/${s.usage.output} · $${s.costUsd}`
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
