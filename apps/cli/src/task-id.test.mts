import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireTaskId } from './task-id.mts';

class Refusal extends Error {}

test('a task id passes, and anything else is refused with the error the caller names', () => {
  assert.doesNotThrow(() => requireTaskId('Ab3dEf9x'));
  assert.doesNotThrow(() => requireTaskId('Ab3dEf9xK2mN'));
  for (const bad of ['../x', 'a b', 'a?b=c', 'dispatch', ''])
    assert.throws(() => requireTaskId(bad), /is not a task id$/, bad);
  assert.throws(() => requireTaskId('../x', Refusal), Refusal);
});

test('the refusal quotes at most the first 40 characters', () => {
  assert.throws(() => requireTaskId('x'.repeat(100)), { message: `"${'x'.repeat(40)}" is not a task id` });
});
