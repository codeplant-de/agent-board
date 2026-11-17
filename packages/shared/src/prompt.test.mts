import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTitle, isPrUrl, parsePrUrl, prsOf, prUrlIn } from './prompt.mts';

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
});

test('prsOf lists the PR of the prompt first, then the reported ones in order', () => {
  const second = 'https://github.com/a/b/pull/2';
  const third = 'https://github.com/a/b/pull/3';
  const none = { input: 'Fix the bug', prs: [], promptPrState: null } as const;
  assert.deepEqual(prsOf(none), []);
  assert.deepEqual(prsOf({ ...none, input: `/review-pr ${PR}`, promptPrState: 'open' }), [
    { url: PR, state: 'open', prompt: true },
  ]);
  assert.deepEqual(
    prsOf({
      ...none,
      prs: [
        { id: 'r1', url: second, state: 'merged' },
        { id: 'r2', url: third, state: null },
      ],
      promptPrState: 'closed',
    }),
    [
      { url: second, state: 'merged', id: 'r1', prompt: false },
      { url: third, state: null, id: 'r2', prompt: false },
    ],
  );
  assert.deepEqual(
    prsOf({ input: `/review-pr ${PR}`, prs: [{ id: 'r1', url: second, state: 'merged' }], promptPrState: 'closed' }),
    [
      { url: PR, state: 'closed', prompt: true },
      { url: second, state: 'merged', id: 'r1', prompt: false },
    ],
  );
});

test('prsOf shows a PR of the prompt that was also reported once, with the reported row and its state', () => {
  const input = `/review-pr ${PR}`;
  assert.deepEqual(prsOf({ input, prs: [{ id: 'r1', url: PR, state: 'merged' }], promptPrState: 'open' }), [
    { url: PR, state: 'merged', id: 'r1', prompt: true },
  ]);
  assert.deepEqual(prsOf({ input, prs: [{ id: 'r1', url: PR, state: null }], promptPrState: 'open' }), [
    { url: PR, state: 'open', id: 'r1', prompt: true },
  ]);
});

test('prsOf shows a URL once however often it was reported, from its first row', () => {
  const second = 'https://github.com/a/b/pull/2';
  const prs = [
    { id: 'r1', url: second, state: 'open' as const },
    { id: 'r2', url: PR, state: null },
    { id: 'r3', url: second, state: 'merged' as const },
    { id: 'r4', url: PR, state: 'closed' as const },
  ];
  assert.deepEqual(prsOf({ input: 'Fix the bug', prs, promptPrState: null }), [
    { url: second, state: 'open', id: 'r1', prompt: false },
    { url: PR, state: null, id: 'r2', prompt: false },
  ]);
  assert.deepEqual(prsOf({ input: `/review-pr ${PR}`, prs, promptPrState: null }), [
    { url: PR, state: null, id: 'r2', prompt: true },
    { url: second, state: 'open', id: 'r1', prompt: false },
  ]);
});
