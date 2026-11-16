import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendError } from '../backend/backend.mts';
import {
  GitHubError,
  parsePrStates,
  parseSearchPage,
  prStatesQuery,
  prStatesVariables,
  searchQuery,
} from './github.mts';
import { STATUSES } from '@agent-board/shared';
import type { PrState, Status } from '@agent-board/shared';
import type { LivePr } from './github.mts';
import { planIntake, planPrStates, prsToCheck, runIntake } from './intake.mts';
import { CONFIG, fakeBackend, NO_PR_STATES, task } from '../__tests__/helpers/fakes.mts';

const NOW = new Date('2026-01-01T12:00:00Z');
const url = (n: number) => `https://github.com/cosuno/cosuno/pull/${n}`;

function pr(n: number, overrides: Partial<LivePr> = {}): LivePr {
  return {
    url: url(n),
    title: `PR ${n}`,
    author: 'dev',
    number: n,
    headSha: 'bbbbbbb1',
    headCommittedAt: new Date(NOW.getTime() - 30 * 60_000),
    isDraft: false,
    ...overrides,
  };
}

const taskFor = (n: number, status: Status, head = 'aaaaaaa1') =>
  task({ id: `c${n}`, status, createdBy: 'intake', input: `/review-pr ${url(n)} --auto`, head });
const plan = (prs: LivePr[], tasks = [] as ReturnType<typeof task>[]) =>
  planIntake({ prs, tasks, repos: Object.keys(CONFIG.repos), now: NOW, headIndex: (sha) => sha }).map((a) =>
    a.kind === 'skip' ? `skip:${a.reason}` : a.kind === 'close' ? `close:${a.task.id}` : a.kind,
  );

test('a new settled PR gets a task', () => {
  assert.deepEqual(plan([pr(1)]), ['create']);
});

test('drafts, unmapped repos and unsettled heads are skipped', () => {
  const unmapped = pr(2, { url: 'https://github.com/other/repo/pull/2' });
  const fresh = pr(3, { headCommittedAt: new Date(NOW.getTime() - 60_000) });
  assert.deepEqual(plan([pr(1, { isDraft: true }), unmapped, fresh]), [
    'skip:draft',
    'skip:repository not in config',
    'skip:head not settled',
  ]);
});

test('a PR with a task in any status never gets a second task', () => {
  for (const status of STATUSES)
    assert.deepEqual(plan([pr(1, { headSha: 'aaaaaaa1' })], [taskFor(1, status)]), ['skip:task exists']);
});

test('a moved, settled head requeues a task from Needs me or Done only', () => {
  assert.deepEqual(plan([pr(1)], [taskFor(1, 'needs-me')]), ['requeue']);
  assert.deepEqual(plan([pr(1)], [taskFor(1, 'done')]), ['requeue']);
  assert.deepEqual(plan([pr(1)], [taskFor(1, 'todo')]), ['skip:head moved, task is todo']);
  assert.deepEqual(plan([pr(1)], [taskFor(1, 'running')]), ['skip:head moved, task is running']);
});

test('a task parked in Backlog is left alone when its PR gets a new push', () => {
  assert.deepEqual(plan([pr(1)], [taskFor(1, 'backlog')]), ['skip:head moved, task is backlog']);
});

test('a failed task stays put while its head is unchanged, and is retried when the head moves', () => {
  assert.deepEqual(plan([pr(1, { headSha: 'aaaaaaa1' })], [taskFor(1, 'needs-me')]), ['skip:task exists']);
  assert.deepEqual(plan([pr(1)], [taskFor(1, 'needs-me')]), ['requeue']);
});

test('a moved head that has not settled waits', () => {
  const fresh = pr(1, { headCommittedAt: new Date(NOW.getTime() - 60_000) });
  assert.deepEqual(plan([fresh], [taskFor(1, 'needs-me')]), ['skip:head moved, not settled']);
});

test('a hand-made task without a head is left alone', () => {
  assert.deepEqual(plan([pr(1)], [task({ id: 'h', status: 'needs-me', input: url(1) })]), ['skip:task exists']);
});

