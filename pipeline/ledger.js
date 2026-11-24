// ---------------------------------------------------------------------------
// The ledger. Append-only, in the repo:
//   data/scans/YYYY-MM-DD/HH.json   run telemetry + the rows scored or
//                                   re-scored this run; carried rows are
//                                   referenced by { id, run } (never rewritten;
//                                   a second run in the same UTC hour writes
//                                   HH.2.json rather than overwriting)
//   data/history.csv                one row per run, columns frozen below,
//                                   never rewritten
//   data/pointer.json               the latest scan file and the file for
//                                   every run id in the reuse window; the
//                                   current view is built from these on
//                                   demand (view.js) and never committed
//   data/aggregate.json             the 24h aggregate (see aggregate.js)
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULT_PACK } from './config.js';

// Frozen for methodology v2. A column change is a new file (history-v3.csv),
// never an edit to this one: appendHistory refuses to write under a header
// that does not match.
export const HISTORY_COLUMNS = [
  'run_id', 'started_at', 'finished_at', 'duration_ms', 'methodology', 'model',
  'prompt_hash_sweep', 'prompt_hash_fulltext', 'prompt_hash_tone',
  'feeds_total', 'feeds_live', 'feeds_stale', 'feeds_blocked', 'feeds_dead',
  'rows_total', 'rows_scored', 'rows_unscored', 'rows_fulltext', 'rows_feed_summary', 'rows_headline_only',
  'verified', 'contextual', 'contested', 'unverifiable', 'provisional', 'misleading',
  'fi_v1', 'fi_v2_low', 'fi_v2_high', 'fi_v2_n', 'fi_v2_outlet_balanced', 'coverage_pct',
  'mean_integrity_v1', 'mean_integrity_v2', 'avg_fidelity', 'avg_sensationalism', 'avg_clickbait',
  'slam_flagged', 'slam_index',
  'esc_eligible', 'esc_attempted', 'esc_confirmed', 'esc_cleared', 'esc_pending', 'esc_blocked', 'esc_timeout',
  'tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_write', 'model_calls', 'cost_usd',
  // Reserved for phase 2 (DEFECTS.md v2-5 … v2-8); written empty until then.
  'fi_v2_outlets_qualified', 'fi_v2_outlet_min_n',
  'esc_provisional_to_verified', 'esc_provisional_to_contextual', 'esc_provisional_to_contested', 'esc_provisional_to_unverifiable', 'esc_provisional_to_misleading',
  'esc_contested_to_verified', 'esc_contested_to_contextual', 'esc_contested_to_contested', 'esc_contested_to_unverifiable', 'esc_contested_to_misleading',
  'audit_sampled', 'audit_scored', 'audit_overturned', 'audit_overturn_pct',
];

// Methodology v2 statistics per run (phase 2), a companion to history.csv
// keyed by run_id. Same rules: frozen columns, append-only.
export const STATS_COLUMNS = [
  'run_id', 'started_at',
  'fi_strict_low', 'fi_strict_high', 'fi_strict_ci_low', 'fi_strict_ci_high',
  'fi_broad_low', 'fi_broad_high', 'fi_broad_ci_low', 'fi_broad_ci_high',
  'fi_strict_balanced', 'fi_broad_balanced', 'outlets_qualified', 'outlet_min_n', 'fi_unresolved',
  'esc_reclassified', 'esc_unresolved', 'esc_contextual_eligible',
  'esc_contextual_to_verified', 'esc_contextual_to_contextual', 'esc_contextual_to_contested', 'esc_contextual_to_unverifiable', 'esc_contextual_to_misleading',
  'audit_present', 'audit_changed',
  'extract_attempts', 'extract_successes', 'extract_success_pct',
  'slam_gap', 'slam_gap_ci_low', 'slam_gap_ci_high', 'slam_p', 'slam_n_flagged', 'slam_n_rest',
  'golden_scored', 'golden_agreement_pct', 'golden_expected_agreement_pct', 'golden_fidelity_drift', 'golden_sens_drift', 'golden_click_drift', 'golden_alert', 'golden_cost_usd',
];

