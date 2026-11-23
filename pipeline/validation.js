// ---------------------------------------------------------------------------
// Human validation set (DEFECTS.md v2-21).
//
// A set of headline + article pairs drawn from the ledger, stratified by the
// model's verdict, is labelled blind by reviewers on the site's unlisted
// /validate route. The set file the site serves carries NO scores; the
// model's labels live in a separate file the site never serves. Reviewers
// export a labels file that is committed to data/validation/labels/. The
// scan job computes agreement (Cohen's kappa, overall and per verdict) and
// writes data/validation/agreement.json for the method page.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MODEL_VERDICTS } from './verdicts.js';
import { mulberry32, seedFrom } from './prng.js';
import { uniqueRows } from './scorecards.js';

export const VALIDATION_SIZE = 100;
export const MIN_REVIEWERS = 2;
// Strata on the model's final verdict; PROVISIONAL (the sweep's held
// MISLEADING) pools with MISLEADING.
export const STRATA = [['VERIFIED'], ['CONTEXTUAL'], ['CONTESTED'], ['UNVERIFIED'], ['MISLEADING', 'PROVISIONAL']];
export const UNAVAILABLE = 'UNAVAILABLE';

export function validationPaths(root = '.') {
  const base = path.join(root, 'data', 'validation');
  return { base, set: path.join(base, 'set.json'), labels: path.join(base, 'labels'), agreement: path.join(base, 'agreement.json'), versioned: (v) => path.join(base, `set-v${v}.json`), modelLabels: (v) => path.join(base, `model-labels-v${v}.json`) };
}

