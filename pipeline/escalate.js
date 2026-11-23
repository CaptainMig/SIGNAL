// ---------------------------------------------------------------------------
// Escalation policy: which sweep rows get the article body and a full-text
// score, how the full-text verdict resolves the sweep flag, and the seeded
// audit sample that measures the sweep's miss rate.
//
// Eligibility (DEFECTS.md v2-14):
//   PROVISIONAL  — the sweep suspected distortion; the body decides.
//   CONTESTED    — the sweep saw a dispute; the body decides how flat it is.
//   CONTEXTUAL with fidelity ≤ ESCALATE_CONTEXTUAL_MAX_FIDELITY — a low-
//                  fidelity "missing context" call is a near-miss worth checking.
//   audit        — a seeded random sample of sweep VERIFIED / CONTEXTUAL rows,
//                  the only check on what the sweep does NOT flag.
//
// Outcomes keep the full sweep × full-text matrix (DEFECTS.md v2-7). The label
// is derived, never stored instead of the matrix cell:
//   confirmed    — the full text returned the same verdict (PROVISIONAL counts
//                  MISLEADING as its confirmation)
//   cleared      — the full text returned VERIFIED or CONTEXTUAL, nothing else
//   reclassified — any other full-text verdict
//   pending      — no full-text verdict yet, retries remain
//   unresolved   — retries exhausted (SOURCE BLOCKED or TIMEOUT)
// ---------------------------------------------------------------------------
import { AUDIT_BOOST_DAYS, AUDIT_PER_RUN, AUDIT_PER_RUN_BOOST, AUDIT_START, ESCALATE_CONTEXTUAL_MAX_FIDELITY } from './config.js';
import { MODEL_VERDICTS } from './verdicts.js';
import { mulberry32, seedFrom } from './prng.js';

export const SWEEP_FLAGS = ['PROVISIONAL', 'CONTESTED', 'CONTEXTUAL'];
export const OUTCOMES = ['confirmed', 'cleared', 'reclassified', 'pending', 'unresolved'];

// Why a row is escalated, or null when it is not.
export function escalationReason(sweepScore, { maxContextualFidelity = ESCALATE_CONTEXTUAL_MAX_FIDELITY } = {}) {
  if (!sweepScore || !sweepScore.verdict) return null;
  if (sweepScore.verdict === 'PROVISIONAL') return 'provisional';
  if (sweepScore.verdict === 'CONTESTED') return 'contested';
  if (sweepScore.verdict === 'CONTEXTUAL' && sweepScore.fidelity != null && sweepScore.fidelity <= maxContextualFidelity) return 'low_fidelity_contextual';
  return null;
}

export function needsEscalation(sweepScore, opts) {
  return escalationReason(sweepScore, opts) != null;
}

/**
 * Resolve a sweep flag against the full-text verdict.
 * @param pending  true when retries remain (else an absent verdict is unresolved)
 */
export function escalationOutcome(sweepVerdict, fulltextVerdict, { pending = true } = {}) {
  if (!fulltextVerdict) return pending ? 'pending' : 'unresolved';
  if (sweepVerdict === 'PROVISIONAL' && fulltextVerdict === 'MISLEADING') return 'confirmed';
  if (sweepVerdict === fulltextVerdict) return 'confirmed';
  if (fulltextVerdict === 'VERIFIED' || fulltextVerdict === 'CONTEXTUAL') return 'cleared';
  return 'reclassified';
}

// Empty sweep × full-text matrix for the flagged sweep verdicts.
export function emptyMatrix() {
  const m = {};
  for (const s of SWEEP_FLAGS) {
    m[s] = Object.fromEntries(MODEL_VERDICTS.map((v) => [v, 0]));
    m[s].pending = 0;
    m[s].unresolved = 0;
  }
  return m;
}

// How many audit rows a run draws: boosted for the first AUDIT_BOOST_DAYS from
// AUDIT_START, then the steady rate.
export function auditSampleSize(runStartedAt, { start = AUDIT_START, boostDays = AUDIT_BOOST_DAYS, boost = AUDIT_PER_RUN_BOOST, steady = AUDIT_PER_RUN } = {}) {
  const t = Date.parse(runStartedAt);
  const t0 = Date.parse(start + 'T00:00:00Z');
  if (!Number.isFinite(t) || !Number.isFinite(t0)) return steady;
  return t < t0 + boostDays * 86400e3 ? boost : steady;
}

/**
 * Seeded, stratified audit sample: half sweep VERIFIED, half sweep CONTEXTUAL
 * (VERIFIED gets the odd one). Candidates must have article text, a sweep
 * verdict in the two classes, no full-text verdict yet, and no earlier audit
 * mark. Returns the chosen rows' ids. Deterministic for a run id.
 */
export function pickAuditRows(rows, { runId, size }) {
  if (!size) return [];
  const eligible = (v) => rows.filter((r) => r.sweep && r.sweep.verdict === v && r.sweep.mode !== 'tone' && !r.fulltext && !r.fulltextError && !r.audit && !r.escalation?.eligible);
  const strata = [
    { rows: eligible('VERIFIED'), want: Math.ceil(size / 2) },
    { rows: eligible('CONTEXTUAL'), want: Math.floor(size / 2) },
  ];
  const rand = mulberry32(seedFrom('audit', runId));
  const chosen = [];
  for (const s of strata) {
    const pool = s.rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = pool[i];
      pool[i] = pool[j];
      pool[j] = t;
    }
    for (const r of pool.slice(0, s.want)) chosen.push(r.id);
  }
  return chosen;
}

// An audit row is "overturned" when the full text leaves the integrity set;
// "changed" when the verdict differs at all.
export function auditResult(sweepVerdict, fulltextVerdict) {
  if (!fulltextVerdict) return { scored: false, changed: null, overturned: null };
  const good = fulltextVerdict === 'VERIFIED' || fulltextVerdict === 'CONTEXTUAL';
  return { scored: true, changed: fulltextVerdict !== sweepVerdict, overturned: !good };
}
