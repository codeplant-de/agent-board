import assert from 'node:assert/strict';
import { test } from 'node:test';
import { task } from './__tests__/helpers/fakes.mts';
import { ownLane } from './task-rules.mts';

test("a prompt's skill picks its lane; anything else goes to the lane with *", () => {
  const lanes = [
    { name: 'reviews', skills: ['review-pr'], slots: 2 },
    { name: 'general', skills: ['*'], slots: 3 },
  ];
  assert.equal(ownLane(task({ id: 'a', input: '/review-pr 17741' }), lanes), 'reviews');
  assert.equal(ownLane(task({ id: 'a', input: '/pr-review:review-pr 17741' }), lanes), 'reviews');
  assert.equal(ownLane(task({ id: 'a', input: '/grill this plan' }), lanes), 'general');
  assert.equal(ownLane(task({ id: 'a', input: 'Find out X' }), lanes), 'general');
  assert.equal(ownLane(task({ id: 'a', input: 'Find out X' }), [lanes[0]!]), undefined);
});
