// ---------------------------------------------------------------------------
// Statistical layer — methodology v2.
//
//   wilson            interval for a single-outlet rate
//   clusterBootstrap  CI for a statistic over rows that cluster by outlet:
//                     resample OUTLETS with replacement, seeded, 2000 iters
//   shrink            beta-binomial shrinkage of an outlet rate toward the
//                     pooled rate (strength in pseudo-rows)
//   permutationWithinOutlet
//                     two-sided permutation test of a flagged-vs-rest mean
//                     difference, shuffling values WITHIN outlet so outlet
//                     tone cannot masquerade as a slam effect;
//                     p = (count + 1) / (iterations + 1); CI on the observed
//                     difference by cluster bootstrap. A consistency check,
//                     not independent evidence.
//
// Every function is pure and deterministic for a given seed.
// ---------------------------------------------------------------------------
import { BOOTSTRAP_ITERATIONS, PERMUTATION_ITERATIONS, PERMUTATION_MIN_GROUP, SHRINK_STRENGTH } from './config.js';
import { mulberry32, seedFrom } from './prng.js';

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// Canonical ordering so a result never depends on the order rows arrived
// in: groups sort by a signature of their members, members by id (or value).
function memberKey(r) {
  if (r && typeof r === 'object') return String(r.id ?? JSON.stringify(r));
  return String(r);
}
function canonicalGroup(group) {
  return group.slice().sort((a, b) => (memberKey(a) < memberKey(b) ? -1 : memberKey(a) > memberKey(b) ? 1 : 0));
}
function canonicalGroups(groups) {
  return groups
    .map((g) => ({ g: canonicalGroup(g), sig: g.length + ':' + canonicalGroup(g).map(memberKey).join('\u0001') }))
    .sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0))
    .map((x) => x.g);
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Wilson score interval for k successes in n trials (95% by default).
 * Returns percentages. Null bounds when n is 0.
 */
export function wilson(k, n, z = 1.959964) {
  if (!n) return { p: null, lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p: round1(100 * p), lo: round1(100 * Math.max(0, centre - half)), hi: round1(100 * Math.min(1, centre + half)) };
}

/**
 * Cluster bootstrap. `groups` is an array of arrays (one per outlet);
 * `statFn(rows)` computes the statistic on a flat row list. Resamples
 * groups with replacement `iterations` times. Returns the observed value
 * and the percentile 95% interval, or nulls when fewer than 2 groups.
 */
export function clusterBootstrap(groups, statFn, { seed = 1, iterations = BOOTSTRAP_ITERATIONS, alpha = 0.05 } = {}) {
  // Input order must not matter: a run's rows arrive in feed order, and the
  // same rows in another order are the same sample.
  const g = canonicalGroups(groups.filter((x) => x && x.length));
  const observed = statFn(g.flat());
  if (g.length < 2) return { point: observed, lo: null, hi: null, clusters: g.length, iterations: 0 };
  const rand = mulberry32(seedFrom('cluster-bootstrap', seed, g.length));
  const stats = [];
  for (let it = 0; it < iterations; it++) {
    const sample = [];
    for (let i = 0; i < g.length; i++) {
      const pick = g[(rand() * g.length) | 0];
      for (const row of pick) sample.push(row);
    }
    const v = statFn(sample);
    if (v != null && Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  return { point: observed, lo: percentile(stats, alpha / 2), hi: percentile(stats, 1 - alpha / 2), clusters: g.length, iterations: stats.length };
}

/**
 * Beta-binomial shrinkage: an outlet with k good of n is pulled toward the
 * pooled rate p0 with `strength` pseudo-rows. Returns a percentage.
 */
export function shrink(k, n, p0, strength = SHRINK_STRENGTH) {
  if (p0 == null || !Number.isFinite(p0)) return n ? round1((100 * k) / n) : null;
  return round1((100 * (k + strength * p0)) / (n + strength));
}

/**
 * Permutation test of mean(value | flagged) − mean(value | rest), permuting
 * flags WITHIN each outlet. Rows: [{ outlet, flagged, value }].
 */
export function permutationWithinOutlet(rows, { seed = 1, iterations = PERMUTATION_ITERATIONS, minGroup = PERMUTATION_MIN_GROUP, bootstrapIterations = BOOTSTRAP_ITERATIONS } = {}) {
  // Canonical order (outlet, flag, value, id) so the label shuffle inside each
  // outlet does not depend on the order rows arrived in.
  const valid = rows
    .filter((r) => r && Number.isFinite(r.value))
    .slice()
    .sort((a, b) => String(a.outlet).localeCompare(String(b.outlet)) || (a.flagged === b.flagged ? 0 : a.flagged ? 1 : -1) || a.value - b.value || String(a.id ?? '').localeCompare(String(b.id ?? '')));
  const flagged = valid.filter((r) => r.flagged);
  const rest = valid.filter((r) => !r.flagged);
  const nFlagged = flagged.length;
  const nRest = rest.length;
  if (nFlagged < minGroup || nRest < minGroup) {
    return { underpowered: true, nFlagged, nRest, observedDiff: null, p: null, ci: { lo: null, hi: null }, iterations: 0, label: 'consistency check' };
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const diffOf = (list) => {
    let sf = 0;
    let nf = 0;
    let sr = 0;
    let nr = 0;
    for (const r of list) {
      if (r.flagged) {
        sf += r.value;
        nf++;
      } else {
        sr += r.value;
        nr++;
      }
    }
    if (!nf || !nr) return null;
    return sf / nf - sr / nr;
  };
  const observedDiff = mean(flagged.map((r) => r.value)) - mean(rest.map((r) => r.value));
  const absObs = Math.abs(observedDiff);

  // Group by outlet; permute the flag labels inside each group only.
  const byOutlet = new Map();
  for (const r of valid) {
    if (!byOutlet.has(r.outlet)) byOutlet.set(r.outlet, []);
    byOutlet.get(r.outlet).push(r);
  }
  const groups = [...byOutlet.values()];
  const rand = mulberry32(seedFrom('permutation-within-outlet', seed, valid.length));
  let count = 0;
  const work = groups.map((g) => ({ values: g.map((r) => r.value), flags: g.map((r) => !!r.flagged) }));
  for (let it = 0; it < iterations; it++) {
    let sf = 0;
    let sr = 0;
    for (const g of work) {
      // Fisher–Yates on the flag labels of this outlet.
      const f = g.flags.slice();
      for (let i = f.length - 1; i > 0; i--) {
        const j = (rand() * (i + 1)) | 0;
        const t = f[i];
        f[i] = f[j];
        f[j] = t;
      }
      for (let i = 0; i < f.length; i++) {
        if (f[i]) sf += g.values[i];
        else sr += g.values[i];
      }
    }
    const diff = sf / nFlagged - sr / nRest;
    if (Math.abs(diff) >= absObs) count++;
  }
  const p = (count + 1) / (iterations + 1);
  const ci = clusterBootstrap(groups, diffOf, { seed: seedFrom('slam-diff', seed), iterations: bootstrapIterations });
  return {
    underpowered: false,
    nFlagged,
    nRest,
    outlets: groups.length,
    observedDiff: round1(observedDiff),
    p: Math.round(p * 10000) / 10000,
    ci: { lo: round1(ci.lo), hi: round1(ci.hi) },
    iterations,
    label: 'consistency check',
  };
}

export { round1 };
