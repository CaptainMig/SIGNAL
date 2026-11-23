// ---------------------------------------------------------------------------
// Per-run summary computed from the run's rows and feed statuses. This is
// what history.csv records (one row per run) and what latest.json carries as
// `summary`. Pure; every number is derived from the ledger rows alone.
// ---------------------------------------------------------------------------
import { DISPLAY_VERDICTS } from './verdicts.js';
import {
  articleIntegrityV1,
  articleIntegrityV2,
  coverage,
  framingIntegrityV1,
  framingIntegrityV2,
  hasText,
  isScored,
  meanOf,
  outletBalancedV2,
} from './integrity.js';
import { addUsage, costOf, emptyUsage } from './pricing.js';

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export function summarizeRun({ rows, feeds }) {
  const feedCounts = { total: feeds.length, live: 0, stale: 0, blocked: 0, dead: 0 };
  for (const f of feeds) feedCounts[f.status] = (feedCounts[f.status] || 0) + 1;

  const verdicts = Object.fromEntries(DISPLAY_VERDICTS.map((v) => [v, 0]));
  let unscored = 0;
  let fulltextRows = 0;
  let feedRows = 0;
  let toneRows = 0;
  let usage = emptyUsage();
  let calls = 0;
  let slamFlagged = 0;

  const esc = {
    eligible: 0,
    attempted: 0,
    confirmed: 0,
    cleared: 0,
    pending: 0,
    blocked: 0,
    timeout: 0,
    error: 0,
    bySweep: { PROVISIONAL: { confirmed: 0, cleared: 0, pending: 0 }, CONTESTED: { confirmed: 0, cleared: 0, pending: 0 } },
  };

  const v1 = [];
  const v2 = [];
  const sens = [];
  const click = [];
  const fid = [];

  for (const r of rows) {
    if (r.slam?.matched) slamFlagged++;
    for (const s of [r.sweep, r.fulltext]) {
      if (s?.usage) {
        usage = addUsage(usage, s.usage);
        calls++;
      }
    }
    // Failed calls still cost tokens sometimes (e.g. refusal) — count them.
    for (const e of [r.sweepError, r.fulltextError]) {
      if (e?.usage) {
        usage = addUsage(usage, e.usage);
        calls++;
      }
    }

    if (!isScored(r)) {
      unscored++;
      continue;
    }
    const f = r.final;
    if (f.source === 'fulltext') fulltextRows++;
    else if (f.source === 'tone') toneRows++;
    else feedRows++;
    if (f.verdict) verdicts[f.verdict] = (verdicts[f.verdict] || 0) + 1;

    sens.push(f.sens);
    click.push(f.click);
    if (f.fidelity != null) fid.push(f.fidelity);
    v1.push(articleIntegrityV1(f, { thinBody: r.thinBody }));
    v2.push(articleIntegrityV2(f));

    if (r.escalation?.eligible) {
      esc.eligible++;
      const sv = r.escalation.sweepVerdict;
      const bucket = esc.bySweep[sv];
      if (r.fulltext || r.fulltextError) esc.attempted++;
      const outcome = r.escalation.outcome || 'pending';
      esc[outcome]++;
      if (bucket) bucket[outcome]++;
      if (outcome === 'pending' && r.fulltextError) {
        if (r.fulltextError.reason === 'blocked') esc.blocked++;
        else if (r.fulltextError.reason === 'timeout') esc.timeout++;
        else esc.error++;
      }
    }
  }

  const fi2 = framingIntegrityV2(rows);
  const fi1 = framingIntegrityV1(rows);
  const bal = outletBalancedV2(rows);
  const cov = coverage(rows);
  const scoredRows = rows.length - unscored;

  return {
    rows: { total: rows.length, scored: scoredRows, unscored, fulltext: fulltextRows, feedSummary: feedRows, headlineOnly: toneRows, withText: fi2.n },
    feeds: feedCounts,
    verdicts,
    framingIntegrity: {
      v1: fi1.value,
      v2Low: fi2.low,
      v2High: fi2.high,
      v2Point: fi2.point,
      v2N: fi2.n,
      provisionalPending: fi2.provisional,
      outletBalanced: bal.value,
      outletsRanked: bal.outlets,
    },
    coverage: cov.value,
    integrity: { meanV1: meanOf(v1), meanV2: meanOf(v2) },
    axes: { fidelity: meanOf(fid), sens: meanOf(sens), click: meanOf(click) },
    slam: { flagged: slamFlagged, index: rows.length ? round1((100 * slamFlagged) / rows.length) : null },
    escalation: esc,
    usage: { ...usage, calls },
    costUsd: costOf(usage),
  };
}

// Flatten a summary + run meta into the history.csv record (see ledger.js for
// the frozen column order).
export function historyRecord(run) {
  const s = run.summary;
  return {
    run_id: run.id,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    duration_ms: run.durationMs,
    methodology: run.methodology,
    model: run.model,
    prompt_hash_sweep: run.promptHashes.sweep,
    prompt_hash_fulltext: run.promptHashes.fulltext,
    prompt_hash_tone: run.promptHashes.tone,
    feeds_total: s.feeds.total,
    feeds_live: s.feeds.live,
    feeds_stale: s.feeds.stale,
    feeds_blocked: s.feeds.blocked,
    feeds_dead: s.feeds.dead,
    rows_total: s.rows.total,
    rows_scored: s.rows.scored,
    rows_unscored: s.rows.unscored,
    rows_fulltext: s.rows.fulltext,
    rows_feed_summary: s.rows.feedSummary,
    rows_headline_only: s.rows.headlineOnly,
    verified: s.verdicts.VERIFIED,
    contextual: s.verdicts.CONTEXTUAL,
    contested: s.verdicts.CONTESTED,
    unverifiable: s.verdicts.UNVERIFIED,
    provisional: s.verdicts.PROVISIONAL,
    misleading: s.verdicts.MISLEADING,
    fi_v1: s.framingIntegrity.v1,
    fi_v2_low: s.framingIntegrity.v2Low,
    fi_v2_high: s.framingIntegrity.v2High,
    fi_v2_n: s.framingIntegrity.v2N,
    fi_v2_outlet_balanced: s.framingIntegrity.outletBalanced,
    coverage_pct: s.coverage,
    mean_integrity_v1: s.integrity.meanV1,
    mean_integrity_v2: s.integrity.meanV2,
    avg_fidelity: s.axes.fidelity,
    avg_sensationalism: s.axes.sens,
    avg_clickbait: s.axes.click,
    slam_flagged: s.slam.flagged,
    slam_index: s.slam.index,
    esc_eligible: s.escalation.eligible,
    esc_attempted: s.escalation.attempted,
    esc_confirmed: s.escalation.confirmed,
    esc_cleared: s.escalation.cleared,
    esc_pending: s.escalation.pending,
    esc_blocked: s.escalation.blocked,
    esc_timeout: s.escalation.timeout,
    tokens_input: s.usage.input,
    tokens_output: s.usage.output,
    tokens_cache_read: s.usage.cacheRead,
    tokens_cache_write: s.usage.cacheWrite,
    model_calls: s.usage.calls,
    cost_usd: s.costUsd,
  };
}
