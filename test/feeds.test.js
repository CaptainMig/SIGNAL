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

test('stripPublisherSuffix removes a trailing " - Publisher" and nothing else', async () => {
  const { stripPublisherSuffix } = await import('../pipeline/feeds.js');
  assert.equal(stripPublisherSuffix('Tourists evacuated after hotel fire - AP News'), 'Tourists evacuated after hotel fire');
  assert.equal(stripPublisherSuffix('Fed holds rates - markets rally - Reuters'), 'Fed holds rates - markets rally');
  assert.equal(stripPublisherSuffix('No suffix here at all'), 'No suffix here at all');
  assert.equal(stripPublisherSuffix('Short - The Washington Post'), 'Short - The Washington Post', 'never strips down to a malformed headline');
  assert.equal(stripPublisherSuffix('Headline - ' + 'x'.repeat(80)), 'Headline - ' + 'x'.repeat(80), 'a long tail is not a publisher');
});

test('aggregator feeds get the publisher suffix stripped; direct feeds keep their dashes', async () => {
  const gn = (title) =>
    `<rss><channel><item><title>${title}</title><link>https://news.google.com/rss/articles/${encodeURIComponent(title)}?oc=5</link><pubDate>${new Date(NOW - 3600e3).toUTCString()}</pubDate></item></channel></rss>`;
  const fetch = mockFetch({
    'https://news.google.com/rss/search?q=site:x': { status: 200, body: gn('Senate passes budget bill - AP News') },
    'https://direct/': { status: 200, body: gn('Senate passes budget bill - a tale of two chambers') },
  });
  const { rows } = await collectHeadlines({
    feeds: [
      { name: 'X (via Google News)', owner: 'X', url: 'https://news.google.com/rss/search?q=site:x', thinBody: true },
      { name: 'Direct', owner: 'D', url: 'https://direct/' },
    ],
    fetch,
    now: NOW,
    sleep: async () => {},
  });
  assert.equal(rows[0].title, 'Senate passes budget bill');
  assert.equal(rows[1].title, 'Senate passes budget bill - a tale of two chambers');
});

test('a 429 is retried exactly once after Retry-After; a second 429 is dead, a recovery is noted', async () => {
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '3' : null) }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => fixture('feed-a.xml') };
  };
  const r = await fetchFeed({ name: 'F', url: 'https://news.google.com/rss/x' }, { fetch: flaky, sleep });
  assert.equal(r.status, 'ok');
  assert.equal(r.retried, true);
  assert.deepEqual(waits, [3000]);

  let calls2 = 0;
  const always429 = async () => {
    calls2++;
    return { ok: false, status: 429, headers: { get: () => null }, text: async () => '' };
  };
  const waits2 = [];
  const d = await fetchFeed({ name: 'F', url: 'https://news.google.com/rss/x' }, { fetch: always429, sleep: async (ms) => waits2.push(ms) });
  assert.equal(d.status, 'error');
  assert.equal(d.reason, 'HTTP 429 after retry');
  assert.equal(calls2, 2, 'exactly one retry');
  assert.deepEqual(waits2, [5000], 'default wait when Retry-After is absent');

  const { feeds } = await collectHeadlines({ feeds: [{ name: 'F', owner: 'O', url: 'https://news.google.com/rss/x' }], fetch: (() => { let n = 0; return async () => (++n === 1 ? { ok: false, status: 429, headers: { get: () => null }, text: async () => '' } : { ok: true, status: 200, headers: { get: () => null }, text: async () => fixture('feed-a.xml') }); })(), now: NOW, sleep: async () => {} });
  assert.equal(feeds[0].status, 'live');
  assert.equal(feeds[0].retried, true);
  assert.equal(feeds[0].reason, 'recovered after 429 retry');
});

test('Google News feeds are fetched one at a time with a gap; other hosts run in parallel', async () => {
  const { fetchAllFeeds, SERIALIZED_GAP_MS } = await import('../pipeline/feeds.js');
  const order = [];
  const waits = [];
  let inFlightGn = 0;
  let peakGn = 0;
  const fetch = async (url) => {
    order.push(url);
    const gn = url.startsWith('https://news.google.com/');
    if (gn) {
      inFlightGn++;
      peakGn = Math.max(peakGn, inFlightGn);
    }
    await new Promise((r) => setTimeout(r, 5));
    if (gn) inFlightGn--;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => fixture('feed-a.xml') };
  };
  const feeds = [
    { name: 'G1', url: 'https://news.google.com/rss/search?q=1' },
    { name: 'D1', url: 'https://d1/' },
    { name: 'G2', url: 'https://news.google.com/rss/search?q=2' },
    { name: 'D2', url: 'https://d2/' },
    { name: 'G3', url: 'https://news.google.com/rss/search?q=3' },
  ];
  const results = await fetchAllFeeds(feeds, { fetch, sleep: async (ms) => waits.push(ms) });
  assert.equal(peakGn, 1, 'never two Google News requests in flight');
  assert.deepEqual(waits, [SERIALIZED_GAP_MS, SERIALIZED_GAP_MS]);
  assert.deepEqual(results.map((r) => r.feed.name), ['G1', 'D1', 'G2', 'D2', 'G3'], 'results keep feed order');
  assert.ok(results.every((r) => r.status === 'ok'));
  // The direct feeds did not wait for the Google News chain.
  assert.ok(order.indexOf('https://d1/') < order.indexOf('https://news.google.com/rss/search?q=2'));
});

test('an item carrying a locked term in any field is excluded before storage and counted', async () => {
  const { hasLockedTerm, LOCKED_TERMS } = await import('../pipeline/locked.js');
  const [four, brand] = LOCKED_TERMS;
  assert.equal(hasLockedTerm(`Headline about ${four.toLowerCase()} policy`), true, 'case-insensitive');
  assert.equal(hasLockedTerm(`https://news.example/rss/articles/CBMitAFBVV95${four}xyz?oc=5`), true, 'opaque tokens count: the checker is a substring test');
  assert.equal(hasLockedTerm(`Statement from ${brand}`), true);
  assert.equal(hasLockedTerm('Nothing to see here, long enough to pass'), false);
  assert.equal(hasLockedTerm(''), false);
  const xml = `<rss><channel>
    <item><title>Plain headline that is long enough to keep</title><link>https://ok.example/1</link><pubDate>${new Date(NOW - 3600e3).toUTCString()}</pubDate></item>
    <item><title>Headline mentioning ${brand} at length</title><link>https://ok.example/2</link><pubDate>${new Date(NOW - 3600e3).toUTCString()}</pubDate></item>
    <item><title>Another plain headline long enough to keep</title><link>https://ok.example/rss/articles/CBMi${four}abc</link><pubDate>${new Date(NOW - 3600e3).toUTCString()}</pubDate></item>
    <item><title>Summary carries it, headline does not, long enough</title><link>https://ok.example/4</link><description>Statement by ${four}.</description><pubDate>${new Date(NOW - 3600e3).toUTCString()}</pubDate></item>
  </channel></rss>`;
  const fetch = mockFetch({ 'https://feed-l/': { status: 200, body: xml } });
  const { rows, feeds } = await collectHeadlines({ feeds: [{ name: 'L', owner: 'O', url: 'https://feed-l/' }], fetch, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].link, 'https://ok.example/1');
  assert.deepEqual([feeds[0].fetched, feeds[0].kept, feeds[0].excluded], [4, 1, 3]);
  assert.ok(!JSON.stringify(rows).toLowerCase().includes(four.toLowerCase()));
});
