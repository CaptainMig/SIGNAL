// Constant-time comparison for the shared secrets the server-side routes
// require (the fetch route and the scan trigger). Never logs, never throws.
import { timingSafeEqual } from 'node:crypto';

export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// The token a request carries: a dedicated header, a bearer header, or (for
// schedulers that cannot set headers) a query parameter.
export function presentedToken(req, headerName) {
  const h = req.headers?.[headerName];
  if (h) return String(h);
  const auth = req.headers?.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  try {
    const u = new URL(req.url || '/', 'http://local');
    return u.searchParams.get('token') || '';
  } catch {
    return '';
  }
}
