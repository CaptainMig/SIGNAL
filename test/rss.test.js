import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, cleanTitle, cleanSummary, looksLikeFeed } from '../pipeline/rss.js';
import { fixture } from './helpers.js';

test('parses RSS items: CDATA titles, entities, links with params, summaries', () => {
  const items = parseFeed(fixture('feed-a.xml'));
  assert.equal(items.length, 6);
  assert.equal(items[0].title, 'Senate passes budget bill after late-night session');
  assert.equal(items[0].link, 'https://www.example-a.com/politics/budget-bill?utm_source=rss&utm_medium=feed');
  assert.equal(items[0].summary, 'The Senate passed the budget bill 52–48 after a late-night session, sending it to the House.');
  assert.equal(items[1].title, 'Mayor slams council over transit vote & budget');
  assert.equal(items[1].summary, "The mayor criticized the council's decision in sharp terms.");
  assert.equal(items[5].pubDate, null);
});

test('parses Atom entries: alternate link href, published/updated, html content', () => {
  const items = parseFeed(fixture('feed-b.xml'));
  assert.equal(items.length, 2);
  assert.equal(items[0].link, 'https://example-a.com/politics/budget-bill?fbclid=abc');
  assert.equal(items[1].link, 'https://example-b.com/fire-warehouse');
  assert.ok(items[1].pubDate);
  assert.equal(items[1].summary, 'A fire destroyed a warehouse overnight. "No injuries," officials said.');
});

test('a double-encoded anchor in a title survives as literal markup (so the sanity filter can reject it)', () => {
  assert.equal(cleanTitle('&lt;a href="x"&gt;junk&lt;/a&gt;'), '<a href="x">junk</a>');
});

test('a literal less-than in a title is preserved (v1 lost it)', () => {
  assert.equal(cleanTitle('Why A &lt; B matters for the budget'), 'Why A < B matters for the budget');
});

test('summaries collapse double-encoded HTML to text', () => {
  assert.equal(cleanSummary('&lt;p&gt;Hello &amp;amp; goodbye&lt;/p&gt;'), 'Hello & goodbye');
});

test('looksLikeFeed rejects HTML error pages', () => {
  assert.equal(looksLikeFeed('<!doctype html><html><body>Access denied</body></html>'), false);
  assert.equal(looksLikeFeed(fixture('feed-a.xml')), true);
  assert.equal(looksLikeFeed(fixture('feed-b.xml')), true);
});
