#!/usr/bin/env node
// Daily report from history.csv (DEFECTS.md v2-16): runs, rows, tokens, cost
// and Framing Integrity per UTC day.  node scripts/report-daily.js [--json] [--root DIR]
import { promises as fs } from 'node:fs';
import { parseCsv } from '../site/csv.js';
import { ledgerPaths } from '../pipeline/ledger.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

export function dailyReport(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = String(r.started_at || '').slice(0, 10);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const mean = (xs) => {
    const v = xs.filter((x) => x != null && Number.isFinite(x));
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };
  const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, rs]) => ({
    day,
    runs: rs.length,
    complete: rs.length >= 24,
    rows_mean: mean(rs.map((r) => r.rows_total)),
    rows_scored_mean: mean(rs.map((r) => r.rows_scored)),
    unscored_total: sum(rs.map((r) => r.rows_unscored)),
    model_calls: sum(rs.map((r) => r.model_calls)),
    tokens_input: sum(rs.map((r) => r.tokens_input)),
    tokens_output: sum(rs.map((r) => r.tokens_output)),
    tokens_cache_read: sum(rs.map((r) => r.tokens_cache_read)),
    cost_usd: Math.round(sum(rs.map((r) => r.cost_usd)) * 1e4) / 1e4,
    cost_per_run_usd: Math.round((sum(rs.map((r) => r.cost_usd)) / rs.length) * 1e4) / 1e4,
    fi_v2_low_mean: mean(rs.map((r) => r.fi_v2_low)),
    fi_v2_high_mean: mean(rs.map((r) => r.fi_v2_high)),
    coverage_mean: mean(rs.map((r) => r.coverage_pct)),
    feeds_live_mean: mean(rs.map((r) => r.feeds_live)),
  }));
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, '/'));
if (invokedDirectly) {
  const root = String(arg('--root', '.'));
  const text = await fs.readFile(ledgerPaths(root).history, 'utf8').catch(() => '');
  const report = dailyReport(parseCsv(text));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('day        runs  rows  scored  unscored  calls   tokens in/out/cache        cost     $/run   FI v2 low–high  coverage');
    for (const d of report) {
      console.log(
        `${d.day}  ${String(d.runs).padStart(4)}${d.complete ? '' : '*'}  ${String(d.rows_mean ?? '—').padStart(4)}  ${String(d.rows_scored_mean ?? '—').padStart(6)}  ${String(d.unscored_total).padStart(8)}  ${String(d.model_calls).padStart(5)}   ${String(d.tokens_input).padStart(7)}/${String(d.tokens_output).padEnd(7)}/${String(d.tokens_cache_read).padEnd(9)}  $${d.cost_usd.toFixed(4)}  $${d.cost_per_run_usd.toFixed(4)}   ${d.fi_v2_low_mean ?? '—'}–${d.fi_v2_high_mean ?? '—'}%        ${d.coverage_mean ?? '—'}%`
      );
    }
    if (report.some((d) => !d.complete)) console.log('* fewer than 24 runs recorded for that day');
  }
}
