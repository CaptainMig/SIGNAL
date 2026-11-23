// ---------------------------------------------------------------------------
// Article text extraction for full-text escalation.
//
// Deliberately light — no headless browser, no readability dependency. The
// text is sent to the scorer and DISCARDED; the ledger stores only its length
// and the route that produced it.
//
// Where the text comes from, in order of preference: the paragraph text of
// the largest <article> / <main> container on the page (the FIRST container
// is often a teaser card — DEFECTS.md v2-33), or the publisher's own
// JSON-LD `articleBody` when it is longer.
//
// How the page is fetched: a chain of identities and routes, each tried only
// when the previous one failed for a reason the next could fix.
//   1. the runner, full Chrome client-hint headers (the bare Chrome user agent
//      is tarpitted by the Washington Post — DEFECTS.md v2-34)
//   2. the runner, a Firefox identity (the "different user agent" retry)
//   3. the runner, with a consent cookie, when a consent wall was served
//   4. the publisher's own text / AMP rendering, where one exists
// A Vercel-side route (api/fetch-article.js) is a fifth step, driven from
// run.js, for publishers that refuse the GitHub runner's address.
//
// Failure reasons are a closed set so the UI can say exactly why a row could
// not earn a full-text verdict:
//   blocked    — the publisher refuses automated retrieval (401/402/403/451),
//                serves a server-truncated paywall teaser, a consent wall, or
//                a stub. A property of the SOURCE: "UNVERIFIABLE — SOURCE
//                BLOCKED", never a judgment on the outlet or the story.
//   timeout    — the origin did not answer in time. A later attempt may succeed.
//   no_article — a video page with no article text. Nothing to retry.
//   error      — any other HTTP / network failure.
// ---------------------------------------------------------------------------
import { EXTRACT_IDENTITIES, EXTRACT_MAX_CHARS, EXTRACT_MIN_CHARS, EXTRACT_TIMEOUT_MS } from './config.js';

export const BLOCKED_STATUSES = new Set([401, 402, 403, 451]);
export const FAILURE_REASONS = ['blocked', 'timeout', 'error', 'no_article'];
export const ROUTES = ['runner', 'alt-identity', 'consent-cookie', 'alternate', 'vercel'];

