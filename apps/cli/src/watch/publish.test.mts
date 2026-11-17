import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskWatch } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { commandDef, PR, tempDir, timerDef, watchDef } from '../__tests__/helpers/watch.mts';
import { publishWatches, taskWatchesOf } from './publish.mts';
import { createWatchStore, newWatchId } from './store.mts';

const TASK = 'Ab3dEf9x';
const NOW = new Date('2026-01-01T12:00:00Z');
const SECRET = 'curl -H "Authorization: SECRET-TOKEN" https://internal.example/health';

function setup() {
  const store = createWatchStore(join(tempDir(), 'watches'));
  const sent: (TaskWatch[] | null)[] = [];
  const counts: number[] = [];
  const logs: string[] = [];
  const state = { failure: undefined as Error | undefined };
  const deps = {
    store,
    backend: {
      async setWatches(_id: string, watches: readonly TaskWatch[] | null, pendingEvents: number) {
        if (state.failure) throw state.failure;
        sent.push(watches === null ? null : [...watches]);
        counts.push(pendingEvents);
      },
    },
    now: () => NOW,
    log: (line: string) => logs.push(line),
  };
  return { store, sent, counts, logs, state, deps };
}

test('the list holds a label and a state per kind, the deadline, and never the command or what it printed', () => {
  const { store } = setup();
  store.write(
    watchDef({
      source: { kind: 'ci', pr: PR, required: true, cwd: '/work' },
      last: { at: '2026-01-01T11:59:00.000Z', summary: '4 of 7 passed, 3 running' },
    }),
  );
  store.write(
    commandDef(SECRET, {
      id: '1111111111111111',
      everyMs: 30_000,
      last: { at: '2026-01-01T11:58:00.000Z', summary: 'exit 1: SECRET-OUTPUT line' },
    }),
  );
  store.write(commandDef(SECRET, { id: '2222222222222222', name: 'fresh', everyMs: 60_000 }));
  store.write(timerDef({ id: '3333333333333333', deadline: '2026-01-01T14:20:00.000Z' }));
  store.writeEvent({
    id: newWatchId(),
    task: TASK,
    name: 'health',
    at: NOW.toISOString(),
    kind: 'event',
    text: 'SECRET-OUTPUT',
  });
  const watches = taskWatchesOf(store, TASK, NOW);
  const by = Object.fromEntries(watches.map((watch) => [watch.name, watch]));
  assert.equal(by['ci']?.label, 'CI #7 · required');
  assert.equal(by['ci']?.status, '4 of 7 passed, 3 running');
  assert.equal(by['ci']?.lastAttemptAt, '2026-01-01T11:59:00.000Z');
  assert.equal(by['health']?.kind, 'command');
  assert.equal(by['health']?.label, 'command, every 30s');
  assert.match(by['health']?.status ?? '', /^exit 1 at \d\d:\d\d$/);
  assert.equal(by['fresh']?.status, 'not run yet');
  assert.equal(by['fresh']?.label, 'command, every 1m');
  assert.equal(by['timer']?.label, 'timer');
  assert.match(by['timer']?.status ?? '', /^fires at /);
  assert.equal(by['timer']?.lastAttemptAt, undefined);
  assert.equal(by['timer']?.deadline, '2026-01-01T14:20:00.000Z');
  const json = JSON.stringify(watches);
  for (const secret of ['SECRET', 'curl', 'internal.example']) assert.equal(json.includes(secret), false, secret);
});

test('publishing sends the list with the count of the task’s undelivered events, and an empty list as null', async () => {
  const { store, deps, sent, counts } = setup();
  store.write(watchDef());
  store.writeEvent({ id: newWatchId(), task: TASK, name: 'gone', at: NOW.toISOString(), kind: 'event', text: 'x' });
  store.writeEvent({ id: newWatchId(), task: TASK, name: 'other', at: NOW.toISOString(), kind: 'event', text: 'y' });
  await publishWatches(deps, TASK);
  store.claim(TASK, 'ci')?.done();
  await publishWatches(deps, TASK);
  assert.equal(sent[0]?.[0]?.name, 'ci');
  assert.equal(sent[1], null);
  assert.deepEqual(counts, [2, 2]);
});

test('a board without task.watches is skipped with one line, and any other failure is logged and does not throw', async () => {
  const { store, deps, state, logs, sent } = setup();
  store.write(watchDef());
  const missing = new BackendError('the board server does not support showing a task’s watches yet');
  missing.missingFeature = 'task.watches';
  state.failure = missing;
  await publishWatches(deps, TASK);
  await publishWatches(deps, TASK);
  assert.equal(logs.length, 1);
  state.failure = new BackendError('board down', 503);
  await publishWatches(deps, TASK);
  assert.match(logs[1] ?? '', /^WARN publishing the watches of Ab3dEf9x failed: board down/);
  assert.deepEqual(sent, []);
});
