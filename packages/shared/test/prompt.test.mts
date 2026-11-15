import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTitle, isPrUrl, parsePrUrl, prOf, prUrlIn } from '../src/prompt.mts';

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

test("a PR URL is exactly a GitHub pull request, and the PR shown is the prompt's before the agent's", () => {
  assert.equal(isPrUrl(PR), true);
  for (const other of [
    `${PR}/files`,
    `${PR}/`,
    ` ${PR}`,
    `${PR}\nx`,
    'https://github.com/a/b/issues/2',
    'https://github.com.x/a/b/pull/2',
  ])
    assert.equal(isPrUrl(other), false, other);
  const agents = 'https://github.com/a/b/pull/2';
  assert.equal(prOf({ input: `/review-pr ${PR}`, pr: agents }), PR);
  assert.equal(prOf({ input: 'Fix the bug', pr: agents }), agents);
  assert.equal(prOf({ input: 'Fix the bug', pr: null }), undefined);
});
