// ---------------------------------------------------------------------------
// Tolerant RSS 2.0 / Atom parser. No dependencies, regex-based on purpose:
// news feeds are small, malformed in predictable ways, and we only need
// title / link / date / summary. Ported from v1 api/feed.js with fixes:
//   - entities are decoded AFTER tag stripping for titles (so a literal
//     "A &lt; B" survives) but double-encoded HTML in summaries still collapses;
//   - no slicing before the caller's freshness filter (v1 cut to 10 items
//     before dropping stale ones, so a feed that lists old items first could
//     crowd out its fresh ones — see DEFECTS.md).
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ');
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const unCdata = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

// Titles: unwrap CDATA, strip tags, decode entities once, collapse.
export function cleanTitle(raw) {
  return collapse(decodeEntities(stripTags(unCdata(raw))));
}

// Summaries: unwrap CDATA, decode (double-encoded HTML becomes tags), strip
// tags, decode again for anything left, collapse.
export function cleanSummary(raw) {
  return collapse(decodeEntities(stripTags(decodeEntities(unCdata(raw)))));
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1] : '';
}

// RSS uses <link>text</link>; Atom uses <link href="..."/> (prefer
// rel="alternate" when several are present).
function linkOf(block) {
  const rss = collapse(decodeEntities(unCdata(tag(block, 'link'))));
  if (rss && /^https?:/i.test(rss)) return rss;
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1]);
  const pick =
    links.find((a) => /rel=["']alternate["']/i.test(a)) || links.find((a) => !/rel=/i.test(a)) || links[0];
  const href = pick && pick.match(/href=["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]) : '';
}

/**
 * Parse a feed document into [{ title, link, pubDate, summary }]. Returns
 * every item in document order; the caller applies freshness, sanity, and
 * per-feed caps. Dates are returned as the raw string (or null) — the caller
 * decides what a parseable date is.
 */
export function parseFeed(xml) {
  const doc = String(xml || '');
  const blocks = doc.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  return blocks
    .map((b) => ({
      title: cleanTitle(tag(b, 'title')),
      link: linkOf(b),
      pubDate: collapse(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'dc:date') || tag(b, 'updated')) || null,
      summary: cleanSummary(tag(b, 'description') || tag(b, 'content:encoded') || tag(b, 'summary') || tag(b, 'content')).slice(0, 2000),
    }))
    .filter((it) => it.title.length > 0);
}

// True when the document looks like a feed at all (guards against HTML error
// pages served with a 200).
export function looksLikeFeed(xml) {
  const head = String(xml || '').slice(0, 4000);
  return /<(rss|feed|rdf:RDF)\b/i.test(head) || /<(item|entry)\b/i.test(String(xml || ''));
}