test('running intake twice creates the task once', async () => {
  const backend = fakeBackend([]);
  const logs: string[] = [];
  const deps = {
    backend,
    config: CONFIG,
    dryRun: false,
    print: (line: string) => logs.push(line),
    github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: [pr(1)], unreadable: [] }) },
    now: () => NOW,
  };
  await runIntake(deps);
  backend.tasks.push(task({ id: 'new', input: url(1), head: 'bbbbbbb1' }));
  await runIntake(deps);
  assert.equal(backend.writes.filter((w) => w.startsWith('create')).length, 1);
  assert.ok(logs.includes('INTAKE prs=1 created=0 requeued=0 done=0'));
});

test('a PR whose task the board hides from this CLI is skipped with one line, and the tick goes on', async () => {
  const backend = fakeBackend([]);
  const logs: string[] = [];
  const hidden = new BackendError('add-task: HTTP 422', 422, true);
  const addTask = backend.addTask.bind(backend);
  backend.addTask = async (draft) => {
    if (draft.dedupeKey === url(1)) throw hidden;
    return addTask(draft);
  };
  await runIntake({
    backend,
    config: CONFIG,
    dryRun: false,
    print: (line: string) => logs.push(line),
    github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: [pr(1), pr(2)], unreadable: [] }) },
    now: () => NOW,
  });
  assert.ok(logs.some((line) => line.startsWith('SKIP #1 its task on the board uses a value this CLI does not know')));
  assert.ok(logs.includes('CREATED #2'));
  assert.ok(logs.includes('INTAKE prs=2 created=1 requeued=0 done=0'));
  await assert.rejects(
    runIntake({
      backend: Object.assign(fakeBackend([]), {
        addTask: async () => {
          throw new BackendError('add-task: HTTP 500', 500, true);
        },
      }),
      config: CONFIG,
      dryRun: false,
      print: () => undefined,
      github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: [pr(1)], unreadable: [] }) },
      now: () => NOW,
    }),
    /HTTP 500/,
  );
});

test('requeue moves the task, updates the head and comments', async () => {
  const backend = fakeBackend([taskFor(1, 'needs-me')]);
  await runIntake({
    backend,
    config: CONFIG,
    dryRun: false,
    print: () => undefined,
    github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: [pr(1)], unreadable: [] }) },
    now: () => NOW,
  });
  assert.deepEqual(
    backend.writes.map((w) => w.split(':')[0]),
    ['status c1 -> todo', 'input c1', 'next c1', 'note c1 (system)'],
  );
});

test('a failed listing changes nothing and fails the run', async () => {
  const backend = fakeBackend([taskFor(1, 'needs-me')]);
  await assert.rejects(
    runIntake({
      backend,
      config: CONFIG,
      dryRun: false,
      print: () => undefined,
      github: {
        ...NO_PR_STATES,
        listReviewRequested: async () => {
          throw new GitHubError('gh search failed: boom');
        },
      },
      now: () => NOW,
    }),
    GitHubError,
  );
  assert.deepEqual(backend.writes, []);
});

test('a closed task still counts, so no second task and no requeue', () => {
  const closedTask = { ...taskFor(1, 'done'), closed: true };
  assert.deepEqual(plan([pr(1)], [closedTask]), ['skip:task closed']);
  assert.deepEqual(plan([pr(1, { headSha: 'aaaaaaa1' })], [closedTask]), ['skip:task closed']);
});

test('intake reads every task closed included', async () => {
  const backend = fakeBackend([{ ...taskFor(1, 'done'), closed: true }]);
  await runIntake({
    backend,
    config: CONFIG,
    dryRun: false,
    print: () => undefined,
    github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: [pr(1)], unreadable: [] }) },
    now: () => NOW,
  });
  assert.deepEqual(backend.writes, []);
});

