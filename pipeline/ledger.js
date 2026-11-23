// ---------------------------------------------------------------------------
// The ledger. Append-only, in the repo:
//   data/scans/YYYY-MM-DD/HH.json   every row + run telemetry (never rewritten;
//                                   a second run in the same UTC hour writes
//                                   HH.2.json rather than overwriting)
//   data/history.csv                one row per run, columns frozen below,
//                                   never rewritten
//   data/latest.json                the most recent run, what the site reads
//   data/aggregate.json             the 24h aggregate (see aggregate.js)
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

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
];

export function ledgerPaths(root = '.', dataDir = DATA_DIR) {
  const base = path.join(root, dataDir);
  return {
    base,
    scans: path.join(base, 'scans'),
    history: path.join(base, 'history.csv'),
    latest: path.join(base, 'latest.json'),
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
 * Write a scan file. Never overwrites: if HH.json exists, writes HH.2.json,
 * HH.3.json, … Returns the path written (repo-relative when root is '.').
 */
export async function writeScan(run, rows, { root = '.' } = {}) {
  const paths = ledgerPaths(root);
  const { dir, file } = scanPathFor(run.startedAt, paths);
  await fs.mkdir(dir, { recursive: true });
  let target = path.join(dir, file);
  let n = 1;
  while (await exists(target)) {
    n++;
    target = path.join(dir, file.replace(/\.json$/, `.${n}.json`));
  }
  const payload = { ...run, rows };
  await fs.writeFile(target, JSON.stringify(payload) + '\n');
  return target;
}

export function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvLine(record, columns = HISTORY_COLUMNS) {
  return columns.map((c) => csvEscape(record[c])).join(',');
}

/**
 * Append one run to history.csv. Creates the file with the header when it is
 * missing; refuses to append under a foreign header. Never rewrites.
 */
export async function appendHistory(record, { root = '.' } = {}) {
  const paths = ledgerPaths(root);
  await fs.mkdir(paths.base, { recursive: true });
  const header = HISTORY_COLUMNS.join(',');
  if (await exists(paths.history)) {
    const fh = await fs.open(paths.history, 'r');
    try {
      const buf = Buffer.alloc(Math.min(8192, (await fh.stat()).size));
      await fh.read(buf, 0, buf.length, 0);
      const first = buf.toString('utf8').split(/\r?\n/)[0];
      if (first !== header) {
        throw new Error(`history.csv header does not match HISTORY_COLUMNS — a schema change needs a new file, not a rewrite`);
      }
    } finally {
      await fh.close();
    }
    const existing = await fs.readFile(paths.history, 'utf8');
    const sep = existing.length && !existing.endsWith('\n') ? '\n' : '';
    await fs.appendFile(paths.history, sep + toCsvLine(record) + '\n');
  } else {
    await fs.writeFile(paths.history, header + '\n' + toCsvLine(record) + '\n');
  }
  return paths.history;
}

export async function writeLatest(run, rows, { root = '.' } = {}) {
  const paths = ledgerPaths(root);
  await fs.mkdir(paths.base, { recursive: true });
  await fs.writeFile(paths.latest, JSON.stringify({ ...run, rows }, null, 0) + '\n');
  return paths.latest;
}

export async function writeAggregate(aggregate, { root = '.' } = {}) {
  const paths = ledgerPaths(root);
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
        if (Number.isFinite(t) && t >= since && t <= now) runs.push(run);
      } catch {
        /* a corrupt file is skipped, never repaired in place */
      }
    }
  }
  runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return runs;
}
