import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FP_VERSION, decodeSignature, encodeSignature, hashString, minhash, normalizeText, rowFingerprint, shingles, similarity, xxhash32 } from '../pipeline/fingerprint.js';

test('xxhash32 matches the reference vectors', () => {
  const hx = (s, seed = 0) => hashString(s, seed).toString(16).toUpperCase().padStart(8, '0');
  assert.equal(hx(''), '02CC5D05');
  assert.equal(hx('a'), '550D7456');
  assert.equal(hx('abc'), '32D153FF');
  assert.equal(hx('Nobody inspects the spammish repetition'), 'E2293B2F');
  assert.equal(xxhash32(new Uint8Array(0), 1).toString(16).toUpperCase().padStart(8, '0'), '0B2CB792');
});

test('normalization and shingles are deterministic and versioned', () => {
  assert.equal(FP_VERSION, 1);
  assert.equal(normalizeText('  Héllo, WORLD!  It’s 2026… '), 'héllo world it s 2026');
  assert.deepEqual(shingles('a b c d e f', 5), ['a b c d e', 'b c d e f']);
  assert.deepEqual(shingles('a b', 5), ['a b'], 'fewer words than k: one shingle');
  assert.deepEqual(shingles('', 5), []);
  assert.deepEqual(shingles('x x x x x x x', 5), ['x x x x x'], 'shingles are a set');
});

test('signatures: fixed length, round-trip, deterministic, similarity tracks shingle overlap, never invertible to words', () => {
  const sig = minhash(shingles('one two three four five six seven', 5), 128);
  assert.equal(sig.length, 128);
  const enc = encodeSignature(sig);
  assert.equal(enc.length, 683);
  assert.deepEqual([...decodeSignature(enc)], [...sig]);
  assert.equal(encodeSignature(minhash(shingles('one two three four five six seven', 5), 128)), enc);
  // Distinct words, so the shingle set is large (repeated text collapses to a few shingles).
  const words = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
  const base = words(150, 'w');
  const a = rowFingerprint({ title: 'Council votes late', text: base + ' the mayor spoke afterwards', source: 'fulltext' });
  const b = rowFingerprint({ title: 'Council votes late', text: base + ' the mayor declined to speak', source: 'fulltext' });
  const c = rowFingerprint({ title: 'Rain expected', text: words(150, 'r'), source: 'fulltext' });
  assert.ok(similarity(a.text, b.text) > 0.8, 'near-verbatim reuse scores high');
  assert.ok(similarity(a.text, c.text) < 0.1, 'unrelated text scores near zero');
  assert.equal(similarity(a.title, b.title), 1);
  assert.equal(similarity(a.text, a.title), null, 'different lengths are not comparable');
  assert.ok(!JSON.stringify(a).includes('w10 ') && !JSON.stringify(a).includes('mayor'), 'no word of the text survives');
  assert.deepEqual([a.v, a.source, a.text.length, a.title.length], [1, 'fulltext', 683, 342]);
  assert.ok(a.shingles > 0 && a.chars > 0);
});

test('rowFingerprint: a thin row keeps only the headline signature; summary source is recorded', () => {
  const thin = rowFingerprint({ title: 'Only a headline here', text: '', source: 'title' });
  assert.deepEqual([thin.source, thin.text, thin.title.length, thin.shingles, thin.chars], ['title', null, 342, 0, 0]);
  const sum = rowFingerprint({ title: 'H', text: 'A short summary of the story in a few words.', source: 'summary' });
  assert.deepEqual([sum.source, sum.text.length], ['summary', 683]);
  const empty = rowFingerprint({ title: '', text: '', source: 'summary' });
  assert.deepEqual([empty.source, empty.text, empty.title], ['title', null, null]);
});
