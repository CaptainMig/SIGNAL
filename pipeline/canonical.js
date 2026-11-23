// ---------------------------------------------------------------------------
// Canonical article links and stable row ids.
//
// Rows are deduped by canonical link (not by headline text — two outlets can
// run the same wire headline and both deserve their own row; one outlet can
// syndicate the same URL into three section feeds and deserves one row).
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';

// Query parameters that never identify content. Prefix match for utm_* and
// the common click-id families; exact match for the rest.
const TRACKING_PREFIXES = ['utm_', 'mc_', 'at_', 'ns_', 'pk_', 'ga_', 'hsa_'];
const TRACKING_EXACT = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'twclid', 'igshid', 'yclid', 'ttclid',
  'ref', 'cmpid', 'cmp', 'ocid', 'ito', 'oc', 'smid', 'smtyp', 'ncid', 'rss',
  'partner', 'source', 'src', 'feed', 'ftag', 'cid', 'ICID', 'icid', 'WT.mc_id',
  'taid', 'mbid', 'sref', 'ref_src', 'ref_url', 'referrer', 'ei', 'ved', 'usg',
  '__twitter_impression', '_ga', '_gl', 'spm',
]);

function isTracking(key) {
  if (TRACKING_EXACT.has(key)) return true;
  const k = key.toLowerCase();
  return TRACKING_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Canonical form of an article URL: https, lowercase host without a leading
 * www., no fragment, tracking parameters removed, remaining parameters sorted,
 * trailing slash and index.html trimmed. Returns the trimmed input unchanged
 * when it is not a parseable http(s) URL.
 */
export function canonicalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return s;
  u.protocol = 'https:';
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.port === '443' || u.port === '80') u.port = '';

  const kept = [...u.searchParams.entries()].filter(([k]) => !isTracking(k));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  let path = u.pathname.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '');
  if (!path) path = '';
  u.pathname = path || '/';

  let out = u.toString();
  if (u.pathname === '/' && !u.search) out = out.replace(/\/$/, '');
  return out;
}

// Stable row id: twelve hex chars of SHA-256 over the canonical link.
export function rowId(canonical) {
  return createHash('sha256').update(String(canonical)).digest('hex').slice(0, 12);
}
