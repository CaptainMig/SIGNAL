// ---------------------------------------------------------------------------
// Golden set — scorer drift detection.
//
// A frozen set of synthetic headline + article pairs (data/golden/set.json)
// is scored in full-text mode every run (or every N runs). The first scoring
// run writes data/golden/baseline.json, which is never rewritten; every later
// run reports verdict agreement against it and the mean drift on each axis.
// Agreement below GOLDEN_ALERT_BELOW_PCT is an alert the UI must show.
//
// The set's `expected` field is the authoring intent, reported as a second
// agreement number for reading, not a ground truth the model is graded on.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GOLDEN_ALERT_BELOW_PCT } from './config.js';

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export function goldenPaths(root = '.') {
  const base = path.join(root, 'data', 'golden');
  return { base, set: path.join(base, 'set.json'), baseline: path.join(base, 'baseline.json') };
}

export async function readGoldenSet({ root = '.' } = {}) {
  const raw = JSON.parse(await fs.readFile(goldenPaths(root).set, 'utf8'));
  if (!raw || !Array.isArray(raw.items)) throw new Error('golden set malformed');
  return raw;
}

export async function readBaseline({ root = '.' } = {}) {
  try {
    const b = JSON.parse(await fs.readFile(goldenPaths(root).baseline, 'utf8'));
    return b && Array.isArray(b.results) ? b : null;
  } catch {
    return null;
  }
}

// Written once. Refuses to overwrite: the baseline is a record.
export async function writeBaselineIfAbsent(baseline, { root = '.' } = {}) {
  const p = goldenPaths(root);
  await fs.mkdir(p.base, { recursive: true });
  try {
    await fs.writeFile(p.baseline, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' });
    return true;
  } catch (e) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Score every item in full-text mode. Returns compact per-item results
 * (never the article text) plus token usage.
 */
export async function scoreGoldenSet(scorer, set) {
  const items = set.items.map((it) => ({ headline: it.headline, body: it.article, mode: 'fulltext' }));
  const raw = await scorer.scoreAll(items);
  const results = raw.map((r, i) => ({
    id: set.items[i].id,
    expected: set.items[i].expected,
    ok: r.ok,
    verdict: r.ok ? r.score.verdict : null,
    fidelity: r.ok ? r.score.fidelity : null,
    sens: r.ok ? r.score.sens : null,
    click: r.ok ? r.score.click : null,
    reason: r.ok ? undefined : r.reason,
  }));
  const usage = raw.reduce(
    (a, r) => ({ input: a.input + (r.usage?.input || 0), output: a.output + (r.usage?.output || 0), cacheRead: a.cacheRead + (r.usage?.cacheRead || 0), cacheWrite: a.cacheWrite + (r.usage?.cacheWrite || 0) }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  );
  return { version: set.version, model: scorer.model, promptHash: scorer.promptHashes.fulltext, results, usage, calls: raw.length };
}

/**
 * Compare a run's golden results with the baseline (and with the authoring
 * intent). Pure.
 */
export function compareGolden(current, baseline, { alertBelow = GOLDEN_ALERT_BELOW_PCT } = {}) {
  const cur = new Map(current.results.filter((r) => r.ok).map((r) => [r.id, r]));
  const out = { n: current.results.length, scored: cur.size, baseline: null, expected: null, alert: false };

  // Agreement with the authoring intent, always available.
  let expAgree = 0;
  for (const r of cur.values()) if (r.verdict === r.expected) expAgree++;
  out.expected = { agreementPct: cur.size ? round1((100 * expAgree) / cur.size) : null, agree: expAgree, n: cur.size };

  if (baseline) {
    const base = new Map(baseline.results.filter((r) => r.ok).map((r) => [r.id, r]));
    let both = 0;
    let agree = 0;
    const dF = [];
    const dS = [];
    const dC = [];
    const changed = [];
    for (const [id, r] of cur) {
      const b = base.get(id);
      if (!b) continue;
      both++;
      if (r.verdict === b.verdict) agree++;
      else changed.push({ id, from: b.verdict, to: r.verdict });
      dF.push(r.fidelity - b.fidelity);
      dS.push(r.sens - b.sens);
      dC.push(r.click - b.click);
    }
    const mean = (xs) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const pct = both ? round1((100 * agree) / both) : null;
    out.baseline = {
      runId: baseline.runId,
      model: baseline.model,
      promptHash: baseline.promptHash,
      sameModel: baseline.model === current.model,
      samePrompt: baseline.promptHash === current.promptHash,
      n: both,
      agree,
      agreementPct: pct,
      fidelityDrift: mean(dF),
      sensDrift: mean(dS),
      clickDrift: mean(dC),
      changed,
    };
    out.alert = pct != null && pct < alertBelow;
  }
  out.alertBelowPct = alertBelow;
  return out;
}
