import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSlam } from '../pipeline/slam.js';

test('core verbs flag; the matched word is reported', () => {
  assert.deepEqual(detectSlam('Senator slams rival over vote'), { matched: true, term: 'slams', tier: 'core' });
  assert.deepEqual(detectSlam('Governor rips into critics'), { matched: true, term: 'rips into', tier: 'core' });
});

test('watch verbs flag with the watch tier', () => {
  assert.deepEqual(detectSlam('Pundit destroys argument on air'), { matched: true, term: 'destroys', tier: 'watch' });
});

test('literal guards: slams into, fire guts building', () => {
  assert.equal(detectSlam('Car slams into storefront, two hurt').matched, false);
  assert.equal(detectSlam('Fire guts downtown warehouse; no injuries').matched, false);
  assert.equal(detectSlam('Critic guts the proposal line by line').matched, true);
});

test('word boundaries and empty input', () => {
  assert.equal(detectSlam('Islamabad talks resume').matched, false);
  assert.equal(detectSlam('').matched, false);
  assert.equal(detectSlam(null).matched, false);
});
