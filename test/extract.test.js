import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, fetchArticle } from '../pipeline/extract.js';
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
  assert.equal(fetch.calls.length, 5);
});