function shuffled(list, seed) {
  const out = list.slice();
  const rand = mulberry32(seedFrom('validation', seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

/**
 * Draw a stratified set from resolved runs. Candidates: rows with a final
 * verdict judged against article text (not tone-only, not unscored, not
 * UNRESOLVED). Equal targets per stratum; shortfalls are filled from the
 * strata with the most spare candidates. Deterministic for a seed.
 * Returns { set, modelLabels, shortfall }.
 */
export function drawValidationSet(runs, { size = VALIDATION_SIZE, seed = 1, version = 1, drawnAt = new Date().toISOString() } = {}) {
  const rows = uniqueRows(runs).filter((r) => r.final && r.final.verdict && r.final.source !== 'tone' && r.final.source !== 'unscored' && !r.escalation?.unresolved);
  const byStratum = STRATA.map((verdicts) => shuffled(rows.filter((r) => verdicts.includes(r.final.verdict)), `${seed}:${verdicts.join('+')}`));
  const target = Math.floor(size / STRATA.length);
  const take = byStratum.map((pool) => Math.min(target, pool.length));
  let remaining = size - take.reduce((a, b) => a + b, 0);
  // Fill shortfalls round-robin from strata that still have candidates.
  while (remaining > 0) {
    let progressed = false;
    for (let i = 0; i < byStratum.length && remaining > 0; i++) {
      if (byStratum[i].length > take[i]) {
        take[i]++;
        remaining--;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  const picked = byStratum.flatMap((pool, i) => pool.slice(0, take[i]).map((r) => ({ row: r, stratum: STRATA[i].join('+') })));
  const ordered = shuffled(picked, `${seed}:order`);
  const set = {
    version,
    drawnAt,
    size: ordered.length,
    target: size,
    note: 'Blind labelling set. No model scores here; the model labels live in model-labels-v<version>.json, which the site never serves. Read the article at the link, then judge the headline against it.',
    items: ordered.map(({ row }) => ({ id: row.id, headline: row.title, link: row.link, outlet: row.outlet || row.publication, publication: row.publication, pubDate: row.pubDate, evidence: row.final.source })),
  };
  const modelLabels = {
    version,
    drawnAt,
    items: Object.fromEntries(ordered.map(({ row, stratum }) => [row.id, { verdict: row.final.verdict, fidelity: row.final.fidelity, sens: row.final.sens, click: row.final.click, source: row.final.source, stratum, runId: row.runId }])),
  };
  return { set, modelLabels, shortfall: size - ordered.length, strata: STRATA.map((s, i) => ({ stratum: s.join('+'), candidates: byStratum[i].length, taken: take[i] })) };
}

// --- Agreement --------------------------------------------------------------

/**
 * Cohen's kappa between two label arrays over `categories`. Returns
 * { n, agreement, kappa }. kappa is null when n is 0; 1 when both raters
 * agree on everything with no variation to chance-correct.
 */
export function cohenKappa(a, b, categories) {
  const n = Math.min(a.length, b.length);
  if (!n) return { n: 0, agreement: null, kappa: null };
  const cats = categories || [...new Set([...a, ...b])];
  let agree = 0;
  const ca = Object.fromEntries(cats.map((c) => [c, 0]));
  const cb = Object.fromEntries(cats.map((c) => [c, 0]));
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    if (a[i] in ca) ca[a[i]]++;
    if (b[i] in cb) cb[b[i]]++;
  }
  const po = agree / n;
  let pe = 0;
  for (const c of cats) pe += (ca[c] / n) * (cb[c] / n);
  const kappa = pe >= 1 ? (po >= 1 ? 1 : 0) : (po - pe) / (1 - pe);
  return { n, agreement: Math.round(po * 1000) / 10, kappa: Math.round(kappa * 1000) / 1000 };
}

// Per-verdict kappa: one-vs-rest.
export function perVerdictKappa(a, b, verdicts = MODEL_VERDICTS) {
  const out = {};
  for (const v of verdicts) out[v] = cohenKappa(a.map((x) => (x === v ? 1 : 0)), b.map((x) => (x === v ? 1 : 0)), [0, 1]).kappa;
  return out;
}

function meanAbs(pairs) {
  const xs = pairs.filter(([x, y]) => x != null && y != null).map(([x, y]) => Math.abs(x - y));
  return xs.length ? Math.round((xs.reduce((s, d) => s + d, 0) / xs.length) * 100) / 100 : null;
}

// Labels a reviewer gave for items that are in the set and judged (not UNAVAILABLE).
function judged(set, labelsFile) {
  const ids = set.items.map((i) => i.id);
  const out = [];
  for (const id of ids) {
    const l = labelsFile?.labels?.[id];
    if (l && l.verdict && l.verdict !== UNAVAILABLE) out.push({ id, ...l });
  }
  return out;
}

/**
 * Agreement report. `reviewers` is [{ reviewer, labels: { id: {...} } }].
 * Only items both parties judged enter a comparison. A reviewer is complete
 * when every item has a label (UNAVAILABLE counts as a label).
 */
export function computeAgreement({ set, modelLabels, reviewers = [], minReviewers = MIN_REVIEWERS, computedAt = new Date().toISOString() }) {
  const ids = set.items.map((i) => i.id);
  const rs = reviewers.map((r) => {
    const labelled = ids.filter((id) => r.labels?.[id]?.verdict).length;
    const unavailable = ids.filter((id) => r.labels?.[id]?.verdict === UNAVAILABLE).length;
    return { reviewer: r.reviewer, labelled, unavailable, complete: labelled === ids.length, judged: judged(set, r) };
  });
  const modelVsHuman = rs.map((r) => {
    const a = r.judged.map((l) => modelLabels.items[l.id]?.verdict).filter(Boolean);
    const b = r.judged.filter((l) => modelLabels.items[l.id]).map((l) => l.verdict);
    const overall = cohenKappa(a, b, MODEL_VERDICTS);
    return {
      reviewer: r.reviewer,
      n: overall.n,
      overall,
      perVerdict: perVerdictKappa(a, b),
      axes: {
        fidelity: meanAbs(r.judged.map((l) => [modelLabels.items[l.id]?.fidelity, l.fidelity])),
        sens: meanAbs(r.judged.map((l) => [modelLabels.items[l.id]?.sens, l.sens])),
        click: meanAbs(r.judged.map((l) => [modelLabels.items[l.id]?.click, l.click])),
      },
    };
  });
  const humanVsHuman = [];
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const bj = new Map(rs[j].judged.map((l) => [l.id, l]));
      const both = rs[i].judged.filter((l) => bj.has(l.id));
      const a = both.map((l) => l.verdict);
      const b = both.map((l) => bj.get(l.id).verdict);
      humanVsHuman.push({ a: rs[i].reviewer, b: rs[j].reviewer, n: both.length, overall: cohenKappa(a, b, MODEL_VERDICTS), perVerdict: perVerdictKappa(a, b) });
    }
  }
  const complete = rs.filter((r) => r.complete).length;
  return {
    version: set.version,
    computedAt,
    size: set.items.length,
    minReviewers,
    reviewers: rs.map(({ judged: _j, ...r }) => r),
    complete,
    validated: complete >= minReviewers,
    statement: complete >= minReviewers ? `Validated against ${complete} human reviewers.` : 'Not yet validated against human reviewers.',
    modelVsHuman,
    humanVsHuman,
  };
}

// --- Files ------------------------------------------------------------------

export async function readValidationSet({ root = '.' } = {}) {
  try {
    return JSON.parse(await fs.readFile(validationPaths(root).set, 'utf8'));
  } catch {
    return null;
  }
}

export async function readModelLabels(version, { root = '.' } = {}) {
  try {
    return JSON.parse(await fs.readFile(validationPaths(root).modelLabels(version), 'utf8'));
  } catch {
    return null;
  }
}

// Every labels file in data/validation/labels/ for the set's version.
export async function readReviewerLabels(version, { root = '.' } = {}) {
  const dir = validationPaths(root).labels;
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    try {
      const l = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      if (l && l.labels && (l.version == null || l.version === version)) out.push({ reviewer: l.reviewer || f.replace(/\.json$/, ''), labels: l.labels, file: f });
    } catch {
      /* a malformed labels file is skipped, never repaired in place */
    }
  }
  return out;
}

export async function writeAgreement(report, { root = '.' } = {}) {
  const p = validationPaths(root);
  await fs.mkdir(p.base, { recursive: true });
  await fs.writeFile(p.agreement, JSON.stringify(report, null, 2) + '\n');
  return p.agreement;
}

// Full refresh: set + model labels + reviewer files → agreement.json. Null
// when no set exists yet.
export async function refreshAgreement({ root = '.' } = {}) {
  const set = await readValidationSet({ root });
  if (!set) return null;
  const modelLabels = (await readModelLabels(set.version, { root })) || { items: {} };
  const reviewers = await readReviewerLabels(set.version, { root });
  const report = computeAgreement({ set, modelLabels, reviewers });
  await writeAgreement(report, { root });
  return report;
}
