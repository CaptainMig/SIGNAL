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

export const ALLOWED = {
  latest: { file: 'latest.json', type: 'application/json; charset=utf-8' },
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

export async function readLedgerFile(key, { env = process.env, fetch = globalThis.fetch, pack = DEFAULT_PACK } = {}) {
  const entry = ALLOWED[key];
  if (!entry) return { ok: false, status: 404, reason: 'unknown file' };
  const file = packPath(key, pack);
  if (!file) return { ok: false, status: 404, reason: 'unknown pack' };

  if (env.SIGNAL_DATA_LOCAL) {
    try {
      const body = await fs.readFile(path.join(env.SIGNAL_DATA_DIR || 'data', file), 'utf8');
      return { ok: true, body, type: entry.type, source: 'local' };
    } catch (e) {
      return { ok: false, status: 404, reason: e?.message || 'not found' };
    }
  }

  const { owner, repo, ref } = repoCoordinates(env);
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/data/${file}`;
  const headers = { 'User-Agent': 'signal-site', Accept: '*/*' };
  if (env.GITHUB_TOKEN) headers.Authorization = `token ${env.GITHUB_TOKEN}`;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      const reason = r.status === 404 && !env.GITHUB_TOKEN ? 'not found (a private repository needs GITHUB_TOKEN in the Vercel environment)' : `upstream HTTP ${r.status}`;
      return { ok: false, status: r.status === 404 ? 404 : 502, reason };
    }
    return { ok: true, body: await r.text(), type: entry.type, source: 'github' };
  } catch (e) {
    return { ok: false, status: 504, reason: e?.name === 'TimeoutError' ? 'upstream timeout' : e?.message || 'fetch failed' };
  }
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