test('the search is asked per configured repo', async () => {
  const asked: string[][] = [];
  const backend = fakeBackend([]);
  await runIntake({
    backend,
    config: CONFIG,
    dryRun: false,
    print: () => undefined,
    github: {
      ...NO_PR_STATES,
      listReviewRequested: async (repos) => {
        asked.push(repos);
        return { prs: [], unreadable: [] };
      },
    },
    now: () => NOW,
  });
  assert.deepEqual(asked, [['cosuno/cosuno']]);
});

const node = (n: number, overrides: Record<string, unknown> = {}) => ({
  url: url(n),
  title: `PR ${n}`,
  number: n,
  isDraft: false,
  headRefOid: 'b13e6c6ba770547fd5f799c1e7598ee182e1b4c6',
  author: { login: 'dev' },
  commits: { nodes: [{ commit: { committedDate: '2026-11-13T14:03:12Z' } }] },
  ...overrides,
});
const page = (nodes: unknown[], hasNextPage = false) => ({
  data: { search: { pageInfo: { hasNextPage, endCursor: hasNextPage ? 'CURSOR' : null }, nodes } },
});

test('the GraphQL search answer is checked, not cast', () => {
  const found = parseSearchPage(page([node(1), node(2, { author: null })], true));
  assert.deepEqual(found.prs[0], {
    url: url(1),
    title: 'PR 1',
    number: 1,
    isDraft: false,
    author: 'dev',
    headSha: 'b13e6c6ba770547fd5f799c1e7598ee182e1b4c6',
    headCommittedAt: new Date('2026-11-13T14:03:12Z'),
  });
  assert.equal(found.prs[1]?.author, 'ghost', 'a deleted account has no author');
  assert.equal(found.next, 'CURSOR');
  assert.equal(parseSearchPage(page([])).next, undefined);
  for (const nameless of [{}, null, node(1, { url: undefined })]) {
    assert.throws(() => parseSearchPage(page([nameless])), GitHubError, 'a node without a URL fails the run');
  }
  assert.throws(() => parseSearchPage({ data: null }), GitHubError);
  assert.throws(
    () => parseSearchPage({ data: { search: { pageInfo: { hasNextPage: true }, nodes: [] } } }),
    GitHubError,
  );
});

test('one search covers every configured repository', () => {
  assert.equal(searchQuery(['a/b', 'c/d.e']), 'is:pr is:open draft:false review-requested:@me repo:a/b repo:c/d.e');
  assert.throws(() => searchQuery(['a/b label:x']), GitHubError);
});

test('a todo review whose PR no longer asks for the review is done', async () => {
  assert.deepEqual(plan([pr(2)], [taskFor(1, 'todo')]), ['create', 'close:c1']);
  assert.deepEqual(plan([pr(1)], [taskFor(1, 'todo', 'bbbbbbb1')]), ['skip:task exists'], 'still listed');
  const backend = fakeBackend([taskFor(1, 'todo')]);
  const logs: string[] = [];
  await runIntake({
    backend,
    config: CONFIG,
    dryRun: false,
    print: (line) => logs.push(line),
    github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: [], unreadable: [] }) },
    now: () => NOW,
  });
  assert.deepEqual(backend.writes, ['status c1 -> done', 'note c1 (system): The PR no longer asks for your review.']);
  assert.ok(logs.includes('INTAKE prs=0 created=0 requeued=0 done=1'));
});

test('only an open, fresh, intake-made todo task of a configured repo is closed for a gone PR', () => {
  const other = (overrides: Partial<ReturnType<typeof task>>) => ({ ...taskFor(1, 'todo'), ...overrides });
  for (const kept of [
    other({ status: 'running' }),
    other({ status: 'needs-me' }),
    other({ closed: true }),
    other({ next: 'resume', sessionId: 's', machine: 'here' }),
    other({ createdBy: 'user' }),
    other({ input: '/review-pr https://github.com/other/repo/pull/9 --auto' }),
    other({ input: '/grill the plan' }),
  ]) {
    assert.deepEqual(plan([], [kept]), []);
  }
});

