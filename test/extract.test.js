import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, fetchArticle, isVideoUrl, looksLikeConsentWall, readJsonLd, registrableHost } from '../pipeline/extract.js';
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
  // One fetch per URL, as Signal, and never a second under another name.
  assert.equal(fetch.calls.length, 5);
  assert.equal(ok.route, 'runner');
  assert.deepEqual(pw.tried, ['runner']);
  assert.equal(pw.route, null);
  assert.equal(pw.attempts, 1);
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

test('video URLs, registrable hosts, consent walls', () => {
  assert.equal(isVideoUrl('https://www.cbsnews.com/video/some-clip/'), true);
  assert.equal(isVideoUrl('https://www.nbcnews.com/video/markets-react-274009157981'), true);
  assert.equal(isVideoUrl('https://www.cbsnews.com/news/some-story/'), false);
  assert.equal(isVideoUrl('not a url'), false);
  assert.equal(registrableHost('https://www.washingtonpost.com/a'), 'washingtonpost.com');
  assert.equal(registrableHost('https://news.sky.com/story/x'), 'sky.com');
  assert.equal(registrableHost('https://www.bbc.co.uk/news/x'), 'bbc.co.uk');
  assert.equal(registrableHost('https://abcnews.go.com/x'), 'go.com');
  assert.equal(looksLikeConsentWall({ finalUrl: 'https://choice.npr.org/?origin=x', title: 'NPR Choice', chars: 100 }), true);
  assert.equal(looksLikeConsentWall({ finalUrl: 'https://example.com/story', title: 'Before you continue to Example', chars: 120 }), true);
  assert.equal(looksLikeConsentWall({ finalUrl: 'https://example.com/story', title: 'A real headline', chars: 120 }), false);
  assert.equal(looksLikeConsentWall({ finalUrl: 'https://example.com/story', title: 'We value your privacy', chars: 5000 }), false, 'a full page is not a wall');
});

test('fetchArticle sends the honest Signal user agent and classifies a consent wall as SOURCE BLOCKED without any workaround', async () => {
  const seen = [];
  const fetch = async (url, opts) => {
    seen.push(opts.headers['User-Agent']);
    return { ok: true, status: 200, url: 'https://choice.example.org/?origin=x', text: async () => '<html><head><title>Example Choice</title></head><body><p>Choose how we use cookies, this text is long enough to count.</p></body></html>' };
  };
  const r = await fetchArticle('https://www.example.org/story', { fetch });
  assert.deepEqual([r.ok, r.reason, r.detail, r.attempts], [false, 'blocked', 'consent wall', 1]);
  assert.equal(seen.length, 1, 'exactly one fetch');
  assert.match(seen[0], /^Mozilla\/5\.0 \(compatible; Signal\/2; \+https:\/\/anthony-signal\.vercel\.app\/method\)$/);
});
