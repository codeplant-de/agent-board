import assert from 'node:assert/strict';
import { test } from 'node:test';
import { task } from './__tests__/helpers/fakes.mts';
import { ownLane } from './task-rules.mts';

const lanes = [
  { name: 'reviews', slots: 2, default: false },
  { name: 'general', slots: 3, default: true },
];

test('a task asking for a lane of this machine owns that lane, whatever its prompt says', () => {
  assert.deepEqual(ownLane(task({ id: 'a', input: '/grill', requestedLane: 'reviews' }), lanes), { name: 'reviews' });
  assert.deepEqual(ownLane(task({ id: 'a', input: '/review-pr 17741', requestedLane: 'general' }), lanes), {
    name: 'general',
  });
});

test('a task with no lane goes to the default lane, wherever it is in the list', () => {
  assert.deepEqual(ownLane(task({ id: 'a', input: '/review-pr 17741' }), lanes), { name: 'general' });
  assert.deepEqual(ownLane(task({ id: 'a' }), [...lanes].reverse()), { name: 'general' });
});

test('a task asking for a lane this machine lacks goes to the default lane and says which one was missing', () => {
  assert.deepEqual(ownLane(task({ id: 'a', requestedLane: 'docs' }), lanes), { name: 'general', missing: 'docs' });
});

test('a requested lane that is not a lane name is never shown, and goes to the default lane', () => {
  assert.deepEqual(ownLane(task({ id: 'a', requestedLane: 'a b; rm' }), lanes), {
    name: 'general',
    missing: '(not a lane name)',
  });
});
