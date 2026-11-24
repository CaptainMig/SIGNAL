// ---------------------------------------------------------------------------
// Per-run summary computed from the run's rows and feed statuses. This is
// what history.csv and stats.csv record (one row per run each) and what
// latest.json carries as `summary`. Pure; every number is derived from the
// ledger rows alone, seeded where resampling is involved.
// ---------------------------------------------------------------------------
import { DISPLAY_VERDICTS, MODEL_VERDICTS } from './verdicts.js';
import { OUTLET_MIN_N } from './config.js';
import {
  articleIntegrityV1,
  articleIntegrityV2,
  countsForFI,
  coverage,
  fiPoint,
  framingIntegrity,
  framingIntegrityV1,
  groupByOutlet,
  isScored,
  meanOf,
  outletBalanced,
} from './integrity.js';
import { addUsage, costOf, emptyUsage } from './pricing.js';
import { clusterBootstrap, permutationWithinOutlet } from './stats.js';
import { OUTCOMES, SWEEP_FLAGS, emptyMatrix } from './escalate.js';
import { seedFrom } from './prng.js';

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

function fiBlock(rows, definition, seed) {
  const fi = framingIntegrity(rows, definition);
  const groups = [...groupByOutlet(rows.filter(countsForFI)).values()];
  const ci = clusterBootstrap(groups, (rs) => fiPoint(rs, definition), { seed: seedFrom(seed, definition) });
  const balanced = outletBalanced(rows, definition);
  return {
    low: fi.low,
    high: fi.high,
    point: fi.point,
    n: fi.n,
    good: fi.good,
    provisional: fi.provisional,
    ci: { lo: round1(ci.lo), hi: round1(ci.hi), clusters: ci.clusters, iterations: ci.iterations },
    balanced: { value: balanced.value, qualified: balanced.qualified, outlets: balanced.outlets, minN: balanced.minN },
  };
}