test('a failed listing closes nothing', async () => {
  const backend = fakeBackend([taskFor(1, 'todo')]);
  await assert.rejects(
    runIntake({
      backend,
      config: CONFIG,
      dryRun: false,
      print: () => undefined,
      github: {
        ...NO_PR_STATES,
        listReviewRequested: async () => {
          throw new GitHubError('gh api failed');
        },
      },
      now: () => NOW,
    }),
    GitHubError,
  );
  assert.deepEqual(backend.writes, []);
});

test('a failed backend listing creates nothing and fails the run', async () => {
  const backend = fakeBackend([]);
  backend.listTasks = async () => {
    throw new Error('backend list-tasks failed');
  };
  await assert.rejects(
    runIntake({
      backend,
      config: CONFIG,
      dryRun: false,
      print: () => undefined,
      github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: [pr(1)], unreadable: [] }) },
      now: () => NOW,
    }),
    /list-tasks failed/,
  );
  assert.deepEqual(backend.writes, []);
});

test('intake creates its tasks with the configured priority', async () => {
  const backend = fakeBackend([]);
  const drafts: unknown[] = [];
  const addTask = backend.addTask.bind(backend);
  backend.addTask = async (draft) => {
    drafts.push(draft);
    return addTask(draft);
  };
  await runIntake({
    backend,
    config: { ...CONFIG, intake: { ...CONFIG.intake, priority: 'high' } },
    dryRun: false,
    print: () => undefined,
    github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: [pr(1)], unreadable: [] }) },
    now: () => NOW,
  });
  assert.equal((drafts[0] as { priority: string }).priority, 'high');
});

test('a PR that cannot be read is reported apart and does not stop the others', () => {
  const found = parseSearchPage(
    page([node(1, { commits: { nodes: [] } }), node(2, { headRefOid: undefined }), node(3, { number: '1' }), node(4)]),
  );
  assert.deepEqual(found.unreadable, [url(1), url(2), url(3)]);
  assert.deepEqual(
    found.prs.map((listed) => listed.number),
    [4],
  );
});

test('intake logs an unreadable PR and neither creates nor closes a task for it', async () => {
  const backend = fakeBackend([taskFor(1, 'todo')]);
  const logs: string[] = [];
  await runIntake({
    backend,
    config: CONFIG,
    dryRun: false,
    print: (line) => logs.push(line),
    github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: [], unreadable: [url(1), url(2)] }) },
    now: () => NOW,
  });
  assert.deepEqual(backend.writes, []);
  assert.ok(logs.includes(`WARN skipped ${url(1)}`));
  assert.ok(logs.includes(`WARN skipped ${url(2)}`));
  assert.deepEqual(
    planIntake({
      prs: [],
      unreadable: [url(1)],
      tasks: [taskFor(1, 'todo')],
      repos: Object.keys(CONFIG.repos),
      now: NOW,
      headIndex: (sha) => sha,
    }),
    [],
  );
});

test('a task closed as gone loses its head and comes back when the PR is listed again', async () => {
  const backend = fakeBackend([taskFor(1, 'todo', 'bbbbbbb1')]);
  const asked = { prs: [] as LivePr[], unreadable: [] as string[] };
  const github = { ...NO_PR_STATES, listReviewRequested: async () => asked };
  const deps = { backend, config: CONFIG, dryRun: false, print: () => undefined, github, now: () => NOW };
  await runIntake(deps);
  assert.equal(backend.tasks[0]?.status, 'done');
  assert.equal(backend.tasks[0]?.head, null);
  asked.prs = [pr(1)];
  backend.writes.length = 0;
  await runIntake(deps);
  assert.deepEqual(
    backend.writes.map((w) => w.split(':')[0]),
    ['status c1 -> todo', 'input c1', 'next c1', 'note c1 (system)'],
  );
  assert.match(backend.writes.at(-1) ?? '', /The PR asks for your review again \(head bbbbbbb\)\. Queued again\./);
  assert.equal(backend.tasks[0]?.head, 'bbbbbbb1');
  assert.equal(backend.tasks[0]?.status, 'todo');
});

