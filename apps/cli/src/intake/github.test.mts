import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub, GitHubError } from './github.mts';

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

const node = (n: number) => ({
  url: url(n),
  title: `PR ${n}`,
  number: n,
  isDraft: false,
  headRefOid: `sha${n}`,
  author: { login: 'dev' },
  commits: { nodes: [{ commit: { committedDate: '2026-11-01T10:00:00Z' } }] },
});

const page = (nodes: unknown[], endCursor?: string) => ({
  data: { search: { pageInfo: { hasNextPage: endCursor !== undefined, endCursor: endCursor ?? null }, nodes } },
});

test('the review-request search follows the cursor from page to page', async () => {
  const { calls, run } = recorder((_call, index) =>
    index === 0 ? page([node(1), { url: url(2), title: 'no commit' }], 'c1') : page([node(3)]),
  );
  const found = await createGitHub(run).listReviewRequested(['acme/app', 'acme/lib']);
  assert.deepEqual(
    found.prs.map((pr) => pr.number),
    [1, 3],
  );
  assert.deepEqual(found.unreadable, [url(2)]);
  assert.equal(calls.length, 2);
  for (const { file, args } of calls) {
    assert.equal(file, 'gh');
    assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
    assert.equal(field(args, 'q'), 'is:pr is:open draft:false review-requested:@me repo:acme/app repo:acme/lib');
    assert.match(field(args, 'query') ?? '', /search\(query: \$q, type: ISSUE, first: 100, after: \$after\)/);
  }
  assert.equal(field(calls[0]?.args ?? [], 'after'), undefined);
  assert.equal(field(calls[1]?.args ?? [], 'after'), 'c1');
});

test('no repositories asks nothing; a bad repository name is refused before gh runs', async () => {
  const { calls, run } = recorder(() => page([]));
  assert.deepEqual(await createGitHub(run).listReviewRequested([]), { prs: [], unreadable: [] });
  await assert.rejects(createGitHub(run).listReviewRequested(['acme/app repo:evil/x']), GitHubError);
  assert.deepEqual(calls, []);
});

test('a listing longer than ten pages fails instead of coming back cut short', async () => {
  const { calls, run } = recorder((_call, index) => page([node(index + 1)], `c${index + 1}`));
  await assert.rejects(createGitHub(run).listReviewRequested(['acme/app']), {
    name: 'Error',
    message: 'gh api graphql: more than 1000 review requests',
  });
  assert.equal(calls.length, 10);
});

test('a failed or unreadable search page fails the listing, with the first line of what gh said', async () => {
  const failing = recorder(() => ghFailed('HTTP 401: Bad credentials\n(more)'));
  await assert.rejects(createGitHub(failing.run).listReviewRequested(['acme/app']), {
    message: 'gh api graphql failed: HTTP 401: Bad credentials',
  });
  // The search does not keep an answer that came with a failure: a partial listing must not pass for the whole queue.
  const partial = recorder(() => ghFailed('rate limited', JSON.stringify(page([node(1)]))));
  await assert.rejects(
    createGitHub(partial.run).listReviewRequested(['acme/app']),
    /gh api graphql failed: rate limited/,
  );
  const noStderr = recorder(() => Object.assign(new Error('spawn gh ENOENT'), { stderr: '' }));
  await assert.rejects(createGitHub(noStderr.run).listReviewRequested(['acme/app']), {
    message: 'gh api graphql failed: spawn gh ENOENT',
  });
  const notJson = recorder(() => 'not json');
  await assert.rejects(createGitHub(notJson.run).listReviewRequested(['acme/app']), GitHubError);
  const odd = recorder((_call, index) => (index === 0 ? page([node(1)], 'c1') : { data: {} }));
  await assert.rejects(createGitHub(odd.run).listReviewRequested(['acme/app']), /unreadable gh search output/);
});

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
