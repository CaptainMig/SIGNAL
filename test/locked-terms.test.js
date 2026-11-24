import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInJson, findLockedTerms, PATTERNS, SKIP_KEYS } from '../scripts/check-locked-terms.js';

// The terms are assembled here from fragments too, so this file never spells them.
const four = ['AM', 'DG'].join('');
const brand = ['Clear', ' Channel'].join('');

test('a locked term is matched only as a whole word, case-insensitively, in prose', () => {
  assert.equal(PATTERNS.length, 3);
  assert.equal(findLockedTerms(`A headline that says ${four} in passing`).length, 1);
  assert.equal(findLockedTerms(`lowercase ${four.toLowerCase()} too`).length, 1);
  assert.equal(findLockedTerms(`Statement from ${brand} today`).length, 1);
  assert.equal(findLockedTerms(`Statement from ${brand.replace(' ', '')} today`).length, 1);
  assert.equal(findLockedTerms(`CBMitAFBVV95cUxQ${four}tVzhVNGlq`).length, 0, 'an opaque token is not the word');
  assert.equal(findLockedTerms(`x${four}y and ${four}1`).length, 0);
  assert.equal(findLockedTerms(`a clear channel of water`).length, 1, 'the two-word form, whole words');
  assert.equal(findLockedTerms(`clearly channelled`).length, 0);
  assert.equal(findLockedTerms('').length, 0);
  assert.deepEqual(findLockedTerms(`line one\nline two ${four}`), [{ term: 0, line: 2 }]);
});

test('in ledger JSON the link and id fields are skipped and every other string is checked', () => {
  assert.ok(SKIP_KEYS.has('link') && SKIP_KEYS.has('id') && SKIP_KEYS.has('canonical'));
  const row = {
    id: `${four}1234`,
    link: `https://news.google.com/rss/articles/CBMi${four}xyz?oc=5`,
    canonical: `https://news.google.com/rss/articles/CBMi${four}xyz`,
    title: 'A plain headline',
    final: { rationale: 'Plain rationale.' },
  };
  assert.deepEqual(findInJson({ rows: [row] }), []);
  const bad = { rows: [{ ...row, title: `Headline about ${four} policy` }, { ...row, final: { rationale: `Mentions ${brand}.` } }] };
  assert.deepEqual(
    findInJson(bad).map((h) => h.path),
    ['$.rows[0].title', '$.rows[1].final.rationale']
  );
});