test('a task claimed since the listing is neither closed nor requeued: the update is refused and logged', async () => {
  for (const [local, listed] of [
    [taskFor(1, 'needs-me'), pr(1)],
    [{ ...taskFor(1, 'done'), head: null }, pr(1)],
    [taskFor(1, 'todo', 'bbbbbbb1'), undefined],
  ] as const) {
    const backend = fakeBackend([local]);
    // The dispatcher claims the task between the listing and the plan's write.
    const listTasks = backend.listTasks;
    backend.listTasks = async (options) => {
      const seen = await listTasks(options);
      backend.tasks[0]!.status = 'running';
      return seen;
    };
    const logs: string[] = [];
    await runIntake({
      backend,
      config: CONFIG,
      dryRun: false,
      print: (line) => logs.push(line),
      github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: listed ? [listed] : [], unreadable: [] }) },
      now: () => NOW,
    });
    assert.equal(backend.tasks[0]?.status, 'running');
    assert.equal(backend.tasks[0]?.head, local.head);
    assert.ok(!backend.writes.some((w) => w.startsWith('note ') || w.startsWith('status ')));
    assert.ok(logs.includes('SKIP c1 changed since the listing'));
  }
});

test("only a done intake task without a head comes back; a done task of the user's keeps its head and stays", () => {
  assert.deepEqual(plan([pr(1)], [{ ...taskFor(1, 'done'), head: null }]), ['requeue']);
  assert.deepEqual(plan([pr(1)], [{ ...taskFor(1, 'done'), head: null, createdBy: 'user' }]), ['skip:task exists']);
  assert.deepEqual(plan([pr(1, { headSha: 'aaaaaaa1' })], [taskFor(1, 'done')]), ['skip:task exists']);
  assert.deepEqual(
    plan([pr(1, { headCommittedAt: new Date(NOW.getTime() - 60_000) })], [{ ...taskFor(1, 'done'), head: null }]),
    ['skip:listed again, not settled'],
  );
});

test('heads are compared as blind indexes: the board holds no sha, and an unmoved head is not requeued', async () => {
  const index = (sha: string) => `abh1.index-of-${sha}`;
  const prs = [pr(1, { headSha: 'bbbbbbb1' }), pr(2, { headSha: 'ccccccc2' })];
  const tasks = [taskFor(1, 'needs-me', index('bbbbbbb1')), taskFor(2, 'needs-me', index('aaaaaaa1'))];
  const actions = planIntake({
    prs,
    tasks,
    repos: Object.keys(CONFIG.repos),
    now: NOW,
    headIndex: index,
  }).map((a) => (a.kind === 'skip' ? `skip:${a.reason}` : a.kind));
  assert.deepEqual(actions, ['skip:task exists', 'requeue']);
});

test('a requeue seals the new prompt as intake’s own and stores the head through the backend’s index', async () => {
  const backend = fakeBackend([taskFor(1, 'needs-me')]);
  const patches: unknown[] = [];
  const update = backend.updateTask.bind(backend);
  backend.updateTask = async (id, patch) => (patches.push(patch), update(id, patch));
  backend.indexHead = async (sha) => `abh1.${sha}`;
  await runIntake({
    backend,
    config: CONFIG,
    dryRun: false,
    print: () => undefined,
    github: { ...NO_PR_STATES, listReviewRequested: async () => ({ prs: [pr(1)], unreadable: [] }) },
    now: () => NOW,
  });
  assert.deepEqual(patches[0], {
    status: 'todo',
    input: `/review-pr ${url(1)} --auto`,
    head: 'bbbbbbb1',
    next: 'fresh',
    seal: { createdBy: 'intake', scheduleId: null },
    expect: 'needs-me',
  });
});

const lookup = (states: Record<string, PrState> = {}, unreadable: string[] = []) => ({
  states: new Map(Object.entries(states)),
  unreadable,
});

