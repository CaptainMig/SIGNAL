// POST /api/fetch-article — the second extraction route. The scan job calls
// it when the GitHub runner's address was refused or answered nothing, and
// the same fetch chain runs from Vercel's network instead.
//
// Guard rails: a shared token (SIGNAL_FETCH_TOKEN, also a repository secret)
// is required, so visitors cannot drive it; only the publishers in FEEDS are
// fetchable, so it is never an open proxy; the text goes back to the scan job
// to be scored and discarded, exactly as the runner's own fetches are. No
// model is called here and no key is read here.
import { timingSafeEqual } from 'node:crypto';
import { fetchArticle, registrableHost } from '../pipeline/extract.js';
import { ARTICLE_HOSTS, EXTRACT_TIMEOUT_MS } from '../pipeline/config.js';

export function allowedArticleHost(url, hosts = ARTICLE_HOSTS) {
  if (!/^https?:\/\//i.test(String(url || ''))) return false;
  const host = registrableHost(url);
  return !!host && hosts.includes(host);
}

export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'error', detail: 'POST only' });
  const expected = process.env.SIGNAL_FETCH_TOKEN;
  if (!expected) return res.status(503).json({ ok: false, reason: 'error', detail: 'remote route not configured' });
  if (!tokenMatches(req.headers['x-signal-fetch-token'], expected)) return res.status(401).json({ ok: false, reason: 'error', detail: 'unauthorized' });
  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const url = String(body.url || '');
  if (!allowedArticleHost(url)) return res.status(400).json({ ok: false, reason: 'error', detail: 'host not allowed' });
  const timeoutMs = Math.min(Number(body.timeoutMs) || EXTRACT_TIMEOUT_MS, 25_000);
  const r = await fetchArticle(url, { timeoutMs });
  return res.status(200).json({ ...r, route: 'vercel' });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
