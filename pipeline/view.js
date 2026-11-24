// ---------------------------------------------------------------------------
// The current view, built on demand (docs/schema-brief.md §4, step 2,
// approved 2026-11-24): latest.json is no longer committed. The newest scan
// file plus the scan files its carried references name ARE the current
// view; this module assembles it for the API (cached at the edge) and for
// the scripts that used to read latest.json. Nothing here writes.
//
// data/pointer.json, rewritten by every run (about 3 KB), names the latest
// scan file and maps every run id in the reuse window to its file, so a
// reader never lists directories. Scan files stay append-only deltas.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PACK, packOf } from './config.js';
import { ledgerPaths, readPointer } from './ledger.js';

export function referencedRuns(run) {
  return [...new Set((run?.carried || []).map((r) => r.run))];
}

/**
 * Assemble one pack's current view from a run (delta) and a loader for the
 * runs its carried references name. `loadRun(id)` resolves to a parsed scan
 * file or null; unresolved references are counted, never fabricated.
 */
export async function buildCurrentView({ run, loadRun, pack = DEFAULT_PACK }) {
  const refs = run.carried || [];
  const ids = referencedRuns(run);
  const loaded = await Promise.all(ids.map(async (id) => [id, await loadRun(id)]));
  const index = new Map();
  for (const [id, r] of loaded) if (r) for (const row of r.rows || []) index.set(`${id}\n${row.id}`, row);
  const rows = [...(run.rows || [])];
  let unresolvedCarried = 0;
  for (const ref of refs) {
    const row = index.get(`${ref.run}\n${ref.id}`);
    if (row) rows.push(row);
    else unresolvedCarried++;
  }
  const { rows: _rows, carried: _carried, views, packs, ...telemetry } = run;
  const view = views?.[pack] || {};
  return {
    ...telemetry,
    pack,
    summary: packs?.[pack] || run.summary,
    scorecards: view.scorecards ?? null,
    ...(view.metros ? { metros: view.metros } : {}),
    rows: rows.filter((r) => packOf(r) === pack),
    unresolvedCarried,
    builtAt: new Date().toISOString(),
  };
}

// For scripts on the runner or a laptop: the same view from the files on disk.
export async function currentViewFromDisk({ root = '.', pack = DEFAULT_PACK } = {}) {
  const pointer = await readPointer({ root });
  if (!pointer?.latest?.file) return null;
  const base = ledgerPaths(root).base;
  const readRun = async (rel) => {
    try {
      return JSON.parse(await fs.readFile(path.join(base, rel), 'utf8'));
    } catch {
      return null;
    }
  };
  const run = await readRun(pointer.latest.file);
  if (!run) return null;
  return buildCurrentView({ run, loadRun: (id) => (pointer.runs?.[id] ? readRun(pointer.runs[id]) : Promise.resolve(null)), pack });
}
