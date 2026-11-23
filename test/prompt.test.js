import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScore, promptHash, systemPromptFor, userContent, schemaFor, SYSTEM_PROMPT } from '../pipeline/prompt.js';
import { BODY_CHARS } from '../pipeline/config.js';

test('parseScore normalizes a sweep response and applies the PROVISIONAL policy', () => {
  const s = parseScore('{"verdict":"misleading","fidelity":2,"sensationalism":8,"clickbait":6,"rationale":"Headline inverts the article."}', 'sweep');
  assert.equal(s.verdict, 'PROVISIONAL');
  assert.equal(s.provisional, true);
  assert.deepEqual([s.fidelity, s.sens, s.click], [2, 8, 6]);
});

test('LOCKED: headline-only (sweep) scoring can never emit MISLEADING; full text can', () => {
  const raw = '{"verdict":"MISLEADING","fidelity":1,"sensationalism":9,"clickbait":7,"rationale":"x"}';
  assert.equal(parseScore(raw, 'sweep').verdict, 'PROVISIONAL');
  assert.equal(parseScore(raw, 'fulltext').verdict, 'MISLEADING');
  assert.equal(parseScore(raw, 'fulltext').provisional, undefined);
});

test('tone mode returns no verdict and no fidelity', () => {
  const s = parseScore('{"sensationalism":4,"clickbait":3,"rationale":"mild"}', 'tone');
  assert.deepEqual(s, { verdict: null, fidelity: null, sens: 4, click: 3, rationale: 'mild' });
});

test('axes are clamped to 0–10 and rounded; rationale is bounded', () => {
  const s = parseScore(`{"verdict":"VERIFIED","fidelity":14,"sensationalism":-3,"clickbait":2.6,"rationale":"${'r'.repeat(1000)}"}`, 'fulltext');
  assert.deepEqual([s.fidelity, s.sens, s.click], [10, 0, 3]);
  assert.equal(s.rationale.length, 420);
});

test('malformed responses throw (caller marks UNSCORED) — never a default verdict', () => {
  assert.throws(() => parseScore('no json here', 'sweep'), /no JSON/);
  assert.throws(() => parseScore('{"verdict":"TRUE","fidelity":5,"sensationalism":1,"clickbait":1}', 'sweep'), /bad verdict/);
  assert.throws(() => parseScore('{"verdict":"VERIFIED","sensationalism":1,"clickbait":1}', 'sweep'), /missing fidelity/);
  assert.throws(() => parseScore('{"verdict":"VERIFIED","fidelity":1}', 'sweep'), /missing tone axes/);
});

test('legacy keys (truth/sens/click) still parse', () => {
  const s = parseScore('{"verdict":"VERIFIED","truth":9,"sens":1,"click":0,"rationale":"ok"}', 'fulltext');
  assert.deepEqual([s.fidelity, s.sens, s.click], [9, 1, 0]);
});

test('userContent truncates to the mode budget; tone sends the headline only', () => {
  const long = 'x'.repeat(20000);
  assert.equal(userContent('H', long, 'sweep').length, 'HEADLINE: H\nARTICLE: '.length + BODY_CHARS.sweep);
  assert.equal(userContent('H', long, 'fulltext').length, 'HEADLINE: H\nARTICLE: '.length + BODY_CHARS.fulltext);
  assert.equal(userContent('H', long, 'tone'), 'HEADLINE: H');
});

test('promptHash is stable per mode, differs across modes, and tracks the prompt text', () => {
  assert.match(promptHash('sweep'), /^[0-9a-f]{12}$/);
  assert.equal(promptHash('sweep'), promptHash('sweep'));
  assert.notEqual(promptHash('sweep'), promptHash('fulltext'));
  assert.notEqual(promptHash('sweep'), promptHash('tone'));
});

test('prompt and schemas: headline-vs-article language, no world fact-checking, schema per mode', () => {
  assert.ok(SYSTEM_PROMPT.includes('NOT a fact-checker of the world'));
  assert.ok(systemPromptFor('tone').includes('must NOT return a verdict'));
  assert.ok(systemPromptFor('fulltext').includes('FULL-TEXT MODE'));
  assert.deepEqual(schemaFor('tone').required, ['sensationalism', 'clickbait', 'rationale']);
  assert.ok(schemaFor('sweep').required.includes('verdict'));
  assert.equal(schemaFor('sweep').additionalProperties, false);
  assert.deepEqual(schemaFor('sweep').properties.verdict.enum, ['VERIFIED', 'CONTEXTUAL', 'CONTESTED', 'UNVERIFIED', 'MISLEADING']);
});
