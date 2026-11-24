import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alternateUrl, createRemoteFetch, extractText, fetchArticle, isVideoUrl, looksLikeConsentWall, readJsonLd, registrableHost } from '../pipeline/extract.js';
import { fixture, mockFetch, timeoutError } from './helpers.js';

test('extractText prefers <article>, drops chrome, decodes entities', () => {
  const { text, title } = extractText(fixture('article.html'));
  assert.equal(title, 'Senate passes budget bill after late-night session | Example A');
  assert.ok(text.startsWith('Senate passes budget bill after late-night session'));
  assert.ok(text.includes('52–48'));
  assert.ok(text.includes('"We have not had time to read it,"'));
  assert.ok(!text.includes('Site header'));
  assert.ok(!text.includes('Footer boilerplate'));
  assert.ok(!text.includes('caption'));
  assert.ok(!text.includes('nav chrome'));
  assert.ok(!text.includes('By Staff'), 'short crumbs are dropped');
});

test('fetchArticle: ok / blocked by status / blocked by stub / timeout / error', async () => {
  const fetch = mockFetch({
    'https://ok/': { status: 200, body: fixture('article.html') },
    'https://paywall/': { status: 403, body: '' },
    'https://stub/': { status: 200, body: fixture('stub.html') },
    'https://slow/': timeoutError(),
    'https://gone/': { status: 500, body: '' },
  });
  const ok = await fetchArticle('https://ok/', { fetch });
  assert.equal(ok.ok, true);
  assert.ok(ok.chars > 400);

  const pw = await fetchArticle('https://paywall/', { fetch });
  assert.deepEqual([pw.ok, pw.reason, pw.detail], [false, 'blocked', 'HTTP 403']);

  const stub = await fetchArticle('https://stub/', { fetch });
  assert.deepEqual([stub.ok, stub.reason, stub.detail], [false, 'blocked', 'stub']);

  const slow = await fetchArticle('https://slow/', { fetch });
  assert.deepEqual([slow.ok, slow.reason], [false, 'timeout']);

  const gone = await fetchArticle('https://gone/', { fetch });
  assert.deepEqual([gone.ok, gone.reason, gone.detail], [false, 'error', 'HTTP 500']);

  const bad = await fetchArticle('javascript:alert(1)', { fetch });
  assert.deepEqual([bad.ok, bad.reason], [false, 'error']);
  // One fetch for the hit; every failure is retried once with the second
  // identity (no alternate URL exists for these hosts): 1 + 4 × 2.
  assert.equal(fetch.calls.length, 9);
  assert.equal(ok.route, 'runner');
  assert.deepEqual(pw.tried, ['runner', 'alt-identity']);
  assert.equal(pw.route, null);
});

