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
import { hasLockedTerm } from './locked.js';

const MAX_ITEM_AGE_MS = MAX_ITEM_AGE_HOURS * 60 * 60 * 1000;

export const BLOCKED_FEED_STATUSES = new Set([401, 402, 403, 451]);
export const FEED_STATUSES = ['live', 'stale', 'blocked', 'dead'];

// Hosts that rate-limit concurrent requests (Google News answered 429 to the
// third of three parallel feeds in the first live run). Feeds on these hosts
// are fetched one at a time with a gap; every other feed runs in parallel.
export const SERIALIZED_HOSTS = new Set(['news.google.com']);
export const SERIALIZED_GAP_MS = 1500;
// A 429 is retried exactly once, after Retry-After (capped) or this default.
export const RETRY_AFTER_DEFAULT_MS = 5000;
export const RETRY_AFTER_MAX_MS = 30_000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Google News titles end in " - Publisher" (the source name). That suffix is
// not part of the headline: it reads as an extra claim or a tease to the
// scorer and clutters display. Stripped from aggregator feeds only; a direct
// feed's dash is left alone because it may be editorial.
export function stripPublisherSuffix(title) {
  const t = String(title || '');
  const idx = t.lastIndexOf(' - ');
  if (idx <= 0) return t;
  const suffix = t.slice(idx + 3).trim();
  if (!suffix || suffix.length > 60 || suffix.includes(' - ')) return t;
  const head = t.slice(0, idx).trim();
  return head.length >= MIN_HEADLINE_CHARS ? head : t;
}

function retryAfterMs(res) {
  const h = res?.headers?.get?.('retry-after');
  const secs = Number(h);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, RETRY_AFTER_MAX_MS);
  return RETRY_AFTER_DEFAULT_MS;
}

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
export async function fetchFeed(feed, { fetch = globalThis.fetch, timeoutMs = FEED_TIMEOUT_MS, sleep = defaultSleep } = {}) {
  const t0 = Date.now();
  let res;
  let retried = false;
  for (;;) {
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
    // Rate limited: wait as told (or the default) and try exactly once more.
    if (res.status === 429 && !retried) {
      retried = true;
      await sleep(retryAfterMs(res));
      continue;
    }
    break;
  }
  const ms = Date.now() - t0;
  if (!res.ok) return { status: 'error', httpStatus: res.status, reason: `HTTP ${res.status}${retried ? ' after retry' : ''}`, ms, retried };
  let xml;
  try {
    xml = await res.text();
  } catch (e) {
    return { status: 'error', httpStatus: res.status, reason: e?.message || 'read error', ms };
  }
  if (!looksLikeFeed(xml)) return { status: 'error', httpStatus: res.status, reason: 'not a feed', ms };
  const items = parseFeed(xml);
  if (!items.length) return { status: 'empty', httpStatus: res.status, reason: 'no items', ms, retried };
  return { status: 'ok', items, httpStatus: res.status, ms, retried };
}

/**
 * Fetch every feed: parallel across hosts, but feeds on a SERIALIZED_HOST are
 * fetched one after another with a gap. Results are returned in feed order.
 */
export async function fetchAllFeeds(feeds, { fetch = globalThis.fetch, timeoutMs = FEED_TIMEOUT_MS, sleep = defaultSleep } = {}) {
  const results = new Array(feeds.length);
  const serial = [];
  const parallel = [];
  feeds.forEach((f, i) => (SERIALIZED_HOSTS.has(hostOf(f.url)) ? serial : parallel).push(i));
  const one = async (i) => {
    results[i] = { feed: feeds[i], ...(await fetchFeed(feeds[i], { fetch, timeoutMs, sleep })) };
  };
  const serialRun = (async () => {
    for (let k = 0; k < serial.length; k++) {
      if (k > 0) await sleep(SERIALIZED_GAP_MS);
      await one(serial[k]);
    }
  })();
  await Promise.all([serialRun, ...parallel.map(one)]);
  return results;
}

/**
 * Pull every feed in parallel, gate, cap, and dedupe.
 *
 * @returns {{ rows, feeds }}
 *   rows  — [{ id, title, link, canonical, publication, owner, pubDate, undated,
 *             summary, thinBody }], deduped by canonical link, in feed order
 *   feeds — [{ name, owner, url, thinBody, status: 'live'|'stale'|'blocked'|'dead',
 *             httpStatus, reason, ms, fetched, kept, stale, malformed, undated,
 *             dupes, excluded }]  (excluded = locked-term policy, never stored)
 */
export async function collectHeadlines({
  feeds = FEEDS,
  fetch = globalThis.fetch,
  now = Date.now(),
  perFeed = HEADLINES_PER_FEED,
  timeoutMs = FEED_TIMEOUT_MS,
  sleep = defaultSleep,
} = {}) {
  const results = await fetchAllFeeds(feeds, { fetch, timeoutMs, sleep });

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
      retried: !!r.retried,
      fetched: 0,
      kept: 0,
      stale: 0,
      malformed: 0,
      undated: 0,
      dupes: 0,
      excluded: 0,
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

    const stat = { ...base, fetched: r.items.length, reason: r.retried ? 'recovered after 429 retry' : null };
    const candidates = [];
    const aggregator = SERIALIZED_HOSTS.has(hostOf(r.feed.url));
    for (const raw of r.items) {
      const item = aggregator ? { ...raw, title: stripPublisherSuffix(raw.title) } : raw;
      if (isMalformedTitle(item.title)) {
        stat.malformed++;
        continue;
      }
      // Locked-term policy: the item is never stored, in any field.
      if (hasLockedTerm(item.title) || hasLockedTerm(item.link) || hasLockedTerm(item.summary)) {
        stat.excluded++;
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
