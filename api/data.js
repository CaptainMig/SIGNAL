// GET /api/data?file=latest|history|aggregate[&pack=<key>] — the ledger, read
// at runtime from the repository, one pack at a time. Read-only; there is no
// POST anywhere in this site.
import { ALLOWED, cors, readLedgerFile } from './_ledger.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = String(req.query?.file || '');
  if (!ALLOWED[key]) return res.status(404).json({ error: 'unknown file', allowed: Object.keys(ALLOWED) });

  const pack = String(req.query?.pack || '') || undefined;
  const out = await readLedgerFile(key, { pack });
  if (!out.ok) {
    // A failure is never cached, at the edge or by the browser: a pack's
    // first run must appear on the next request.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    return res.status(out.status).json({ error: out.reason, ...(out.path ? { path: out.path } : {}), ...(out.upstream ? { upstream: out.upstream } : {}) });
  }
  res.setHeader('Content-Type', out.type);
  // The ledger changes hourly; a short edge cache keeps the repository out
  // of the hot path without serving stale runs. The built current view is
  // the expensive one (the latest scan plus every scan its carried
  // references name), so its edge copy lives longer.
  res.setHeader('Cache-Control', out.built ? 'public, s-maxage=300, stale-while-revalidate=3600' : 'public, s-maxage=120, stale-while-revalidate=600');
  res.setHeader('X-Signal-Source', out.source);
  return res.status(200).send(out.body);
}
