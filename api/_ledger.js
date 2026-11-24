// ---------------------------------------------------------------------------
// Ledger access for the serverless functions. The site reads the ledger AT
// RUNTIME from the repository, so the hourly data commits never need a
// deployment. Three allowed files; nothing else is reachable.
//
// Source resolution:
//   SIGNAL_DATA_LOCAL=1   read ./data/<file> from disk (local dev server)
//   otherwise             fetch raw.githubusercontent.com/<owner>/<repo>/<ref>/data/<file>
//                         owner/repo/ref come from Vercel's system env
//                         (VERCEL_GIT_REPO_OWNER / _SLUG / _COMMIT_REF) with
//                         fallbacks; GITHUB_TOKEN, when set, is sent so a
//                         private repository works. A public repository
//                         needs no configuration at all.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PACK, PACK_KEYS } from '../pipeline/config.js';
import { buildCurrentView } from '../pipeline/view.js';

export const ALLOWED = {
  // Built on demand from pointer.json and the scan files it names; never a
  // committed file (docs/schema-brief.md §4).
  latest: { file: 'pointer.json', type: 'application/json; charset=utf-8', built: true },
  history: { file: 'history.csv', type: 'text/csv; charset=utf-8' },
  aggregate: { file: 'aggregate.json', type: 'application/json; charset=utf-8' },
  stats: { file: 'stats.csv', type: 'text/csv; charset=utf-8' },
  daily: { file: 'daily.json', type: 'application/json; charset=utf-8' },
  'validation-set': { file: 'validation/set.json', type: 'application/json; charset=utf-8' },
  'validation-agreement': { file: 'validation/agreement.json', type: 'application/json; charset=utf-8' },
};

export function repoCoordinates(env = process.env) {
  return {
    owner: env.SIGNAL_REPO_OWNER || env.VERCEL_GIT_REPO_OWNER || 'CaptainMig',
    repo: env.SIGNAL_REPO_NAME || env.VERCEL_GIT_REPO_SLUG || 'SIGNAL',
    ref: env.SIGNAL_DATA_REF || 'main',
  };
}

/**
 * Read one ledger file. Returns { ok: true, body, type, source } or
 * { ok: false, status, reason }. Never throws.
 */
// Per-pack files live under packs/<key>/; the national pack is data/ itself.
// The validation set is national only.
export function packPath(key, pack) {
  const entry = ALLOWED[key];
  if (!entry) return null;
  const p = pack || DEFAULT_PACK;
  if (!PACK_KEYS.includes(p)) return null;
  if (p === DEFAULT_PACK || key.startsWith('validation')) return entry.file;
  return `packs/${p}/${entry.file}`;
}