// Scan files are shared by every pack (rows carry `pack`); every derived
// file is per pack. The national pack is the original ledger at data/;
// every other pack lives under data/packs/<key>/.
export function ledgerPaths(root = '.', dataDir = DATA_DIR, pack = DEFAULT_PACK) {
  const shared = path.join(root, dataDir);
  const base = !pack || pack === DEFAULT_PACK ? shared : path.join(shared, 'packs', pack);
  return {
    base,
    pack: pack || DEFAULT_PACK,
    scans: path.join(shared, 'scans'),
    history: path.join(base, 'history.csv'),
    stats: path.join(base, 'stats.csv'),
    daily: path.join(base, 'daily.json'),
    pointer: path.join(shared, 'pointer.json'),
    aggregate: path.join(base, 'aggregate.json'),
  };
}

// UTC date + hour for a run's scan path.
export function scanPathFor(startedAt, paths) {
  const d = new Date(startedAt);
  const day = d.toISOString().slice(0, 10);
  const hour = String(d.getUTCHours()).padStart(2, '0');
  return { dir: path.join(paths.scans, day), file: `${hour}.json` };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a scan file (a delta: `rows` are the rows produced this run,
 * `carried` references the rest by { id, run }). Never overwrites: if HH.json
 * exists, writes HH.2.json, HH.3.json, … Returns the path written.
 * `payload` may also be a plain rows array (carried: []).
 */
export async function writeScan(run, payload, { root = '.' } = {}) {
  const rows = Array.isArray(payload) ? payload : payload?.rows || [];
  const carried = Array.isArray(payload) ? [] : payload?.carried || [];
  const paths = ledgerPaths(root);
  const { dir, file } = scanPathFor(run.startedAt, paths);
  await fs.mkdir(dir, { recursive: true });
  let target = path.join(dir, file);
  let n = 1;
  while (await exists(target)) {
    n++;
    target = path.join(dir, file.replace(/\.json$/, `.${n}.json`));
  }
  await fs.writeFile(target, JSON.stringify({ ...run, rows, carried }) + '\n');
  return target;
}

/**
 * Expand delta scan files into full row sets: each run's own rows plus every
 * carried reference resolved against the run named in the reference, falling
 * back to `latest` (the full current view). References that resolve nowhere
 * are counted in `unresolvedCarried`, never fabricated.
 */
export function resolveRuns(runs, { latest = null } = {}) {
  const byRunAndId = new Map();
  for (const run of runs) for (const row of run.rows || []) byRunAndId.set(`${run.id}\n${row.id}`, row);
  const latestById = new Map((latest?.rows || []).map((r) => [r.id, r]));
  return runs.map((run) => {
    const rows = [...(run.rows || [])];
    let unresolvedCarried = 0;
    for (const ref of run.carried || []) {
      const row = byRunAndId.get(`${ref.run}\n${ref.id}`) || latestById.get(ref.id);
      if (row) rows.push(row);
      else unresolvedCarried++;
    }
    return { ...run, rows, unresolvedCarried };
  });
}

export function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvLine(record, columns = HISTORY_COLUMNS) {
  return columns.map((c) => csvEscape(record[c])).join(',');
}

// Append one record to an append-only CSV. Creates the file with the header
// when it is missing; refuses to append under a foreign header. Never rewrites.
async function appendCsv(file, columns, record, label) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const header = columns.join(',');
  if (await exists(file)) {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(8192, (await fh.stat()).size));
      await fh.read(buf, 0, buf.length, 0);
      const first = buf.toString('utf8').split(/\r?\n/)[0];
      if (first !== header) {
        throw new Error(`${label} header does not match its column list — a schema change needs a new file, not a rewrite`);
      }
    } finally {
      await fh.close();
    }
    const existing = await fs.readFile(file, 'utf8');
    const sep = existing.length && !existing.endsWith('\n') ? '\n' : '';
    await fs.appendFile(file, sep + toCsvLine(record, columns) + '\n');
  } else {
    await fs.writeFile(file, header + '\n' + toCsvLine(record, columns) + '\n');
  }
  return file;
}