export function summarizeRun({ rows, feeds, runId = 'run', extraction = null, golden = null, auditSampled = 0 }) {
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
    reclassified: 0,
    pending: 0,
    unresolved: 0,
    blocked: 0,
    timeout: 0,
    noArticle: 0,
    error: 0,
    byReason: { provisional: 0, contested: 0, low_fidelity_contextual: 0 },
    bySweep: Object.fromEntries(SWEEP_FLAGS.map((s) => [s, Object.fromEntries(OUTCOMES.map((o) => [o, 0]))])),
    matrix: emptyMatrix(),
  };
  const audit = { sampledThisRun: auditSampled, present: 0, scored: 0, changed: 0, overturned: 0, overturnPct: null, changedPct: null };

  const v1 = [];
  const v2 = [];
  const sens = [];
  const click = [];
  const fid = [];
  const slamRows = [];

  for (const r of rows) {
    if (r.slam?.matched) slamFlagged++;
    for (const s of [r.sweep, r.fulltext]) {
      if (s?.usage) {
        usage = addUsage(usage, s.usage);
        calls++;
      }
    }
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
    slamRows.push({ id: r.id, outlet: r.outlet || r.publication, flagged: !!r.slam?.matched, value: f.sens });

    if (r.escalation?.eligible) {
      esc.eligible++;
      const sv = r.escalation.sweepVerdict;
      if (r.escalation.reason && esc.byReason[r.escalation.reason] != null) esc.byReason[r.escalation.reason]++;
      if (r.fulltext || r.fulltextError) esc.attempted++;
      const outcome = r.escalation.outcome || 'pending';
      esc[outcome] = (esc[outcome] || 0) + 1;
      if (esc.bySweep[sv]) esc.bySweep[sv][outcome]++;
      if (esc.matrix[sv]) {
        if (r.fulltext?.verdict && MODEL_VERDICTS.includes(r.fulltext.verdict)) esc.matrix[sv][r.fulltext.verdict]++;
        else if (outcome === 'unresolved') esc.matrix[sv].unresolved++;
        else esc.matrix[sv].pending++;
      }
      if ((outcome === 'pending' || outcome === 'unresolved') && r.fulltextError) {
        if (r.fulltextError.reason === 'blocked') esc.blocked++;
        else if (r.fulltextError.reason === 'timeout') esc.timeout++;
        else if (r.fulltextError.reason === 'no_article') esc.noArticle++;
        else esc.error++;
      }
    }
    if (r.audit) {
      audit.present++;
      if (r.auditOutcome?.scored) {
        audit.scored++;
        if (r.auditOutcome.changed) audit.changed++;
        if (r.auditOutcome.overturned) audit.overturned++;
      }
    }
  }
  audit.overturnPct = audit.scored ? round1((100 * audit.overturned) / audit.scored) : null;
  audit.changedPct = audit.scored ? round1((100 * audit.changed) / audit.scored) : null;

  const strict = fiBlock(rows, 'strict', runId);
  const broad = fiBlock(rows, 'broad', runId);
  const unresolved = framingIntegrity(rows, 'broad').unresolved;
  const fi1 = framingIntegrityV1(rows);
  const cov = coverage(rows);
  const scoredRows = rows.length - unscored;
  const slamTest = permutationWithinOutlet(slamRows, { seed: seedFrom(runId, 'slam') });

  let goldenSummary = null;
  if (golden) {
    const c = golden.comparison || {};
    goldenSummary = {
      scored: c.scored ?? null,
      n: c.n ?? null,
      agreementPct: c.baseline?.agreementPct ?? null,
      baselineRunId: c.baseline?.runId ?? null,
      sameModel: c.baseline?.sameModel ?? null,
      samePrompt: c.baseline?.samePrompt ?? null,
      expectedAgreementPct: c.expected?.agreementPct ?? null,
      fidelityDrift: c.baseline?.fidelityDrift ?? null,
      sensDrift: c.baseline?.sensDrift ?? null,
      clickDrift: c.baseline?.clickDrift ?? null,
      changed: c.baseline?.changed?.length ?? null,
      alert: !!c.alert,
      alertBelowPct: c.alertBelowPct,
      calls: golden.calls,
      usage: golden.usage,
      costUsd: costOf(golden.usage),
    };
    usage = addUsage(usage, golden.usage);
    calls += golden.calls || 0;
  }

  const ext = extraction || { attempts: 0, successes: 0, byOutlet: {} };
  const extractionSummary = {
    attempts: ext.attempts,
    successes: ext.successes,
    successPct: ext.attempts ? round1((100 * ext.successes) / ext.attempts) : null,
    byOutlet: Object.fromEntries(Object.entries(ext.byOutlet || {}).map(([o, v]) => [o, { ...v, successPct: v.attempts ? round1((100 * v.successes) / v.attempts) : null }])),
    // Failure reasons and winning routes across the run; video pages are
    // skipped before any attempt and counted beside the rate.
    reasons: ext.reasons || {},
    routes: ext.routes || {},
    skipped: ext.skipped || { video: 0 },
    remote: ext.remote || 'not configured',
  };

  return {
    rows: { total: rows.length, scored: scoredRows, unscored, fulltext: fulltextRows, feedSummary: feedRows, headlineOnly: toneRows, withText: broad.n + unresolved },
    feeds: feedCounts,
    verdicts,
    framingIntegrity: {
      // Back-compatible fields (broad, as first published).
      v1: fi1.value,
      v2Low: broad.low,
      v2High: broad.high,
      v2Point: broad.point,
      v2N: broad.n,
      provisionalPending: broad.provisional,
      outletBalanced: broad.balanced.value,
      outletsRanked: broad.balanced.qualified,
      // Methodology v2, two definitions, never merged with each other or
      // with the provisional-outcome range.
      strict,
      broad,
      unresolved,
      outletMinN: OUTLET_MIN_N,
    },
    coverage: cov.value,
    integrity: { meanV1: meanOf(v1), meanV2: meanOf(v2) },
    axes: { fidelity: meanOf(fid), sens: meanOf(sens), click: meanOf(click) },
    slam: { flagged: slamFlagged, index: rows.length ? round1((100 * slamFlagged) / rows.length) : null, test: slamTest },
    escalation: esc,
    audit,
    extraction: extractionSummary,
    golden: goldenSummary,
    usage: { ...usage, calls },
    costUsd: costOf(usage),
  };
}

