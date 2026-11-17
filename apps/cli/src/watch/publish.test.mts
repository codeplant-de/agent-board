import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskWatch } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { commandDef, PR, streamDef, tempDir, timerDef, watchDef, mergedDef } from '../__tests__/helpers/watch.mts';
import { isBoardStale, publishWatches, taskWatchesOf } from './publish.mts';
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
  store.write(streamDef(SECRET, { id: '7777777777777777', name: 'new-stream' }));
  store.write(
    streamDef(SECRET, {
      id: '5555555555555555',
      source: { kind: 'stream', command: SECRET, cwd: '/work', starts: 1, events: 3 },
      last: { at: '2026-01-01T11:57:00.000Z', summary: 'streaming' },
    }),
  );
  store.write(
    streamDef(SECRET, {
      id: '6666666666666666',
      name: 'one',
      source: { kind: 'stream', command: SECRET, cwd: '/work', starts: 2, events: 1 },
    }),
  );
  store.write(
    watchDef({
      id: '4444444444444444',
      name: 'review',
      source: { kind: 'pr-review', pr: PR, self: 'board-machine', seen: ['IC_1'], cwd: '/work' },
      everyMs: 60_000,
      last: { at: '2026-01-01T11:59:30.000Z', summary: 'no new review or comment by someone else, 1 seen' },
    }),
  );
  store.writeEvent({
    id: newWatchId(),
    task: TASK,
    name: 'health',
    at: NOW.toISOString(),
    kind: 'event',
    text: 'SECRET-OUTPUT',
  });
  store.write(mergedDef({ id: '4444444444444444', last: { at: '2026-01-01T11:59:30.000Z', summary: 'still open' } }));
  store.write(mergedDef({ id: '5555555555555555', name: 'landed' }));
  const watches = taskWatchesOf(store, TASK, NOW);
  const by = Object.fromEntries(watches.map((watch) => [watch.name, watch]));
  assert.equal(by['ci']?.label, 'CI #7 · required');
  assert.equal(by['ci']?.status, '4 of 7 passed, 3 running');
  assert.equal(by['ci']?.lastAttemptAt, '2026-01-01T11:59:00.000Z');
  assert.deepEqual(by['pr-merged'], {
    id: '4444444444444444',
    name: 'pr-merged',
    kind: 'pr-merged',
    label: 'merge of #7',
    status: 'still open',
    deadline: '2026-01-01T14:00:00.000Z',
    lastAttemptAt: '2026-01-01T11:59:30.000Z',
  });
  assert.equal(by['landed']?.status, 'not looked at yet');
  assert.equal(by['health']?.kind, 'command');
  assert.equal(by['health']?.label, 'command, every 30s');
  assert.match(by['health']?.status ?? '', /^exit 1 at \d\d:\d\d$/);
  assert.equal(by['fresh']?.status, 'not run yet');
  assert.equal(by['fresh']?.label, 'command, every 1m');
  assert.equal(by['review']?.kind, 'pr-review');
  assert.equal(by['review']?.label, 'review #7');
  assert.equal(by['review']?.status, 'no new review or comment by someone else, 1 seen');
  assert.equal(by['review']?.lastAttemptAt, '2026-01-01T11:59:30.000Z');
  assert.equal(by['timer']?.label, 'timer');
  assert.match(by['timer']?.status ?? '', /^fires at /);
  assert.equal(by['timer']?.lastAttemptAt, undefined);
  assert.equal(by['timer']?.deadline, '2026-01-01T14:20:00.000Z');
  assert.equal(by['new-stream']?.kind, 'stream');
  assert.equal(by['new-stream']?.label, 'stream');
  assert.equal(by['new-stream']?.status, 'starting');
  assert.equal(by['log']?.status, 'streaming, 3 events');
  assert.equal(by['log']?.lastAttemptAt, '2026-01-01T11:57:00.000Z');
  assert.equal(by['one']?.status, 'streaming, 1 event');
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

test('the board is stale when it shows watches the store does not hold, other watches, none, or another count of events', () => {
  const { store } = setup();
  const board = (watches: TaskWatch[] | null, watchEvents = 0, unreadable: ('watches' | 'title')[] = []) =>
    isBoardStale(store, { id: TASK, watches, watchEvents, unreadable }, NOW);
  assert.equal(board(null), false);
  assert.equal(board(null, 0, ['title']), false);
  assert.equal(board(null, 0, ['watches']), true);
  const gone = taskWatchesOf(
    (() => {
      const other = createWatchStore(join(tempDir(), 'watches'));
      other.write(timerDef());
      return other;
    })(),
    TASK,
    NOW,
  );
  assert.equal(board(gone), true);
  assert.equal(board([]), true);

  store.write(commandDef('true', { last: { at: '2026-01-01T11:58:00.000Z', summary: 'exit 1: no' } }));
  const shown = taskWatchesOf(store, TASK, NOW);
  assert.equal(board(shown), false);
  assert.equal(board(null), true);
  assert.equal(board([...shown, ...gone.map((watch) => ({ ...watch, id: '1111111111111111' }))]), true);
  assert.equal(board(shown.map((watch) => ({ ...watch, id: '1111111111111111' }))), true);
  assert.equal(board(shown.map((watch) => ({ ...watch, deadline: '2026-01-01T15:00:00.000Z' }))), true);
  // What the last look said changes all the time and is the unit's to publish.
  assert.equal(
    board(shown.map((watch) => ({ ...watch, status: 'exit 2 at 11:00', lastAttemptAt: NOW.toISOString() }))),
    false,
  );
  store.writeEvent({ id: newWatchId(), task: TASK, name: 'ci', at: NOW.toISOString(), kind: 'event', text: 'x' });
  assert.equal(board(shown), true);
  assert.equal(board(shown, 1), false);
});

test('a timer close to its end is published to the second', () => {
  const { store } = setup();
  store.write(timerDef({ deadline: '2026-01-01T12:01:40.000Z' }));
  assert.match(taskWatchesOf(store, TASK, NOW)[0]?.status ?? '', /^fires at \d\d:\d\d:40$/);
});