/** Append one run to history.csv (frozen HISTORY_COLUMNS). */
export async function appendHistory(record, { root = '.', pack = DEFAULT_PACK } = {}) {
  return appendCsv(ledgerPaths(root, DATA_DIR, pack).history, HISTORY_COLUMNS, record, 'history.csv');
}

/** Append one run to stats.csv (frozen STATS_COLUMNS). */
export async function appendStats(record, { root = '.', pack = DEFAULT_PACK } = {}) {
  return appendCsv(ledgerPaths(root, DATA_DIR, pack).stats, STATS_COLUMNS, record, 'stats.csv');
}

// Number of runs already recorded in history.csv (data rows), or 0.
export async function countHistoryRuns({ root = '.', pack = DEFAULT_PACK } = {}) {
  try {
    const text = await fs.readFile(ledgerPaths(root, DATA_DIR, pack).history, 'utf8');
    return Math.max(0, text.split(/\r?\n/).filter((l) => l.trim().length).length - 1);
  } catch {
    return 0;
  }
}

// data/pointer.json: { latest: { id, startedAt, file }, runs: { id: file } },
// files relative to the data directory. Rewritten every run; tiny.
export async function writePointer(pointer, { root = '.' } = {}) {
  const paths = ledgerPaths(root);
  await fs.mkdir(paths.base, { recursive: true });
  await fs.writeFile(paths.pointer, JSON.stringify(pointer, null, 2) + '\n');
  return paths.pointer;
}

export async function readPointer({ root = '.' } = {}) {
  try {
    const p = JSON.parse(await fs.readFile(ledgerPaths(root).pointer, 'utf8'));
    return p && p.latest && p.runs ? p : null;
  } catch {
    return null;
  }
}

// The scan file for a run, relative to the data directory.
export function scanFileRelative(absPath, { root = '.' } = {}) {
  return path.relative(ledgerPaths(root).base, absPath).split(path.sep).join('/');
}

export async function readDaily({ root = '.', pack = DEFAULT_PACK } = {}) {
  try {
    const d = JSON.parse(await fs.readFile(ledgerPaths(root, DATA_DIR, pack).daily, 'utf8'));
    return d && Array.isArray(d.days) ? d : null;
  } catch {
    return null;
  }
}

export async function writeDaily(daily, { root = '.', pack = DEFAULT_PACK } = {}) {
  const paths = ledgerPaths(root, DATA_DIR, pack);
  await fs.mkdir(paths.base, { recursive: true });
  await fs.writeFile(paths.daily, JSON.stringify(daily) + '\n');
  return paths.daily;
}

export async function writeAggregate(aggregate, { root = '.', pack = DEFAULT_PACK } = {}) {
  const paths = ledgerPaths(root, DATA_DIR, pack);
  await fs.mkdir(paths.base, { recursive: true });
  await fs.writeFile(paths.aggregate, JSON.stringify(aggregate, null, 2) + '\n');
  return paths.aggregate;
}

/**
 * Read scan files whose run started within `windowMs` of `now`, newest first.
 * Scans the day directories that can intersect the window only.
 */
export async function readRecentScans({ root = '.', now = Date.now(), windowMs = 24 * 60 * 60 * 1000 } = {}) {
  const paths = ledgerPaths(root);
  if (!(await exists(paths.scans))) return [];
  const since = now - windowMs;
  const days = new Set();
  for (let t = since - 24 * 60 * 60 * 1000; t <= now + 24 * 60 * 60 * 1000; t += 24 * 60 * 60 * 1000) {
    days.add(new Date(t).toISOString().slice(0, 10));
  }
  const runs = [];
  for (const day of [...days].sort()) {
    const dir = path.join(paths.scans, day);
    if (!(await exists(dir))) continue;
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      try {
        const run = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
        const t = Date.parse(run.startedAt);
        // `file` is where this run lives, relative to data/ (for pointer.json).
        if (Number.isFinite(t) && t >= since && t <= now) runs.push({ ...run, file: `scans/${day}/${f}` });
      } catch {
        /* a corrupt file is skipped, never repaired in place */
      }
    }
  }
  runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return runs;
}
