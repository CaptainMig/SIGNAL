// ---------------------------------------------------------------------------
// Article text extraction for full-text escalation.
//
// Deliberately light — no headless browser, no readability dependency. The
// text is sent to the scorer and DISCARDED; the ledger stores only its length.
//
// Fetch policy (operator decision, DEFECTS.md v2-40): ONE fetch, with ONE
// honest user agent that names Signal and carries a contact URL (config
// USER_AGENT), after robots.txt has been honoured (robots.js). No browser
// identities, no retries under another name, no consent-cookie workarounds,
// no second network route. A publisher that refuses (401/402/403/451), or
// serves a paywall teaser, a consent wall or a stub, is SOURCE BLOCKED and
// the row is scored headline-only.
//
// Where the text comes from: the paragraph text of the largest <article> /
// <main> container on the page (the FIRST container is often a teaser card
// — DEFECTS.md v2-33), or the publisher's own JSON-LD `articleBody` when it
// is longer. Video pages are known from the URL and never fetched (v2-35).
//
// Failure reasons are a closed set so the UI can say exactly why a row could
// not earn a full-text verdict:
//   blocked    — the publisher refuses automated retrieval (HTTP 401/402/403/
//                451, or robots.txt), or serves a server-truncated paywall
//                teaser, a consent wall, or a stub. A property of the SOURCE:
//                "UNVERIFIABLE — SOURCE BLOCKED", never a judgment on the
//                outlet or the story.
//   timeout    — the origin did not answer in time. A later run tries again.
//   no_article — a video page with no article text. Nothing to retry.
//   error      — any other HTTP / network failure.
// ---------------------------------------------------------------------------
import { EXTRACT_MAX_CHARS, EXTRACT_MIN_CHARS, EXTRACT_TIMEOUT_MS, USER_AGENT } from './config.js';

export const BLOCKED_STATUSES = new Set([401, 402, 403, 451]);
export const FAILURE_REASONS = ['blocked', 'timeout', 'error', 'no_article'];
export const ROUTES = ['runner'];

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

// JSON-LD on the page: article bodies, authors, the types present, and
// whether the publisher marks the article as not free (a paywall signal).
export function readJsonLd(html) {
  const out = { bodies: [], types: new Set(), accessibleForFree: null, authors: [] };
  const names = (a) => {
    if (!a) return [];
    if (typeof a === 'string') return [a];
    if (Array.isArray(a)) return a.flatMap(names);
    if (typeof a === 'object' && typeof a.name === 'string') return [a.name];
    return [];
  };
  const blocks = [...String(html || '').matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const t = node['@type'];
    if (typeof t === 'string') out.types.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && out.types.add(x));
    if (typeof node.articleBody === 'string') out.bodies.push(node.articleBody);
    if (node.author && (typeof t === 'string' ? /Article|Posting|NewsArticle/.test(t) : true)) for (const n of names(node.author)) if (!out.authors.includes(n)) out.authors.push(n);
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
 * HTML -> readable text. Returns { text, title, source, video, paywalled, authors }.
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
  return { text, title, source, video, paywalled: ld.accessibleForFree === false, authors: ld.authors };
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
// page is a short "before you continue" shell. Classified, never worked
// around: it is the publisher's answer.
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

function classify(r, minChars) {
  if (r.error) return { ok: false, reason: r.error, detail: r.detail };
  if (BLOCKED_STATUSES.has(r.status)) return { ok: false, reason: 'blocked', detail: `HTTP ${r.status}`, httpStatus: r.status };
  if (r.status < 200 || r.status >= 300) return { ok: false, reason: 'error', detail: `HTTP ${r.status}`, httpStatus: r.status };
  if (r.readError) return { ok: false, reason: 'error', detail: r.readError, httpStatus: r.status };
  const ex = extractText(r.html);
  if (ex.text.length >= minChars) return { ok: true, text: ex.text, chars: ex.text.length, title: ex.title, httpStatus: r.status, source: ex.source, authors: ex.authors };
  if (ex.video) return { ok: false, reason: 'no_article', detail: 'video page', chars: ex.text.length, httpStatus: r.status };
  if (looksLikeConsentWall({ finalUrl: r.finalUrl, title: ex.title, chars: ex.text.length })) return { ok: false, reason: 'blocked', detail: 'consent wall', chars: ex.text.length, httpStatus: r.status };
  // Stub — paywall teaser / shell. Honest failure, never a fragment.
  return { ok: false, reason: 'blocked', detail: ex.paywalled ? 'paywall' : 'stub', chars: ex.text.length, httpStatus: r.status };
}

/**
 * Fetch an article once, as Signal, and extract its text. Never throws.
 *   { ok: true, text, chars, title, httpStatus, source, authors, route: 'runner', attempts: 1, ms, tried }
 *   { ok: false, reason, detail, chars?, httpStatus?, route: null, attempts: 1, ms, tried: ['runner'] }
 */
export async function fetchArticle(url, { fetch = globalThis.fetch, timeoutMs = EXTRACT_TIMEOUT_MS, minChars = EXTRACT_MIN_CHARS, userAgent = USER_AGENT } = {}) {
  const t0 = Date.now();
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return { ok: false, reason: 'error', detail: 'invalid url', route: null, attempts: 0, ms: 0, tried: [] };
  }
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, reason: timeout ? 'timeout' : 'error', detail: timeout ? 'timeout' : e?.message || 'network error', route: null, attempts: 1, ms: Date.now() - t0, tried: ['runner'] };
  }
  const r = { status: res.status, finalUrl: res.url || url, html: '', readError: null };
  if (res.status >= 200 && res.status < 300) {
    try {
      r.html = await res.text();
    } catch (e) {
      r.readError = e?.message || 'read error';
    }
  }
  const c = classify(r, minChars);
  const ms = Date.now() - t0;
  return c.ok ? { ...c, route: 'runner', attempts: 1, ms, tried: ['runner'] } : { ...c, route: null, attempts: 1, ms, tried: ['runner'] };
}