test('the PR states asked for are those of the open tasks’ PRs, the agent’s and the prompt’s, each once', () => {
  const agents = task({ id: 'a1', status: 'needs-me', input: 'fix it', pr: url(7) });
  const both = task({ id: 'b1', status: 'needs-me', input: `/review-pr ${url(8)}`, pr: url(9) });
  const tasks = [
    taskFor(1, 'needs-me'),
    taskFor(1, 'todo'),
    taskFor(2, 'done'),
    { ...taskFor(3, 'needs-me'), closed: true },
    agents,
    both,
    task({ id: 'plain', status: 'needs-me', input: 'no pr' }),
  ];
  assert.deepEqual(prsToCheck(tasks), [url(1), url(7), url(9)]);
});

test('a task is written only when GitHub’s state differs from the stored one, and an unanswered PR changes nothing', () => {
  const tasks = [
    taskFor(1, 'needs-me'),
    { ...taskFor(2, 'needs-me'), prState: 'open' as const },
    { ...taskFor(3, 'needs-me'), prState: 'merged' as const },
    taskFor(4, 'needs-me'),
    { ...taskFor(5, 'done'), prState: 'open' as const },
  ];
  const planned = planPrStates(
    tasks,
    lookup({ [url(1)]: 'merged', [url(2)]: 'open', [url(3)]: 'closed', [url(5)]: 'merged' }, [url(4)]),
  );
  assert.deepEqual(
    planned.map(({ task: { id }, prState }) => `${id}:${prState}`),
    ['c1:merged', 'c3:closed'],
  );
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
    o0: 'cosuno',
    n0: 'cosuno',
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

test('intake writes the changed PR states after the review work, and logs the PRs it has no state for', async () => {
  const backend = fakeBackend([taskFor(1, 'needs-me'), taskFor(2, 'needs-me'), taskFor(3, 'needs-me')]);
  const logs: string[] = [];
  await runIntake({
    backend,
    config: CONFIG,
    dryRun: false,
    print: (line) => logs.push(line),
    github: {
      listReviewRequested: async () => ({ prs: [pr(1)], unreadable: [] }),
      prStates: async () => lookup({ [url(1)]: 'merged', [url(2)]: 'closed' }, [url(3)]),
    },
    now: () => NOW,
  });
  assert.deepEqual(
    backend.writes.map((write) => write.split(':')[0]),
    ['status c1 -> todo', 'input c1', 'next c1', 'note c1 (system)', 'prState c1 merged', 'prState c2 closed'],
  );
  assert.ok(logs.includes(`WARN no state for ${url(3)}`));
  assert.ok(logs.includes('PRSTATES changed=2'));
});

test('a failed PR state query is logged and the review work is kept', async () => {
  const backend = fakeBackend([taskFor(1, 'needs-me')]);
  const logs: string[] = [];
  await runIntake({
    backend,
    config: CONFIG,
    dryRun: false,
    print: (line) => logs.push(line),
    github: {
      listReviewRequested: async () => ({ prs: [pr(1)], unreadable: [] }),
      prStates: async () => {
        throw new GitHubError('gh api graphql failed: boom');
      },
    },
    now: () => NOW,
  });
  assert.equal(backend.writes.length, 4);
  assert.ok(logs.includes('WARN PR states not refreshed: gh api graphql failed: boom'));
});

test('a board server without PR states is told once and intake still finishes', async () => {
  const backend = fakeBackend([taskFor(1, 'needs-me'), taskFor(2, 'needs-me')]);
  backend.setPrState = async () => {
    throw Object.assign(new BackendError('the board server does not support PR states yet'), {
      missingFeature: 'task.pr-state' as const,
    });
  };
  const logs: string[] = [];
  await runIntake({
    backend,
    config: CONFIG,
    dryRun: false,
    print: (line) => logs.push(line),
    github: {
      listReviewRequested: async () => ({ prs: [], unreadable: [] }),
      prStates: async () => lookup({ [url(1)]: 'merged', [url(2)]: 'merged' }),
    },
    now: () => NOW,
  });
  assert.equal(logs.filter((line) => line.startsWith('WARN PR states not written')).length, 1);
});
