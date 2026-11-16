import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskLink } from './links.mts';

test('a task link is built from the board URL and the id, and only for a task id', () => {
  assert.equal(taskLink('https://board.test', 'Ab3dEf9x'), 'https://board.test/t/Ab3dEf9x');
  for (const bad of ['../x', 'a b', 'a?b=c', 'dispatch', ''])
    assert.throws(() => taskLink('https://board.test', bad), /not a task id/, bad);
});
