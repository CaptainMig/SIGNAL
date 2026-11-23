// GET /api/aggregate — the Signal → AnthonyCharts contract, served from the
// ledger. Same response shape as v1 ({ asOf, windowHours, scored, total,
// meanIntegrity, medianIntegrity, source }, plus the v2 fields), so the
// anthonycharts generator keeps working. No POST: the number comes from the
// scheduled runs only.
import { cors, readLedgerFile } from './_ledger.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const out = await readLedgerFile('aggregate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!out.ok) {
    // The honest empty snapshot: scored 0 trips the generator's guard.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ asOf: null, windowHours: 24, scored: 0, total: 0, meanIntegrity: null, medianIntegrity: null, source: 'unavailable', error: out.reason });
  }
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
  return res.status(200).send(out.body);
}
