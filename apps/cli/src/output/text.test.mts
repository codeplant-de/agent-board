import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorText, fence, oneLine, shellQuote, tail } from './text.mts';

test('tail returns short text unchanged and keeps the end of long text within the limit, led by an ellipsis', () => {
  assert.equal(tail('abc', 3), 'abc');
  assert.equal(tail('abcdef', 4), '…def');
  assert.equal(tail('abcdef', 4).length, 4);
});

test('fence wraps the text in a code fence that the text cannot close', () => {
  assert.equal(fence('hello'), '```\nhello\n```');
  const fenced = fence('before\n```\nafter');
  assert.equal(fenced, "```\nbefore\n'''\nafter\n```");
  assert.equal(fenced.split('```').length, 3);
});

test('oneLine flattens whitespace, trims, and cuts long text to the limit with an ellipsis', () => {
  assert.equal(oneLine('  a \n\n b\t c  ', 20), 'a b c');
  assert.equal(oneLine('abcdef', 6), 'abcdef');
  assert.equal(oneLine('abcdefg', 6), 'abcde…');
});

test('errorText gives the message of an error and the string form of anything else', () => {
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText('plain'), 'plain');
  assert.equal(errorText(42), '42');
  assert.equal(errorText(undefined), 'undefined');
});

test('shellQuote makes one shell argument of any text', () => {
  assert.equal(shellQuote('/home/me/a dir'), "'/home/me/a dir'");
  assert.equal(shellQuote("it's $HOME; `id`"), "'it'\\''s $HOME; `id`'");
  assert.equal(shellQuote(''), "''");
});