// One ledger path, relative to data/, from disk (SIGNAL_DATA_LOCAL) or the
// repository. Never throws.
export async function readDataPath(file, { env = process.env, fetch = globalThis.fetch, fresh = false } = {}) {
  if (env.SIGNAL_DATA_LOCAL) {
    const local = path.join(env.SIGNAL_DATA_DIR || 'data', file);
    try {
      return { ok: true, body: await fs.readFile(local, 'utf8'), source: 'local' };
    } catch (e) {
      return { ok: false, status: e?.code === 'ENOENT' ? 404 : 502, reason: `data/${file}: ${e?.code === 'ENOENT' ? 'not found on disk' : e?.message || 'read error'}`, path: `data/${file}`, upstream: local };
    }
  }
  const { owner, repo, ref } = repoCoordinates(env);
  // pointer.json changes every run and the raw CDN holds a copy (and a
  // miss) for up to five minutes: a per-minute query string keeps a pack's
  // first run from hiding behind a cached 404 (DEFECTS.md v2-50). Scan
  // files are append-only and named by the pointer, so they cache freely.
  const bust = fresh ? `?t=${Math.floor(Date.now() / 60_000)}` : '';
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/data/${file}${bust}`;
  const headers = { 'User-Agent': 'signal-site', Accept: '*/*' };
  if (env.GITHUB_TOKEN) headers.Authorization = `token ${env.GITHUB_TOKEN}`;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      // The real reason and the path that failed; nothing is guessed about
      // the repository's visibility.
      return { ok: false, status: r.status === 404 ? 404 : 502, reason: `data/${file}: upstream HTTP ${r.status}`, path: `data/${file}`, upstream: url.replace(/\?t=\d+$/, '') };
    }
    return { ok: true, body: await r.text(), source: 'github' };
  } catch (e) {
    return { ok: false, status: 504, reason: `data/${file}: ${e?.name === 'TimeoutError' ? 'upstream timeout' : e?.message || 'fetch failed'}`, path: `data/${file}`, upstream: url.replace(/\?t=\d+$/, '') };
  }
}

// The current view, built from the latest scan plus its carried references
// and kept in this instance while the pointer does not change; the edge
// cache in front of it (api/data.js) keeps a copy for five minutes.
const viewCache = new Map();
export async function buildLatestView({ env = process.env, fetch = globalThis.fetch, pack = DEFAULT_PACK } = {}) {
  if (!PACK_KEYS.includes(pack)) return { ok: false, status: 404, reason: 'unknown pack' };
  const p = await readDataPath('pointer.json', { env, fetch, fresh: true });
  if (!p.ok) return p.status === 404 ? { ...p, reason: `no run recorded yet (${p.reason})` } : p;
  let pointer;
  try {
    pointer = JSON.parse(p.body);
  } catch {
    return { ok: false, status: 502, reason: 'pointer unreadable' };
  }
  if (!pointer?.latest?.file) return { ok: false, status: 404, reason: 'no run recorded yet' };
  const cacheKey = `${pack}\n${pointer.latest.id}\n${pointer.latest.file}`;
  const cached = viewCache.get(cacheKey);
  if (cached) return { ...cached, source: `${cached.source} (instance cache)` };
  const files = new Map();
  const readRun = async (file) => {
    if (!files.has(file)) files.set(file, readDataPath(file, { env, fetch }).then((r) => (r.ok ? JSON.parse(r.body) : null)).catch(() => null));
    return files.get(file);
  };
  const latest = await readDataPath(pointer.latest.file, { env, fetch });
  if (!latest.ok) return { ...latest, status: 502, reason: `latest scan unreadable: ${latest.reason}` };
  let run;
  try {
    run = JSON.parse(latest.body);
  } catch {
    return { ok: false, status: 502, reason: `latest scan unparseable: data/${pointer.latest.file}`, path: `data/${pointer.latest.file}` };
  }
  files.set(pointer.latest.file, Promise.resolve(run));
  // A pack that has not been scanned yet has no summary in the latest run:
  // say so, with a status the site reads as "no run recorded yet for this
  // pack", and never cache it (DEFECTS.md v2-50).
  if (run.packs && !run.packs[pack]) return { ok: false, status: 404, reason: `no run recorded yet for pack ${pack}`, path: `data/${pointer.latest.file}` };
  const view = await buildCurrentView({ run, loadRun: (id) => (pointer.runs?.[id] ? readRun(pointer.runs[id]) : Promise.resolve(null)), pack });
  const out = { ok: true, body: JSON.stringify(view), type: ALLOWED.latest.type, source: p.source, built: true };
  viewCache.clear();
  viewCache.set(cacheKey, out);
  return out;
}

export async function readLedgerFile(key, { env = process.env, fetch = globalThis.fetch, pack = DEFAULT_PACK } = {}) {
  const entry = ALLOWED[key];
  if (!entry) return { ok: false, status: 404, reason: 'unknown file' };
  if (entry.built) return buildLatestView({ env, fetch, pack });
  const file = packPath(key, pack);
  if (!file) return { ok: false, status: 404, reason: 'unknown pack' };
  const r = await readDataPath(file, { env, fetch });
  return r.ok ? { ok: true, body: r.body, type: entry.type, source: r.source } : r;
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
