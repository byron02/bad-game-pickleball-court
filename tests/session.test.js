import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionClosesAt } from '../src/firebaseStore.js';

test('session closes at the next midnight in Manila', () => {
  assert.equal(sessionClosesAt('2026-10-06').toISOString(), '2026-10-06T16:00:00.000Z');
  assert.equal(sessionClosesAt('2026-12-31').toISOString(), '2026-12-31T16:00:00.000Z');
});