// Flatten a summary + run meta into the history.csv record (see ledger.js for
// the frozen column order).
export function historyRecord(run, summary = run.summary) {
  const s = summary;
  const m = s.escalation.matrix || {};
  const cell = (sv, v) => m[sv]?.[v] ?? null;
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
    // Reserved in phase 1, filled from phase 2 on.
    fi_v2_outlets_qualified: s.framingIntegrity.outletsRanked,
    fi_v2_outlet_min_n: s.framingIntegrity.outletMinN ?? null,
    esc_provisional_to_verified: cell('PROVISIONAL', 'VERIFIED'),
    esc_provisional_to_contextual: cell('PROVISIONAL', 'CONTEXTUAL'),
    esc_provisional_to_contested: cell('PROVISIONAL', 'CONTESTED'),
    esc_provisional_to_unverifiable: cell('PROVISIONAL', 'UNVERIFIED'),
    esc_provisional_to_misleading: cell('PROVISIONAL', 'MISLEADING'),
    esc_contested_to_verified: cell('CONTESTED', 'VERIFIED'),
    esc_contested_to_contextual: cell('CONTESTED', 'CONTEXTUAL'),
    esc_contested_to_contested: cell('CONTESTED', 'CONTESTED'),
    esc_contested_to_unverifiable: cell('CONTESTED', 'UNVERIFIED'),
    esc_contested_to_misleading: cell('CONTESTED', 'MISLEADING'),
    audit_sampled: s.audit?.sampledThisRun ?? null,
    audit_scored: s.audit?.scored ?? null,
    audit_overturned: s.audit?.overturned ?? null,
    audit_overturn_pct: s.audit?.overturnPct ?? null,
  };
}

// The stats.csv record: methodology v2 statistics per run, a companion to
// history.csv keyed by run_id (see ledger.js STATS_COLUMNS).
export function statsRecord(run, summary = run.summary) {
  const s = summary;
  const fi = s.framingIntegrity;
  const m = s.escalation.matrix || {};
  const cx = m.CONTEXTUAL || {};
  const g = s.golden;
  return {
    run_id: run.id,
    started_at: run.startedAt,
    fi_strict_low: fi.strict?.low ?? null,
    fi_strict_high: fi.strict?.high ?? null,
    fi_strict_ci_low: fi.strict?.ci?.lo ?? null,
    fi_strict_ci_high: fi.strict?.ci?.hi ?? null,
    fi_broad_low: fi.broad?.low ?? null,
    fi_broad_high: fi.broad?.high ?? null,
    fi_broad_ci_low: fi.broad?.ci?.lo ?? null,
    fi_broad_ci_high: fi.broad?.ci?.hi ?? null,
    fi_strict_balanced: fi.strict?.balanced?.value ?? null,
    fi_broad_balanced: fi.broad?.balanced?.value ?? null,
    outlets_qualified: fi.broad?.balanced?.qualified ?? null,
    outlet_min_n: fi.outletMinN ?? null,
    fi_unresolved: fi.unresolved ?? null,
    esc_reclassified: s.escalation.reclassified ?? null,
    esc_unresolved: s.escalation.unresolved ?? null,
    esc_contextual_eligible: s.escalation.byReason?.low_fidelity_contextual ?? null,
    esc_contextual_to_verified: cx.VERIFIED ?? null,
    esc_contextual_to_contextual: cx.CONTEXTUAL ?? null,
    esc_contextual_to_contested: cx.CONTESTED ?? null,
    esc_contextual_to_unverifiable: cx.UNVERIFIED ?? null,
    esc_contextual_to_misleading: cx.MISLEADING ?? null,
    audit_present: s.audit?.present ?? null,
    audit_changed: s.audit?.changed ?? null,
    extract_attempts: s.extraction?.attempts ?? null,
    extract_successes: s.extraction?.successes ?? null,
    extract_success_pct: s.extraction?.successPct ?? null,
    slam_gap: s.slam.test?.observedDiff ?? null,
    slam_gap_ci_low: s.slam.test?.ci?.lo ?? null,
    slam_gap_ci_high: s.slam.test?.ci?.hi ?? null,
    slam_p: s.slam.test?.p ?? null,
    slam_n_flagged: s.slam.test?.nFlagged ?? null,
    slam_n_rest: s.slam.test?.nRest ?? null,
    golden_scored: g?.scored ?? null,
    golden_agreement_pct: g?.agreementPct ?? null,
    golden_expected_agreement_pct: g?.expectedAgreementPct ?? null,
    golden_fidelity_drift: g?.fidelityDrift ?? null,
    golden_sens_drift: g?.sensDrift ?? null,
    golden_click_drift: g?.clickDrift ?? null,
    golden_alert: g ? (g.alert ? 1 : 0) : null,
    golden_cost_usd: g?.costUsd ?? null,
  };
}
