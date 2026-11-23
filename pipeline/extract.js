// ---------------------------------------------------------------------------
// Article text extraction for full-text escalation.
//
// Deliberately light — no headless browser, no readability dependency: drop
// script/style/nav chrome, prefer <article>/<main>, join paragraph text. The
// text is sent to the scorer and DISCARDED; the ledger stores only its length.
//
// Failure reasons are a closed set so the UI can say exactly why a row could
// not earn a full-text verdict:
//   blocked — the publisher refuses automated retrieval (401/402/403/451) or
//             serves a paywall / consent shell (stub). A property of the
//             SOURCE: "UNVERIFIABLE — SOURCE BLOCKED", never a judgment on the
//             outlet or the story.
//   timeout — the origin did not answer in time. A later attempt may succeed.
//   error   — any other HTTP / network failure.
// ---------------------------------------------------------------------------
import { EXTRACT_MAX_CHARS, EXTRACT_MIN_CHARS, EXTRACT_TIMEOUT_MS, USER_AGENT } from './config.js';

export const BLOCKED_STATUSES = new Set([401, 402, 403, 451]);

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

// HTML -> readable text. Order matters: kill non-content subtrees first, then
// narrow to the most article-like container, then keep paragraph-level text.
export function extractText(html, { maxChars = EXTRACT_MAX_CHARS } = {}) {
  const s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside|figure|figcaption|button)\b[\s\S]*?<\/\1>/gi, ' ');

  const container = s.match(/<article\b[\s\S]*?<\/article>/i)?.[0] || s.match(/<main\b[\s\S]*?<\/main>/i)?.[0] || s;

  const paras = [...container.matchAll(/<(p|h1|h2|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 40); // drop crumbs: bylines, timestamps, buttons

  const text = paras.join('\n\n').slice(0, maxChars);
  const title = decodeEntities((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return { text, title };
}

/**
 * Fetch an article and extract its text. Never throws.
 *   { ok: true, text, chars, title, httpStatus, ms }
 *   { ok: false, reason: 'blocked'|'timeout'|'error', detail, chars?, httpStatus?, ms }
 */
export async function fetchArticle(url, { fetch = globalThis.fetch, timeoutMs = EXTRACT_TIMEOUT_MS, minChars = EXTRACT_MIN_CHARS } = {}) {
  const t0 = Date.now();
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return { ok: false, reason: 'error', detail: 'invalid url', ms: 0 };
  }
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, reason: timeout ? 'timeout' : 'error', detail: timeout ? 'timeout' : e?.message || 'network error', ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  if (BLOCKED_STATUSES.has(res.status)) {
    return { ok: false, reason: 'blocked', detail: `HTTP ${res.status}`, httpStatus: res.status, ms };
  }
  if (!res.ok) return { ok: false, reason: 'error', detail: `HTTP ${res.status}`, httpStatus: res.status, ms };
  let html;
  try {
    html = await res.text();
  } catch (e) {
    return { ok: false, reason: 'error', detail: e?.message || 'read error', httpStatus: res.status, ms };
  }
  const { text, title } = extractText(html);
  if (text.length < minChars) {
    // Stub — paywall / consent wall / teaser. Honest failure, never a fragment.
    return { ok: false, reason: 'blocked', detail: 'stub', chars: text.length, httpStatus: res.status, ms };
  }
  return { ok: true, text, chars: text.length, title, httpStatus: res.status, ms };
}
