// GET /api/data?file=latest|history|aggregate — the ledger, read at runtime
// from the repository. Read-only; there is no POST anywhere in this site.
import { ALLOWED, cors, readLedgerFile } from './_ledger.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = String(req.query?.file || '');
  if (!ALLOWED[key]) return res.status(404).json({ error: 'unknown file', allowed: Object.keys(ALLOWED) });

  const out = await readLedgerFile(key);
  if (!out.ok) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(out.status).json({ error: out.reason });
  }
  res.setHeader('Content-Type', out.type);
  // The ledger changes hourly; a short edge cache keeps the repository out
  // of the hot path without serving stale runs.
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
  res.setHeader('X-Signal-Source', out.source);
  return res.status(200).send(out.body);
}