// Consent cookies a publisher sets itself when a visitor accepts its choice
// page; sent only after that page was served.
export const CONSENT_COOKIES = {
  'npr.org': () => `trackingChoice=true; choiceVersion=1; dateOfChoice=${Date.now()}`,
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const normalize = (t) => decodeEntities(String(t || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Paragraph-level text of one container; crumbs (bylines, timestamps,
// buttons) are dropped.
function paragraphs(container) {
  return [...container.matchAll(/<(p|h1|h2|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => normalize(m[2]))
    .filter((t) => t.length > 40)
    .join('\n\n');
}

// JSON-LD on the page: article bodies, the types present, and whether the
// publisher marks the article as not free (a paywall signal).
export function readJsonLd(html) {
  const out = { bodies: [], types: new Set(), accessibleForFree: null };
  const blocks = [...String(html || '').matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const t = node['@type'];
    if (typeof t === 'string') out.types.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && out.types.add(x));
    if (typeof node.articleBody === 'string') out.bodies.push(node.articleBody);
    if (node.isAccessibleForFree === false || node.isAccessibleForFree === 'False' || node.isAccessibleForFree === 'false') out.accessibleForFree = false;
    else if (node.isAccessibleForFree === true && out.accessibleForFree == null) out.accessibleForFree = true;
    if (node['@graph']) visit(node['@graph']);
  };
  for (const b of blocks) {
    try {
      visit(JSON.parse(b));
    } catch {
      // Malformed JSON-LD: still harvest what a regex can see.
      const m = b.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) {
        try {
          out.bodies.push(JSON.parse(`"${m[1]}"`));
        } catch {
          /* unreadable body */
        }
      }
      for (const t of b.matchAll(/"@type"\s*:\s*"([A-Za-z]+)"/g)) out.types.add(t[1]);
    }
  }
  return out;
}

/**
 * HTML -> readable text. Returns { text, title, source, video, paywalled }.
 *   source    'markup' | 'ld+json' — where the winning text came from
 *   video     a video page (VideoObject, no article body) — nothing to retry
 *   paywalled the publisher marks the article as not free
 */
export function extractText(html, { maxChars = EXTRACT_MAX_CHARS } = {}) {
  const raw = String(html || '');
  const ld = readJsonLd(raw);
  const s = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside|figure|figcaption|button)\b[\s\S]*?<\/\1>/gi, ' ');

  // Largest container wins: every <article>, then <main>, then the whole page.
  const candidates = [...s.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => m[0]);
  const main = s.match(/<main\b[\s\S]*?<\/main>/i)?.[0];
  if (main) candidates.push(main);
  candidates.push(s);
  let best = '';
  for (const c of candidates) {
    const t = paragraphs(c);
    if (t.length > best.length) best = t;
  }
  let source = 'markup';
  for (const b of ld.bodies) {
    const t = normalize(b);
    if (t.length > best.length) {
      best = t;
      source = 'ld+json';
    }
  }
  const text = best.slice(0, maxChars);
  const title = normalize(s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const isArticle = ['NewsArticle', 'Article', 'ReportageNewsArticle', 'AnalysisNewsArticle', 'OpinionNewsArticle', 'LiveBlogPosting'].some((t) => ld.types.has(t));
  const video = ld.types.has('VideoObject') && !ld.bodies.length && (!isArticle || text.length < EXTRACT_MIN_CHARS);
  return { text, title, source, video, paywalled: ld.accessibleForFree === false };
}

// A video page is known from its URL before any fetch: never attempted,
// counted beside the rate (DEFECTS.md v2-35).
export function isVideoUrl(url) {
  try {
    const u = new URL(url);
    return /^video\./i.test(u.hostname) || /(^|\/)(video|videos|watch)(\/|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

// Host-specific alternate URLs: a text or AMP rendering the publisher offers.
export function alternateUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'washingtonpost.com') {
    if (u.searchParams.get('outputType') === 'amp') return null;
    u.searchParams.set('outputType', 'amp');
    return u.toString();
  }
  if (host === 'npr.org') {
    const m = u.pathname.match(/\/(nx-s\d+-\d+|g-s\d+-\d+|\d{6,})(?=[/?#]|$)/);
    return m ? `https://text.npr.org/${m[1]}` : null;
  }
  return null;
}

export function registrableHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const parts = h.split('.');
    return parts.length > 2 && !/\.(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(h) ? parts.slice(-2).join('.') : parts.length > 3 ? parts.slice(-3).join('.') : h;
  } catch {
    return '';
  }
}

// A consent wall: the response landed on a consent / choice host, or the
// page is a short "before you continue" shell.
export function looksLikeConsentWall({ finalUrl = '', title = '', chars = 0 } = {}) {
  let host = '';
  let pathname = '';
  try {
    const u = new URL(finalUrl);
    host = u.hostname.toLowerCase();
    pathname = u.pathname.toLowerCase();
  } catch {
    /* no final url */
  }
  if (/(^|\.)(consent|choice|privacy)\./.test(host) || /\/consent(\/|$)/.test(pathname)) return true;
  return chars < EXTRACT_MIN_CHARS && /before you continue|your privacy choices|we value your privacy|consent|accept (all )?cookies|cookie (settings|preferences)/i.test(title);
}

async function fetchOnce(url, { fetch, timeoutMs, headers }) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { error: timeout ? 'timeout' : 'error', detail: timeout ? 'timeout' : e?.message || 'network error', ms: Date.now() - t0 };
  }
  let html = '';
  let readError = null;
  if (res.status >= 200 && res.status < 300) {
    try {
      html = await res.text();
    } catch (e) {
      readError = e?.message || 'read error';
    }
  }
  return { status: res.status, finalUrl: res.url || url, html, readError, ms: Date.now() - t0 };
}

function classify(r, minChars) {
  if (r.error) return { ok: false, reason: r.error, detail: r.detail };
  if (BLOCKED_STATUSES.has(r.status)) return { ok: false, reason: 'blocked', detail: `HTTP ${r.status}`, httpStatus: r.status };
  if (r.status < 200 || r.status >= 300) return { ok: false, reason: 'error', detail: `HTTP ${r.status}`, httpStatus: r.status };
  if (r.readError) return { ok: false, reason: 'error', detail: r.readError, httpStatus: r.status };
  const ex = extractText(r.html);
  if (ex.text.length >= minChars) return { ok: true, text: ex.text, chars: ex.text.length, title: ex.title, httpStatus: r.status, source: ex.source };
  if (ex.video) return { ok: false, reason: 'no_article', detail: 'video page', chars: ex.text.length, httpStatus: r.status };
  if (looksLikeConsentWall({ finalUrl: r.finalUrl, title: ex.title, chars: ex.text.length })) return { ok: false, reason: 'blocked', detail: 'consent wall', chars: ex.text.length, httpStatus: r.status, consent: true };
  // Stub — paywall teaser / shell. Honest failure, never a fragment.
  return { ok: false, reason: 'blocked', detail: ex.paywalled ? 'paywall' : 'stub', chars: ex.text.length, httpStatus: r.status };
}

// The most informative failure across attempts: a video page is final; a
// publisher refusal beats a timeout; a timeout beats a generic error.
const RANK = { no_article: 4, blocked: 3, timeout: 2, error: 1 };
function worst(results) {
  return results.reduce((a, b) => (!a || RANK[b.reason] > RANK[a.reason] ? b : a), null);
}

/**
 * Fetch an article and extract its text through the identity / route chain.
 * Never throws.
 *   { ok: true, text, chars, title, httpStatus, source, route, attempts, ms }
 *   { ok: false, reason, detail, chars?, httpStatus?, route: null, attempts, ms, tried: [routes] }
 */
export async function fetchArticle(
  url,
  { fetch = globalThis.fetch, timeoutMs = EXTRACT_TIMEOUT_MS, minChars = EXTRACT_MIN_CHARS, identities = EXTRACT_IDENTITIES, alternate = alternateUrl, consentCookies = CONSENT_COOKIES } = {}
) {
  const t0 = Date.now();
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return { ok: false, reason: 'error', detail: 'invalid url', route: null, attempts: 0, ms: 0, tried: [] };
  }
  const results = [];
  const tried = [];
  const attempt = async (route, target, identity, extraHeaders = {}) => {
    tried.push(route);
    const r = await fetchOnce(target, { fetch, timeoutMs, headers: { ...identity.headers, ...extraHeaders } });
    const c = classify(r, minChars);
    results.push(c);
    if (c.ok) return { ...c, route, attempts: results.length, ms: Date.now() - t0, tried: tried.slice() };
    return null;
  };
  const [primary, secondary] = identities;

  // 1. The runner, primary identity.
  let hit = await attempt('runner', url, primary);
  if (hit) return hit;
  let last = results[results.length - 1];
  // A video page is final; nothing else about it will change.
  if (last.reason === 'no_article') return { ...last, route: null, attempts: results.length, ms: Date.now() - t0, tried };

  // 2. A different identity, for refusals, tarpits and stubs alike.
  if (secondary) {
    hit = await attempt('alt-identity', url, secondary);
    if (hit) return hit;
    last = results[results.length - 1];
    if (last.reason === 'no_article') return { ...last, route: null, attempts: results.length, ms: Date.now() - t0, tried };
  }

  // 3. A consent wall was served and the publisher's own accept cookie is known.
  if (results.some((r) => r.consent)) {
    const cookie = consentCookies[registrableHost(url)];
    if (cookie) {
      hit = await attempt('consent-cookie', url, secondary || primary, { Cookie: typeof cookie === 'function' ? cookie() : cookie });
      if (hit) return hit;
    }
  }

  // 4. The publisher's own text / AMP rendering.
  const alt = alternate ? alternate(url) : null;
  if (alt) {
    hit = await attempt('alternate', alt, secondary || primary);
    if (hit) return hit;
  }

  const w = worst(results);
  return { ...w, route: null, attempts: results.length, ms: Date.now() - t0, tried };
}

/**
 * The Vercel-side route: POST the URL to api/fetch-article.js, which runs the
 * same chain from Vercel's network. Returns the same result shape with
 * route 'vercel'. Never throws; a misconfigured or unreachable route is an
 * error result, never a crash of the run.
 */
export function createRemoteFetch({ url, token, fetch = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (!url || !token) return null;
  return async (articleUrl, { timeoutMs: perFetch = EXTRACT_TIMEOUT_MS } = {}) => {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signal-fetch-token': token },
        body: JSON.stringify({ url: articleUrl, timeoutMs: perFetch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, reason: 'error', detail: `remote route HTTP ${res.status}`, route: 'vercel', attempts: 0, ms: Date.now() - t0 };
      const body = await res.json();
      if (body && body.ok && typeof body.text === 'string' && body.text.length >= EXTRACT_MIN_CHARS) {
        return { ok: true, text: body.text, chars: body.text.length, title: body.title || '', httpStatus: body.httpStatus ?? null, source: body.source || 'markup', route: 'vercel', attempts: body.attempts || 1, ms: Date.now() - t0 };
      }
      return { ok: false, reason: FAILURE_REASONS.includes(body?.reason) ? body.reason : 'error', detail: body?.detail || 'remote route returned nothing', chars: body?.chars ?? null, httpStatus: body?.httpStatus ?? null, route: 'vercel', attempts: body?.attempts || 1, ms: Date.now() - t0 };
    } catch (e) {
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return { ok: false, reason: timeout ? 'timeout' : 'error', detail: timeout ? 'remote route timeout' : `remote route: ${e?.message || 'error'}`, route: 'vercel', attempts: 0, ms: Date.now() - t0 };
    }
  };
}
