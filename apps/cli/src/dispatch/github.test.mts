import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub, GitHubError, parsePrStates, prStatesQuery, prStatesVariables } from './github.mts';

interface Call {
  file: string;
  args: string[];
}

// A runner that records each call and answers from `answer`: an object is printed as JSON, an Error is the rejection.
function recorder(answer: (call: Call, index: number) => unknown) {
  const calls: Call[] = [];
  const run = async (file: string, args: string[]): Promise<{ stdout: string }> => {
    const call = { file, args };
    calls.push(call);
    const result = answer(call, calls.length - 1);
    if (result instanceof Error) throw result;
    return { stdout: typeof result === 'string' ? result : JSON.stringify(result) };
  };
  return { calls, run };
}

// How execFile rejects when gh exits non-zero.
const ghFailed = (stderr: string, stdout = ''): Error =>
  Object.assign(new Error(`Command failed: gh api graphql\n${stderr}`), { stdout, stderr });

// The value of a `-f name=value` / `-F name=value` argument.
function field(args: string[], name: string): string | undefined {
  return args
    .find((arg, index) => index > 0 && /^-[fF]$/.test(args[index - 1] ?? '') && arg.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

const url = (n: number) => `https://github.com/acme/app/pull/${n}`;

// An answer to the PR state query for the URLs in a call: each alias gets the state `state` gives its PR number.
function statesAnswer(args: string[], state: (number: number) => string | null) {
  const data: Record<string, unknown> = {};
  for (let index = 0; field(args, `k${index}`) !== undefined; index++) {
    const value = state(Number(field(args, `k${index}`)));
    data[`p${index}`] = value === null ? null : { pullRequest: { state: value } };
  }
  return { data };
}

test('PR states are asked fifty at a time, numbers as typed fields, and malformed URLs are unreadable without a query', async () => {
  const urls = [...Array.from({ length: 51 }, (_, i) => url(i + 1)), 'https://example.com/x', url(2 ** 31)];
  const { calls, run } = recorder(({ args }) => statesAnswer(args, (n) => (n % 2 === 0 ? 'MERGED' : 'OPEN')));
  const lookup = await createGitHub(run).prStates(urls);
  assert.equal(calls.length, 2);
  assert.equal(lookup.states.size, 51);
  assert.equal(lookup.states.get(url(1)), 'open');
  assert.equal(lookup.states.get(url(2)), 'merged');
  assert.deepEqual(lookup.unreadable, ['https://example.com/x', url(2 ** 31)]);
  const [first, second] = calls.map((call) => call.args);
  assert.equal(field(first ?? [], 'k49'), '50');
  assert.equal(field(first ?? [], 'k50'), undefined);
  assert.equal(field(second ?? [], 'k0'), '51');
  assert.equal(first?.[first.indexOf('k0=1') - 1], '-F');
  assert.equal(first?.[first.indexOf('o0=acme') - 1], '-f');
  assert.equal(field(first ?? [], 'n0'), 'app');
});

test('a PR state answer that came with errors is kept for the PRs it has', async () => {
  const { run } = recorder(({ args }) =>
    ghFailed(
      'GraphQL: Could not resolve to a PullRequest',
      JSON.stringify(statesAnswer(args, (n) => (n === 2 ? null : 'CLOSED'))),
    ),
  );
  const lookup = await createGitHub(run).prStates([url(1), url(2)]);
  assert.deepEqual([...lookup.states], [[url(1), 'closed']]);
  assert.deepEqual(lookup.unreadable, [url(2)]);
});

test('a failed PR state query leaves its PRs unreadable, and throws only when every query failed', async () => {
  const urls = Array.from({ length: 60 }, (_, i) => url(i + 1));
  const some = recorder(({ args }, index) =>
    index === 0 ? ghFailed('HTTP 502', 'Bad Gateway') : statesAnswer(args, () => 'OPEN'),
  );
  const lookup = await createGitHub(some.run).prStates(urls);
  assert.equal(lookup.states.size, 10);
  assert.deepEqual(lookup.unreadable, urls.slice(0, 50));

  const all = recorder(() => ghFailed('HTTP 502'));
  await assert.rejects(createGitHub(all.run).prStates(urls), { message: 'gh api graphql failed: HTTP 502' });
  assert.equal(all.calls.length, 2, 'every chunk is tried before the outage is reported');
});

test('no queryable PR asks gh nothing', async () => {
  const { calls, run } = recorder(() => ({ data: {} }));
  assert.deepEqual(await createGitHub(run).prStates(['https://example.com/x']), {
    states: new Map(),
    unreadable: ['https://example.com/x'],
  });
  assert.deepEqual(calls, []);
});

test('the PR states query has an alias and variables per PR, and no URL text in it', () => {
  const urls = [url(1), 'https://github.com/o/r.x/pull/22'];
  assert.equal(
    prStatesQuery(2),
    [
      'query($o0: String!, $n0: String!, $k0: Int!, $o1: String!, $n1: String!, $k1: Int!) {',
      '  p0: repository(owner: $o0, name: $n0) { pullRequest(number: $k0) { state } }',
      '  p1: repository(owner: $o1, name: $n1) { pullRequest(number: $k1) { state } }',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(prStatesVariables(urls), {
    o0: 'acme',
    n0: 'app',
    k0: 1,
    o1: 'o',
    n1: 'r.x',
    k1: 22,
  });
  assert.equal(prStatesVariables(['https://github.com/o"x/r/pull/1']), undefined);
  assert.equal(prStatesVariables(['https://github.com/o/r/pull/2147483648']), undefined);
  assert.ok(prStatesVariables(['https://github.com/o/r/pull/2147483647']));
});

test('the PR states answer maps GitHub’s states, and a PR it found nothing for is unreadable', () => {
  const urls = [url(1), url(2), url(3), url(4)];
  const answer = {
    data: {
      p0: { pullRequest: { state: 'MERGED' } },
      p1: { pullRequest: { state: 'CLOSED' } },
      p2: null,
      p3: { pullRequest: { state: 'SOMETHING_NEW' } },
    },
    errors: [{ type: 'NOT_FOUND' }],
  };
  const found = parsePrStates(answer, urls);
  assert.deepEqual(
    [...found.states],
    [
      [url(1), 'merged'],
      [url(2), 'closed'],
    ],
  );
  assert.deepEqual(found.unreadable, [url(3), url(4)]);
  assert.deepEqual(
    [...parsePrStates({ data: { p0: { pullRequest: { state: 'OPEN' } } } }, [url(1)]).states],
    [[url(1), 'open']],
  );
  assert.throws(() => parsePrStates({ errors: [] }, urls), GitHubError);
  assert.throws(() => parsePrStates('nope', urls), GitHubError);
});

test('createGitHub ends a gh call that outlasts timeoutMs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-slow-gh-'));
  const before = process.env['PATH'];
  try {
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nsleep 5\necho \'{"data":{}}\'\n', { mode: 0o755 });
    process.env['PATH'] = `${dir}:${before}`;
    const started = Date.now();
    await assert.rejects(createGitHub(undefined, { timeoutMs: 100 }).prStates([url(1)]), GitHubError);
    assert.ok(Date.now() - started < 3000, 'the call was cut off');
  } finally {
    process.env['PATH'] = before;
    rmSync(dir, { recursive: true });
  }
});
