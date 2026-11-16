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
  assert.deepEqual(
    backend.writes.map((write) => write.split(':')[0]),
    ['prState c1 merged', 'prState c2 closed'],
  );
  assert.ok(logs.includes(`WARN no state for ${url(3)}`));
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
  backend.setPrState = async () => {
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
