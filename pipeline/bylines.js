// ---------------------------------------------------------------------------
// Bylines. Every row records the author name(s) the feed gave (dc:creator,
// author, Atom <author><name>) or, when the article was fetched, the page's
// structured data (JSON-LD author), normalized, with a stable author id per
// outlet. A row with no byline records "none". Coverage by outlet is
// reported on the method page. No per-author metric is computed or shown.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';

const MAX_AUTHORS = 6;

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

const clean = (s) =>
  decodeEntities(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

// One raw byline string → the names in it. Handles "By A and B", "A, B",
// "A | Outlet", "email (Name)", "Name <email>", and drops bare emails.
function splitOne(raw) {
  let s = clean(raw);
  if (!s) return [];
  const paren = s.match(/^[^\s@]+@[^\s@]+\s*\((.+)\)\s*$/);
  if (paren) s = paren[1];
  s = s.replace(/<[^>]*@[^>]*>/g, ' ').replace(/\([^)]*@[^)]*\)/g, ' ');
  if (/^[^\s@]+@[^\s@]+$/.test(s.trim())) return [];
  s = s.replace(/^\s*(by|from|written by|story by|reported by)\s*:?\s+/i, '');
  s = s.split(/\s*\|\s*/)[0];
  return s
    .split(/\s*(?:,|;|\/|&|\band\b|\+)\s*/i)
    .map((n) => n.replace(/^\s*(by|and)\s+/i, '').replace(/[.\s]+$/g, '').trim())
    .filter((n) => n && !/^[^\s@]+@[^\s@]+$/.test(n));
}

function presentable(name) {
  const n = name.replace(/\s+/g, ' ').trim();
  // ALL-CAPS bylines are title-cased; everything else is left as written.
  if (n.length > 3 && n === n.toUpperCase() && /[A-Z]/.test(n)) return n.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  return n;
}

export function normalizeAuthors(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    for (const name of splitOne(item)) {
      const p = presentable(name);
      const k = authorKey(p);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(p);
      if (out.length >= MAX_AUTHORS) return out;
    }
  }
  return out;
}

// Diacritics folded, lower case, letters digits and spaces only.
export function authorKey(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Stable per outlet: the same name at the same outlet always gets the same
// id; the same name at two outlets gets two.
export function authorId(outlet, name) {
  return createHash('sha256').update(`${String(outlet || '')}\n${authorKey(name)}`).digest('hex').slice(0, 12);
}

export const NO_BYLINE = 'none';

/** The row's byline record. `source` is 'feed', 'article' or 'none'. */
export function bylineOf({ outlet, names = [], source = 'feed' } = {}) {
  const list = normalizeAuthors(names);
  if (!list.length) return { source: NO_BYLINE, text: NO_BYLINE, authors: [] };
  return { source, text: list.join(', '), authors: list.map((name) => ({ name, id: authorId(outlet, name) })) };
}

// Coverage by outlet: how many rows carry a byline and where it came from.
export function bylineCoverage(rows) {
  const round1 = (n) => Math.round(n * 10) / 10;
  const empty = () => ({ rows: 0, withByline: 0, fromFeed: 0, fromArticle: 0, pct: null });
  const total = empty();
  const byOutlet = {};
  for (const r of rows || []) {
    const o = (byOutlet[r.outlet || r.publication || '?'] ||= empty());
    for (const b of [total, o]) {
      b.rows++;
      const src = r.byline?.source;
      if (src === 'feed' || src === 'article') {
        b.withByline++;
        if (src === 'feed') b.fromFeed++;
        else b.fromArticle++;
      }
    }
  }
  for (const b of [total, ...Object.values(byOutlet)]) b.pct = b.rows ? round1((100 * b.withByline) / b.rows) : null;
  return { ...total, byOutlet };
}
