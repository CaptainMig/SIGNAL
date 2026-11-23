// ---------------------------------------------------------------------------
// Feed ingestion: fetch every configured feed server-side, gate for sanity and
// freshness, cap per feed, and dedupe by CANONICAL LINK across all feeds.
//
// Returns the candidate rows plus a per-feed status record so run health can
// say exactly which feeds were live, stale, or dead and why. Nothing here is
// silent: every dropped item is counted.
// ---------------------------------------------------------------------------
import {
  FEEDS,
  FEED_TIMEOUT_MS,
  HEADLINES_PER_FEED,
  MAX_ITEM_AGE_HOURS,
  MIN_HEADLINE_CHARS,
  USER_AGENT,
} from './config.js';
import { parseFeed, looksLikeFeed } from './rss.js';
import { canonicalizeUrl, rowId } from './canonical.js';

const MAX_ITEM_AGE_MS = MAX_ITEM_AGE_HOURS * 60 * 60 * 1000;

export const BLOCKED_FEED_STATUSES = new Set([401, 402, 403, 451]);
export const FEED_STATUSES = ['live', 'stale', 'blocked', 'dead'];

/**
 * Freshness gate. 'fresh' = parseable date within MAX_ITEM_AGE_HOURS of now;
 * 'stale' = parseable but older; 'undated' = no parseable date (kept, tagged).
 * Dates slightly in the future (clock skew) count as fresh.
 */
export function classifyFreshness(pubDate, now = Date.now()) {
  if (!pubDate) return 'undated';
  const then = new Date(pubDate).getTime();
  if (!Number.isFinite(then)) return 'undated';
  return now - then > MAX_ITEM_AGE_MS ? 'stale' : 'fresh';
}

/**
 * Sanity filter: true when a cleaned "headline" is obviously not one — residual
 * HTML (double-encoded feeds), empty, or shorter than MIN_HEADLINE_CHARS.
 */
export function isMalformedTitle(title) {
  const t = (title || '').trim();
  if (!t) return true;
  if (/<\s*a\b|href\s*=|<\//i.test(t)) return true;
  if (/<[a-z!/][^>]*>/i.test(t)) return true;
  if (t.replace(/<[^>]*>/g, '').trim().length < MIN_HEADLINE_CHARS) return true;
  return false;
}

/**
 * Fetch and parse one feed. Never throws. Resolves to
 *   { status: 'ok', items, httpStatus, ms }
 *   { status: 'empty', httpStatus, ms, reason }     — fetched, no usable items
 *   { status: 'error', httpStatus?, ms, reason }    — network / HTTP / not a feed
 */
export async function fetchFeed(feed, { fetch = globalThis.fetch, timeoutMs = FEED_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(feed.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { status: 'error', reason: timeout ? 'timeout' : e?.message || 'network error', ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  if (!res.ok) return { status: 'error', httpStatus: res.status, reason: `HTTP ${res.status}`, ms };
  let xml;
  try {
    xml = await res.text();
  } catch (e) {
    return { status: 'error', httpStatus: res.status, reason: e?.message || 'read error', ms };
  }
  if (!looksLikeFeed(xml)) return { status: 'error', httpStatus: res.status, reason: 'not a feed', ms };
  const items = parseFeed(xml);
  if (!items.length) return { status: 'empty', httpStatus: res.status, reason: 'no items', ms };
  return { status: 'ok', items, httpStatus: res.status, ms };
}

/**
 * Pull every feed in parallel, gate, cap, and dedupe.
 *
 * @returns {{ rows, feeds }}
 *   rows  — [{ id, title, link, canonical, publication, owner, pubDate, undated,
 *             summary, thinBody }], deduped by canonical link, in feed order
 *   feeds — [{ name, owner, url, thinBody, status: 'live'|'stale'|'blocked'|'dead',
 *             httpStatus, reason, ms, fetched, kept, stale, malformed, undated,
 *             dupes }]
 */
export async function collectHeadlines({
  feeds = FEEDS,
  fetch = globalThis.fetch,
  now = Date.now(),
  perFeed = HEADLINES_PER_FEED,
  timeoutMs = FEED_TIMEOUT_MS,
} = {}) {
  const results = await Promise.all(feeds.map((f) => fetchFeed(f, { fetch, timeoutMs }).then((r) => ({ feed: f, ...r }))));

  const rows = [];
  const seen = new Set();
  const statuses = [];

  for (const r of results) {
    const base = {
      name: r.feed.name,
      owner: r.feed.owner,
      url: r.feed.url,
      thinBody: !!r.feed.thinBody,
      httpStatus: r.httpStatus ?? null,
      ms: r.ms,
      fetched: 0,
      kept: 0,
      stale: 0,
      malformed: 0,
      undated: 0,
      dupes: 0,
    };
    if (r.status === 'error') {
      // A publisher refusing the runner (401/402/403/451) is 'blocked' — a
      // property of the source, listed as such in run health and never
      // dropped silently. Every other failure is 'dead' (transient until it
      // isn't).
      const blocked = BLOCKED_FEED_STATUSES.has(r.httpStatus);
      statuses.push({ ...base, status: blocked ? 'blocked' : 'dead', reason: r.reason });
      continue;
    }
    if (r.status === 'empty') {
      statuses.push({ ...base, status: 'stale', reason: r.reason });
      continue;
    }

    const stat = { ...base, fetched: r.items.length, reason: null };
    const candidates = [];
    for (const item of r.items) {
      if (isMalformedTitle(item.title)) {
        stat.malformed++;
        continue;
      }
      const freshness = classifyFreshness(item.pubDate, now);
      if (freshness === 'stale') {
        stat.stale++;
        continue;
      }
      candidates.push({ item, freshness });
    }
    // Newest first (dated before undated), then cap per feed. v1 capped before
    // filtering, which let stale items crowd out fresh ones.
    candidates.sort((a, b) => {
      const ta = a.freshness === 'undated' ? -Infinity : new Date(a.item.pubDate).getTime();
      const tb = b.freshness === 'undated' ? -Infinity : new Date(b.item.pubDate).getTime();
      return tb - ta;
    });

    for (const { item, freshness } of candidates) {
      if (stat.kept >= perFeed) break;
      const canonical = canonicalizeUrl(item.link);
      if (!canonical) {
        stat.malformed++;
        continue;
      }
      if (seen.has(canonical)) {
        stat.dupes++;
        continue;
      }
      seen.add(canonical);
      stat.kept++;
      if (freshness === 'undated') stat.undated++;
      const iso = freshness === 'undated' ? null : new Date(item.pubDate).toISOString();
      rows.push({
        id: rowId(canonical),
        title: item.title,
        link: item.link,
        canonical,
        publication: r.feed.name,
        owner: r.feed.owner,
        pubDate: iso,
        undated: freshness === 'undated',
        // Aggregator / paywalled feeds carry no usable body: empty it so the
        // row is scored for tone only, never headline-vs-snippet.
        summary: r.feed.thinBody ? '' : item.summary || '',
        thinBody: !!r.feed.thinBody,
      });
    }

    // Fetched fine but nothing survived the gates → the feed is serving a
    // frozen snapshot or junk. Reported as stale, never silently vanished.
    if (stat.kept === 0) {
      stat.reason = stat.stale > 0 && stat.malformed === 0 ? 'all items stale' : stat.dupes > 0 && stat.stale + stat.malformed === 0 ? 'all items duplicates' : 'no usable items';
      statuses.push({ ...stat, status: 'stale' });
    } else {
      statuses.push({ ...stat, status: 'live' });
    }
  }

  return { rows, feeds: statuses };
}
