import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTitle, parsePrUrl, prUrlIn } from '../src/prompt.mts';

const PR = 'https://github.com/cosuno/cosuno/pull/17741';

test('the PR a prompt names is the URL in its first line', () => {
  assert.equal(prUrlIn(`/review-pr ${PR} --auto\nsee https://github.com/a/b/pull/2`), PR);
  assert.equal(prUrlIn(`Find out X\n${PR}`), undefined);
  assert.deepEqual(parsePrUrl(PR), { repo: 'cosuno/cosuno', number: 17741 });
  assert.equal(parsePrUrl(`${PR}/files`), undefined);
});

test('a default title is the first non-empty line, shortened', () => {
  assert.equal(defaultTitle('\n  Find out X  \nmore detail'), 'Find out X');
  assert.equal(defaultTitle('x'.repeat(150)), `${'x'.repeat(99)}…`);
});