test('extractText takes the largest container, not the first; JSON-LD articleBody wins when longer', () => {
  const long = Array.from({ length: 12 }, (_, i) => `<p>Paragraph number ${i} of the real story body, long enough to count as a paragraph.</p>`).join('');
  const html = `<html><head><title>T</title></head><body><article><p>A teaser card that is long enough to survive the crumb filter here.</p></article><article>${long}</article></body></html>`;
  const { text, source } = extractText(html);
  assert.ok(text.includes('Paragraph number 11'), 'the larger article wins');
  assert.equal(source, 'markup');
  const body = 'Body from structured data. '.repeat(60);
  const ld = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body, isAccessibleForFree: false })}</script></head><body><article><p>Only a teaser paragraph here, long enough to pass the crumb filter.</p></article></body></html>`;
  const r = extractText(ld);
  assert.equal(r.source, 'ld+json');
  assert.ok(r.text.length > 1000);
  assert.equal(r.paywalled, true);
  assert.equal(r.video, false);
  const video = `<html><head><script type="application/ld+json">[{"@type":"VideoObject","name":"clip"},{"@type":"NewsMediaOrganization"}]</script></head><body><p>Short caption text that is long enough to be a paragraph.</p></body></html>`;
  assert.equal(extractText(video).video, true);
  assert.deepEqual([...readJsonLd('<script type="application/ld+json">{"@graph":[{"@type":"Article","articleBody":"x"}]}</script>').types], ['Article']);
});

test('video URLs, alternate renderings, registrable hosts, consent walls', () => {
  assert.equal(isVideoUrl('https://www.cbsnews.com/video/some-clip/'), true);
  assert.equal(isVideoUrl('https://www.nbcnews.com/video/markets-react-274009157981'), true);
  assert.equal(isVideoUrl('https://www.cbsnews.com/news/some-story/'), false);
  assert.equal(isVideoUrl('not a url'), false);
  assert.equal(alternateUrl('https://www.washingtonpost.com/politics/2026/11/23/story/'), 'https://www.washingtonpost.com/politics/2026/11/23/story/?outputType=amp');
  assert.equal(alternateUrl('https://www.washingtonpost.com/x/?outputType=amp'), null);
  assert.equal(alternateUrl('https://www.npr.org/2026/11/23/nx-s1-6044207/thanksgiving-meal-costs'), 'https://text.npr.org/nx-s1-6044207');
  assert.equal(alternateUrl('https://www.npr.org/2026/11/23/g-s1-155021/up-first'), 'https://text.npr.org/g-s1-155021');
  assert.equal(alternateUrl('https://www.nytimes.com/2026/11/23/us/x.html'), null);
  assert.equal(registrableHost('https://www.washingtonpost.com/a'), 'washingtonpost.com');
  assert.equal(registrableHost('https://news.sky.com/story/x'), 'sky.com');
  assert.equal(registrableHost('https://www.bbc.co.uk/news/x'), 'bbc.co.uk');
  assert.equal(registrableHost('https://abcnews.go.com/x'), 'go.com');
  assert.equal(looksLikeConsentWall({ finalUrl: 'https://choice.npr.org/?origin=x', title: 'NPR Choice', chars: 100 }), true);
  assert.equal(looksLikeConsentWall({ finalUrl: 'https://example.com/story', title: 'Before you continue to Example', chars: 120 }), true);
  assert.equal(looksLikeConsentWall({ finalUrl: 'https://example.com/story', title: 'A real headline', chars: 120 }), false);
  assert.equal(looksLikeConsentWall({ finalUrl: 'https://example.com/story', title: 'We value your privacy', chars: 5000 }), false, 'a full page is not a wall');
});

test('fetchArticle chain: tarpit then second identity; consent cookie; alternate rendering; video is final', async () => {
  const seen = [];
  const article = fixture('article.html');
  const fetch = async (url, opts) => {
    const ua = opts.headers['User-Agent'];
    seen.push([url, /Firefox/.test(ua) ? 'ff' : 'chrome', opts.headers.Cookie || null]);
    if (url.startsWith('https://tarpit/')) {
      if (/Firefox/.test(ua)) return { ok: true, status: 200, url, text: async () => article };
      throw timeoutError();
    }
    if (url.startsWith('https://www.npr.org/2026/11/23/nx-s1-1/story')) {
      if (opts.headers.Cookie) return { ok: true, status: 200, url, text: async () => article };
      return { ok: true, status: 200, url: 'https://choice.npr.org/?origin=x', text: async () => '<html><head><title>NPR Choice</title></head><body><p>Choose how NPR uses cookies, this text is long enough.</p></body></html>' };
    }
    if (url.startsWith('https://www.npr.org/2026/11/23/nx-s1-2/story')) return { ok: true, status: 200, url, text: async () => fixture('stub.html') };
    if (url.startsWith('https://text.npr.org/nx-s1-2')) return { ok: true, status: 200, url, text: async () => article };
    if (url.startsWith('https://video/')) return { ok: true, status: 200, url, text: async () => '<html><script type="application/ld+json">{"@type":"VideoObject"}</script><body><p>Caption only, long enough to be a paragraph.</p></body></html>' };
    return { ok: false, status: 404, url, text: async () => '' };
  };
  const tarpit = await fetchArticle('https://tarpit/story', { fetch, timeoutMs: 10 });
  assert.deepEqual([tarpit.ok, tarpit.route, tarpit.attempts], [true, 'alt-identity', 2]);
  const consent = await fetchArticle('https://www.npr.org/2026/11/23/nx-s1-1/story', { fetch });
  assert.deepEqual([consent.ok, consent.route], [true, 'consent-cookie']);
  assert.deepEqual(consent.tried, ['runner', 'alt-identity', 'consent-cookie']);
  const alt = await fetchArticle('https://www.npr.org/2026/11/23/nx-s1-2/story', { fetch });
  assert.deepEqual([alt.ok, alt.route], [true, 'alternate']);
  assert.deepEqual(alt.tried, ['runner', 'alt-identity', 'alternate']);
  const video = await fetchArticle('https://video/clip', { fetch });
  assert.deepEqual([video.ok, video.reason, video.detail, video.attempts], [false, 'no_article', 'video page', 1], 'a video page is final after one fetch');
});

test('createRemoteFetch: null when unconfigured; relays ok and failure shapes; never throws', async () => {
  assert.equal(createRemoteFetch({}), null);
  const calls = [];
  const ok = createRemoteFetch({ url: 'https://site/api/fetch-article', token: 't', fetch: async (u, o) => { calls.push([u, o]); return { ok: true, json: async () => ({ ok: true, text: 'x'.repeat(500), title: 'T', httpStatus: 200, attempts: 2 }) }; } });
  const r = await ok('https://www.nytimes.com/x.html', { timeoutMs: 1234 });
  assert.deepEqual([r.ok, r.route, r.chars, r.attempts], [true, 'vercel', 500, 2]);
  assert.equal(calls[0][1].headers['x-signal-fetch-token'], 't');
  assert.deepEqual(JSON.parse(calls[0][1].body), { url: 'https://www.nytimes.com/x.html', timeoutMs: 1234 });
  const refused = createRemoteFetch({ url: 'u', token: 't', fetch: async () => ({ ok: true, json: async () => ({ ok: false, reason: 'blocked', detail: 'HTTP 403', attempts: 2 }) }) });
  assert.deepEqual(await refused('https://x/').then((x) => [x.ok, x.reason, x.detail, x.route]), [false, 'blocked', 'HTTP 403', 'vercel']);
  const down = createRemoteFetch({ url: 'u', token: 't', fetch: async () => { throw new Error('boom'); } });
  assert.deepEqual(await down('https://x/').then((x) => [x.ok, x.reason]), [false, 'error']);
  const unauth = createRemoteFetch({ url: 'u', token: 't', fetch: async () => ({ ok: false, status: 401 }) });
  assert.deepEqual(await unauth('https://x/').then((x) => [x.ok, x.detail]), [false, 'remote route HTTP 401']);
});
