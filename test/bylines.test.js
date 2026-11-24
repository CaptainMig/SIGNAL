import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorId, authorKey, bylineCoverage, bylineOf, normalizeAuthors } from '../pipeline/bylines.js';
import { parseFeed } from '../pipeline/rss.js';
import { extractText } from '../pipeline/extract.js';

test('normalizeAuthors: By-prefix, separators, emails, outlet suffixes, caps, dedupe, cap', () => {
  assert.deepEqual(normalizeAuthors('By Jane Doe and John Roe'), ['Jane Doe', 'John Roe']);
  assert.deepEqual(normalizeAuthors('Jane Doe, John Roe & Ann Lee'), ['Jane Doe', 'John Roe', 'Ann Lee']);
  assert.deepEqual(normalizeAuthors('jdoe@example.com (Jane Doe)'), ['Jane Doe']);
  assert.deepEqual(normalizeAuthors('Jane Doe <jdoe@example.com>'), ['Jane Doe']);
  assert.deepEqual(normalizeAuthors('jdoe@example.com'), [], 'a bare email is not a name');
  assert.deepEqual(normalizeAuthors('Jane Doe | Washington Post'), ['Jane Doe']);
  assert.deepEqual(normalizeAuthors('JANE DOE'), ['Jane Doe']);
  assert.deepEqual(normalizeAuthors(['Jane Doe', 'jane doe', 'John Roe']), ['Jane Doe', 'John Roe'], 'dedupe is case-insensitive, first spelling wins');
  assert.deepEqual(normalizeAuthors('<![CDATA[By <b>Jane</b> Doe]]>'), ['Jane Doe']);
  assert.deepEqual(normalizeAuthors('Associated Press'), ['Associated Press'], 'an organisation byline is kept as given');
  assert.deepEqual(normalizeAuthors(''), []);
  assert.deepEqual(normalizeAuthors(null), []);
  assert.equal(normalizeAuthors('a, b, c, d, e, f, g, h').length, 6, 'capped');
  assert.equal(authorKey('José Álvarez-Núñez'), 'jose alvarez nunez');
});

test('author ids are stable per outlet and differ across outlets; bylineOf records none when absent', () => {
  assert.equal(authorId('Outlet A', 'Jane Doe'), authorId('Outlet A', 'jane  doe'));
  assert.notEqual(authorId('Outlet A', 'Jane Doe'), authorId('Outlet B', 'Jane Doe'));
  assert.match(authorId('Outlet A', 'Jane Doe'), /^[a-f0-9]{12}$/);
  const b = bylineOf({ outlet: 'Outlet A', names: ['By Jane Doe and John Roe'], source: 'feed' });
  assert.equal(b.source, 'feed');
  assert.equal(b.text, 'Jane Doe, John Roe');
  assert.deepEqual(b.authors.map((a) => a.name), ['Jane Doe', 'John Roe']);
  assert.equal(b.authors[0].id, authorId('Outlet A', 'Jane Doe'));
  assert.deepEqual(bylineOf({ outlet: 'Outlet A', names: [], source: 'feed' }), { source: 'none', text: 'none', authors: [] });
  assert.deepEqual(bylineOf({ outlet: 'Outlet A', names: ['staff@example.com'], source: 'article' }), { source: 'none', text: 'none', authors: [] });
});

test('feeds expose authors from dc:creator, RSS author and Atom author; JSON-LD author is read from the page', () => {
  const rss = `<rss><channel>
    <item><title>One headline long enough</title><link>https://x/1</link><dc:creator><![CDATA[Jane Doe]]></dc:creator><dc:creator>John Roe</dc:creator></item>
    <item><title>Two headline long enough</title><link>https://x/2</link><author>jdoe@example.com (Jane Doe)</author></item>
    <item><title>Three headline long enough</title><link>https://x/3</link></item>
  </channel></rss>`;
  const items = parseFeed(rss);
  assert.deepEqual(items.map((i) => i.authors), [['Jane Doe', 'John Roe'], ['jdoe@example.com (Jane Doe)'], []]);
  const atom = `<feed><entry><title>Atom headline long enough</title><link href="https://x/4"/><author><name>Ann Lee</name><email>a@x</email></author></entry></feed>`;
  assert.deepEqual(parseFeed(atom)[0].authors, ['Ann Lee']);
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', author: [{ '@type': 'Person', name: 'Jane Doe' }, 'John Roe'], articleBody: 'x'.repeat(500) })}</script></head><body></body></html>`;
  assert.deepEqual(extractText(html).authors, ['Jane Doe', 'John Roe']);
  const org = `<html><head><script type="application/ld+json">{"@type":"NewsMediaOrganization","author":{"name":"Not An Author"}}</script></head></html>`;
  assert.deepEqual(extractText(org).authors, [], 'only article-type nodes contribute authors');
});

test('bylineCoverage counts rows with a byline by outlet and by source', () => {
  const rows = [
    { outlet: 'A', byline: { source: 'feed' } },
    { outlet: 'A', byline: { source: 'none' } },
    { outlet: 'B', byline: { source: 'article' } },
    { outlet: 'B' },
  ];
  const c = bylineCoverage(rows);
  assert.deepEqual([c.rows, c.withByline, c.fromFeed, c.fromArticle, c.pct], [4, 2, 1, 1, 50]);
  assert.deepEqual(c.byOutlet.A, { rows: 2, withByline: 1, fromFeed: 1, fromArticle: 0, pct: 50 });
  assert.deepEqual(c.byOutlet.B, { rows: 2, withByline: 1, fromFeed: 0, fromArticle: 1, pct: 50 });
  assert.deepEqual(bylineCoverage([]).pct, null);
});
