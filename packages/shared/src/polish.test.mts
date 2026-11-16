import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractError } from './contract.mts';
import { parsePolish, serializePolish } from './polish.mts';

test('a polish note is checked against what the board takes, and only a whole one is read back', () => {
  const good = { target: 'Zz9dEf9x', title: 'T', prompt: 'P' };
  assert.deepEqual(parsePolish(serializePolish({ ...good, title: ' T ', prompt: ' P\n' })), good);
  assert.throws(() => serializePolish({ ...good, title: '  ' }), ContractError);
  assert.throws(() => serializePolish({ ...good, title: 'two\nlines' }), /one line/);
  assert.throws(() => serializePolish({ ...good, prompt: '' }), /prompt is empty/);
  assert.throws(() => serializePolish({ ...good, target: 'no/pe' }), /id of the task/);
  assert.throws(() => serializePolish({ ...good, title: 'x'.repeat(1201) }), /title is too long.*at most 1200/);
  assert.throws(() => serializePolish({ ...good, prompt: 'x'.repeat(800_001) }), /prompt is too long.*at most 800000/);
  for (const text of ['x', '[]', '{}', JSON.stringify({ ...good, extra: 1 }), JSON.stringify({ ...good, title: 1 })])
    assert.equal(parsePolish(text), undefined, text);
});
