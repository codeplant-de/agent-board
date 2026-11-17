import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrState } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { fakeBackend, NO_PR_STATES, task } from '../__tests__/helpers/fakes.mts';
import { GitHubError } from './github.mts';
import { planPrStates, prsToCheck, refreshPrStates } from './pr-states.mts';

const url = (n: number) => `https://github.com/acme/app/pull/${n}`;
const taskFor = (n: number, status: Parameters<typeof task>[0]['status']) =>
  task({ id: `c${n}`, status, input: `/review-pr ${url(n)} --auto`, head: 'aaaaaaa1' });

const lookup = (states: Record<string, PrState> = {}, unreadable: string[] = []) => ({
  states: new Map(Object.entries(states)),
  unreadable,
});

const row = (id: string, n: number, state: PrState | null = null) => ({ id, url: url(n), state });

test('the PR states asked for are those of the open tasks’ PRs, the agent’s and the prompt’s, each once', () => {
  const agents = task({ id: 'a1', status: 'needs-me', input: 'fix it', prs: [row('r1', 7), row('r2', 10)] });
  const both = task({ id: 'b1', status: 'needs-me', input: `/review-pr ${url(8)}`, prs: [row('r3', 9), row('r4', 7)] });
  const tasks = [
    taskFor(1, 'needs-me'),
    taskFor(1, 'todo'),
    taskFor(2, 'done'),
    { ...taskFor(3, 'needs-me'), closed: true },
    agents,
    both,
    task({ id: 'plain', status: 'needs-me', input: 'no pr' }),
  ];
  assert.deepEqual(prsToCheck(tasks), [url(1), url(7), url(10), url(8), url(9)]);
});

test('a task is written only with the PRs whose state differs from the stored one, and an unanswered PR changes nothing', () => {
  const tasks = [
    taskFor(1, 'needs-me'),
    { ...taskFor(2, 'needs-me'), promptPrState: 'open' as const },
    { ...taskFor(3, 'needs-me'), promptPrState: 'merged' as const },
    taskFor(4, 'needs-me'),
    { ...taskFor(5, 'done'), promptPrState: 'open' as const },
  ];
  const planned = planPrStates(
    tasks,
    lookup({ [url(1)]: 'merged', [url(2)]: 'open', [url(3)]: 'closed', [url(5)]: 'merged' }, [url(4)]),
  );
  assert.deepEqual(
    planned.map(({ task: { id }, states }) => ({ id, states })),
    [
      { id: 'c1', states: { prompt: 'merged' } },
      { id: 'c3', states: { prompt: 'closed' } },
    ],
  );
});

test('a task with several PRs gets one write holding only the ones that changed', () => {
  const several = task({
    id: 's1',
    status: 'needs-me',
    input: `/review-pr ${url(1)}`,
    prs: [row('r1', 2, 'open'), row('r2', 3, 'merged'), row('r3', 4), row('r4', 1)],
    promptPrState: 'open',
  });
  const planned = planPrStates(
    [several],
    lookup({ [url(1)]: 'merged', [url(2)]: 'open', [url(3)]: 'merged', [url(4)]: 'open' }),
  );
  assert.equal(planned.length, 1);
  assert.deepEqual(planned[0]?.states, {
    prs: [
      { id: 'r4', state: 'merged' },
      { id: 'r3', state: 'open' },
    ],
  });
});

test('refreshPrStates writes the changed states and logs the PRs it has no state for', async () => {
  const tasks = [taskFor(1, 'needs-me'), taskFor(2, 'needs-me'), taskFor(3, 'needs-me')];
  const backend = fakeBackend(tasks);
  const logs: string[] = [];
  const changed = await refreshPrStates(
    {
      backend,
      github: { prStates: async () => lookup({ [url(1)]: 'merged', [url(2)]: 'closed' }, [url(3)]) },
      print: (line) => logs.push(line),
    },
    tasks,
  );
  assert.equal(changed, 2);
  assert.deepEqual(backend.writes, ['prStates c1 prompt=merged', 'prStates c2 prompt=closed']);
  assert.ok(logs.includes('PRSTATE c1 merged'));
  assert.ok(logs.includes(`WARN no state for ${url(3)}`));
});

test('refreshPrStates writes a task with several PRs once', async () => {
  const several = task({
    id: 's1',
    status: 'needs-me',
    input: 'fix it',
    prs: [row('r1', 1), row('r2', 2), row('r3', 3)],
  });
  const backend = fakeBackend([several]);
  const logs: string[] = [];
  const changed = await refreshPrStates(
    {
      backend,
      github: { prStates: async () => lookup({ [url(1)]: 'merged', [url(2)]: 'closed', [url(3)]: 'open' }) },
      print: (line) => logs.push(line),
    },
    [several],
  );
  assert.equal(changed, 1);
  assert.deepEqual(backend.writes, ['prStates s1 r1=merged r2=closed r3=open']);
  assert.ok(logs.includes('PRSTATE s1 merged closed open'));
  assert.deepEqual(
    several.prs.map(({ state }) => state),
    ['merged', 'closed', 'open'],
  );
});

test('a failed PR state query is logged and changes nothing', async () => {
  const tasks = [taskFor(1, 'needs-me')];
  const backend = fakeBackend(tasks);
  const logs: string[] = [];
  const changed = await refreshPrStates(
    {
      backend,
      github: {
        prStates: async () => {
          throw new GitHubError('gh api graphql failed: boom');
        },
      },
      print: (line) => logs.push(line),
    },
    tasks,
  );
  assert.equal(changed, 0);
  assert.deepEqual(backend.writes, []);
  assert.ok(logs.includes('WARN PR states not refreshed: gh api graphql failed: boom'));
});

test('a board server without PR states is told once', async () => {
  const tasks = [taskFor(1, 'needs-me'), taskFor(2, 'needs-me')];
  const backend = fakeBackend(tasks);
  backend.setPrStates = async () => {
    throw Object.assign(new BackendError('the board server does not support PR states yet'), {
      missingFeature: 'task.pr-state' as const,
    });
  };
  const logs: string[] = [];
  await refreshPrStates(
    {
      backend,
      github: { prStates: async () => lookup({ [url(1)]: 'merged', [url(2)]: 'merged' }) },
      print: (line) => logs.push(line),
    },
    tasks,
  );
  assert.equal(logs.filter((line) => line.startsWith('WARN PR states not written')).length, 1);
});

test('no task with a PR asks GitHub nothing', async () => {
  const backend = fakeBackend([]);
  let asked = false;
  const changed = await refreshPrStates(
    {
      backend,
      github: {
        prStates: async () => {
          asked = true;
          return NO_PR_STATES.prStates();
        },
      },
      print: () => undefined,
    },
    [task({ id: 'plain', status: 'needs-me', input: 'no pr' })],
  );
  assert.equal(changed, 0);
  assert.equal(asked, false);
});
