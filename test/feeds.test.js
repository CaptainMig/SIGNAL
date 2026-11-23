import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFreshness, isMalformedTitle, fetchFeed, collectHeadlines } from '../pipeline/feeds.js';
import { fixture, mockFetch, NOW, timeoutError } from './helpers.js';

const FEEDS = [
  { name: 'A', owner: 'Owner A', url: 'https://feed-a/' },
  { name: 'B', owner: 'Owner B', url: 'https://feed-b/' },
  { name: 'Dead', owner: 'Owner D', url: 'https://feed-dead/' },
  { name: 'Slow', owner: 'Owner S', url: 'https://feed-slow/' },
  { name: 'Html', owner: 'Owner H', url: 'https://feed-html/' },
  { name: 'Frozen', owner: 'Owner F', url: 'https://feed-frozen/' },
  { name: 'Refused', owner: 'Owner R', url: 'https://feed-refused/' },
];

const frozen = `<rss><channel><item><title>An old item that is long enough to pass</title><link>https://frozen/1</link><pubDate>${new Date(NOW - 10 * 86400e3).toUTCString()}</pubDate></item></channel></rss>`;

const routes = {
  'https://feed-a/': { status: 200, body: fixture('feed-a.xml') },
  'https://feed-b/': { status: 200, body: fixture('feed-b.xml') },
  'https://feed-dead/': { status: 503, body: '' },
  'https://feed-slow/': timeoutError(),
  'https://feed-html/': { status: 200, body: '<!doctype html><html><body>blocked</body></html>' },
  'https://feed-frozen/': { status: 200, body: frozen },
  'https://feed-refused/': { status: 403, body: 'Forbidden' },
};

test('classifyFreshness: fresh / stale / undated', () => {
  assert.equal(classifyFreshness(new Date(NOW - 3600e3).toUTCString(), NOW), 'fresh');
  assert.equal(classifyFreshness(new Date(NOW - 49 * 3600e3).toUTCString(), NOW), 'stale');
  assert.equal(classifyFreshness(new Date(NOW + 600e3).toUTCString(), NOW), 'fresh'); // clock skew
  assert.equal(classifyFreshness(null, NOW), 'undated');
  assert.equal(classifyFreshness('not a date', NOW), 'undated');
});

test('isMalformedTitle rejects markup, empties, and short strings', () => {
  assert.equal(isMalformedTitle('<a href="x">junk</a>'), true);
  assert.equal(isMalformedTitle(''), true);
  assert.equal(isMalformedTitle('Short'), true);
  assert.equal(isMalformedTitle('A perfectly ordinary headline'), false);
});

test('fetchFeed classifies ok / error / timeout / not-a-feed', async () => {
  const fetch = mockFetch(routes);
  assert.equal((await fetchFeed(FEEDS[0], { fetch })).status, 'ok');
  const dead = await fetchFeed(FEEDS[2], { fetch });
  assert.equal(dead.status, 'error');
  assert.equal(dead.reason, 'HTTP 503');
  const slow = await fetchFeed(FEEDS[3], { fetch });
  assert.equal(slow.status, 'error');
  assert.equal(slow.reason, 'timeout');
  const html = await fetchFeed(FEEDS[4], { fetch });
  assert.equal(html.reason, 'not a feed');
});

test('collectHeadlines gates, caps, dedupes by canonical link, and reports every feed', async () => {
  const fetch = mockFetch(routes);
  const { rows, feeds } = await collectHeadlines({ feeds: FEEDS, fetch, now: NOW });

  const byName = Object.fromEntries(feeds.map((f) => [f.name, f]));
  assert.equal(byName.A.status, 'live');
  assert.deepEqual([byName.A.fetched, byName.A.kept, byName.A.stale, byName.A.malformed, byName.A.undated], [6, 3, 1, 2, 1]);
  assert.equal(byName.B.status, 'live');
  assert.equal(byName.B.dupes, 1, 'feed B lead story is the same canonical link as feed A');
  assert.equal(byName.Dead.status, 'dead');
  assert.equal(byName.Slow.status, 'dead');
  assert.equal(byName.Slow.reason, 'timeout');
  assert.equal(byName.Html.status, 'dead');
  assert.equal(byName.Frozen.status, 'stale');
  assert.equal(byName.Frozen.reason, 'all items stale');
  assert.equal(byName.Refused.status, 'blocked', 'a 403 is listed as blocked, never dropped silently');
  assert.equal(byName.Refused.reason, 'HTTP 403');
  assert.equal(byName.Refused.httpStatus, 403);

  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.canonical),
    ['https://example-a.com/politics/budget-bill', 'https://example-a.com/local/transit-vote', 'https://example-a.com/undated', 'https://example-b.com/fire-warehouse']
  );
  assert.equal(rows[0].publication, 'A');
  assert.equal(rows[2].undated, true);
  assert.equal(rows[2].pubDate, null);
  assert.match(rows[0].pubDate, /^2026-11-23T15:00:00/);
  assert.equal(rows[3].summary, 'A fire destroyed a warehouse overnight. "No injuries," officials said.');
  for (const r of rows) assert.match(r.id, /^[0-9a-f]{12}$/);
});

test('thin-body feeds get an empty summary; per-feed cap keeps the newest', async () => {
  const many = Array.from({ length: 15 }, (_, i) => {
    const d = new Date(NOW - (i + 1) * 3600e3).toUTCString();
    return `<item><title>Headline number ${i} with enough characters</title><link>https://many/${i}</link><pubDate>${d}</pubDate><description>body ${i}</description></item>`;
  });
  // Oldest listed first, to prove the cap happens after sorting.
  const xml = `<rss><channel>${many.reverse().join('')}</channel></rss>`;
  const fetch = mockFetch({ 'https://many/': { status: 200, body: xml } });
  const { rows } = await collectHeadlines({ feeds: [{ name: 'M', owner: 'O', url: 'https://many/', thinBody: true }], fetch, now: NOW, perFeed: 10 });
  assert.equal(rows.length, 10);
  assert.equal(rows[0].canonical, 'https://many/0');
  assert.equal(rows[9].canonical, 'https://many/9');
  assert.ok(rows.every((r) => r.summary === '' && r.thinBody));
});
