import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalationOutcome, needsEscalation } from '../pipeline/escalate.js';

test('only PROVISIONAL and CONTESTED sweep rows escalate', () => {
  assert.equal(needsEscalation({ verdict: 'PROVISIONAL' }), true);
  assert.equal(needsEscalation({ verdict: 'CONTESTED' }), true);
  for (const v of ['VERIFIED', 'CONTEXTUAL', 'UNVERIFIED', 'MISLEADING', null]) assert.equal(needsEscalation({ verdict: v }), false);
  assert.equal(needsEscalation(null), false);
});

test('transition matrix', () => {
  assert.equal(escalationOutcome('PROVISIONAL', 'MISLEADING'), 'confirmed');
  assert.equal(escalationOutcome('PROVISIONAL', 'VERIFIED'), 'cleared');
  assert.equal(escalationOutcome('PROVISIONAL', 'CONTESTED'), 'cleared');
  assert.equal(escalationOutcome('CONTESTED', 'CONTESTED'), 'confirmed');
  assert.equal(escalationOutcome('CONTESTED', 'MISLEADING'), 'cleared');
  assert.equal(escalationOutcome('PROVISIONAL', null), 'pending');
});
