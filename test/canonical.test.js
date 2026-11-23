import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, rowId } from '../pipeline/canonical.js';

test('strips tracking params, fragment, www, trailing slash; sorts the rest', () => {
  assert.equal(
    canonicalizeUrl('http://www.Example.com/a/b/?utm_source=rss&z=2&fbclid=x&a=1#frag'),
    'https://example.com/a/b?a=1&z=2'
  );
});

test('same article through different feeds canonicalizes identically', () => {
  const a = canonicalizeUrl('https://www.example-a.com/politics/budget-bill?utm_source=rss&utm_medium=feed');
  const b = canonicalizeUrl('https://example-a.com/politics/budget-bill?fbclid=abc');
  const c = canonicalizeUrl('https://example-a.com/politics/budget-bill/');
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(rowId(a), rowId(c));
});

test('keeps content-identifying params and drops google news oc', () => {
  assert.equal(canonicalizeUrl('https://news.google.com/rss/articles/CBMi?oc=5'), 'https://news.google.com/rss/articles/CBMi');
  assert.equal(canonicalizeUrl('https://site.com/story?id=42&utm_campaign=x'), 'https://site.com/story?id=42');
});

test('index.html and root are normalized; non-http input passes through', () => {
  assert.equal(canonicalizeUrl('https://site.com/'), 'https://site.com');
  assert.equal(canonicalizeUrl('https://site.com/section/index.html'), 'https://site.com/section');
  assert.equal(canonicalizeUrl('not a url'), 'not a url');
  assert.equal(canonicalizeUrl(''), '');
});

test('rowId is 12 hex chars and stable', () => {
  assert.match(rowId('https://example.com/x'), /^[0-9a-f]{12}$/);
  assert.equal(rowId('https://example.com/x'), rowId('https://example.com/x'));
  assert.notEqual(rowId('https://example.com/x'), rowId('https://example.com/y'));
});
