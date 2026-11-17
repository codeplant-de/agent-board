import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskWatch } from '@agent-board/shared';
import { commandDef, tempDir, timerDef } from '../__tests__/helpers/watch.mts';
import { handleWatchStops } from './stops.mts';
import { createWatchStore } from './store.mts';

const TASK = 'Ab3dEf9x';
const FIRST = '1111111111111111';
const SECOND = '2222222222222222';

function setup() {
  const store = createWatchStore(join(tempDir(), 'watches'));
  const calls: string[] = [];
  const logs: string[] = [];
  const state = { failAck: false };
  const deps = {
    store,
    backend: {
      async addNote(_id: string, text: string) {
        calls.push(`note ${text.split('\n')[0]}`);
      },
      async setWatches(_id: string, watches: readonly TaskWatch[] | null) {
        calls.push(`publish ${watches === null ? 'none' : watches.map(({ name }) => name).join(',')}`);
      },
      async ackWatchStops(_id: string, ids: readonly string[]) {
        if (state.failAck) throw new Error('board down');
        calls.push(`ack ${ids.join(',')}`);
      },
    },
    now: () => new Date('2026-01-01T12:00:00Z'),
    log: (line: string) => logs.push(line),
  };
  return { store, calls, logs, state, deps };
}

test('a stop claims the matching watch, spools a stopped event, posts the note, acknowledges and publishes what is left', async () => {
  const { store, deps, calls, logs } = setup();
  store.write(commandDef('probe', { id: FIRST }));
  store.write(timerDef({ id: SECOND }));
  await handleWatchStops(deps, { id: TASK, watchStops: [FIRST] });
  assert.deepEqual(
    store.list(TASK).defs.map((def) => def.name),
    ['timer'],
  );
  const [stored] = store.events(TASK);
  assert.equal(stored?.event.kind, 'stopped');
  assert.equal(stored?.event.text, 'Watch "health" was stopped by the user.');
  assert.deepEqual(calls, ['note agent-board: watch "health" reported.', `ack ${FIRST}`, 'publish timer']);
  assert.ok(logs.includes(`STOP-WATCH ${TASK} health`));
});

test('an unknown or already finished id is acknowledged, writes no event and cannot come back', async () => {
  const { store, deps, calls, logs } = setup();
  store.write(timerDef({ id: SECOND }));
  await handleWatchStops(deps, { id: TASK, watchStops: [FIRST] });
  assert.deepEqual(store.events(TASK), []);
  assert.equal(store.list(TASK).defs.length, 1);
  assert.deepEqual(calls, [`ack ${FIRST}`, 'publish timer']);
  assert.ok(logs.includes(`STOP-WATCH ${TASK} ${FIRST} no such watch`));
});

test('a stop whose acknowledgement failed is retried without a second event', async () => {
  const { store, deps, state, logs, calls } = setup();
  store.write(commandDef('probe', { id: FIRST }));
  state.failAck = true;
  await handleWatchStops(deps, { id: TASK, watchStops: [FIRST] });
  assert.match(logs.at(-1) ?? '', /^WARN stopping watches of Ab3dEf9x failed: board down/);
  state.failAck = false;
  await handleWatchStops(deps, { id: TASK, watchStops: [FIRST] });
  assert.equal(store.events(TASK).length, 1);
  assert.deepEqual(calls.slice(-2), [`ack ${FIRST}`, 'publish none']);
});

test('without stops nothing is called', async () => {
  const { deps, calls } = setup();
  await handleWatchStops(deps, { id: TASK, watchStops: [] });
  assert.deepEqual(calls, []);
});
