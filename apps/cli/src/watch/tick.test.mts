import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeRunner, streamDef, tempDir } from '../__tests__/helpers/watch.mts';
import { createWatchStore } from './store.mts';
import { nextWatchDue, pollWatches } from './tick.mts';
import type { TickWatchDeps } from './tick.mts';

function setup(now: string) {
  const store = createWatchStore(tempDir());
  const run = fakeRunner();
  const notes: string[] = [];
  const deps: TickWatchDeps = {
    store,
    backend: {
      async addNote(_id, text) {
        notes.push(text);
      },
    },
    run,
    now: () => new Date(now),
    log: () => undefined,
  };
  return { store, run, notes, deps };
}

test('the tick never runs the command of a stream: it has only its deadline to look at', async () => {
  const { store, run, deps } = setup('2026-01-01T13:00:00Z');
  const def = streamDef('tail -f log');
  store.write(def);
  assert.deepEqual(nextWatchDue([def]), [new Date(def.deadline)]);
  assert.deepEqual(await pollWatches(deps, [def], { timeLeftMs: 100_000 }), []);
  assert.deepEqual(run.calls, []);
  assert.deepEqual(store.read(def.task, def.name), def);
});

test('a stream whose deadline passed times out, with how far it got', async () => {
  const { store, deps, notes } = setup('2026-01-01T14:00:01Z');
  const running = streamDef('tail -f log', {
    source: { kind: 'stream', command: 'tail -f log', cwd: '/work', starts: 1, events: 4 },
  });
  const idle = streamDef('tail -f other', { id: 'b1b2c3d4e5f60718', name: 'idle' });
  store.write(running);
  store.write(idle);
  assert.deepEqual(await pollWatches(deps, [running, idle], { timeLeftMs: 100_000 }), [running.task]);
  const texts = store.events(running.task).map(({ event }) => `${event.kind}: ${event.text}`);
  assert.equal(texts.length, 2);
  assert.ok(
    texts.some((text) =>
      /^timeout: Watch "log" timed out after 2h .+ Its command was stopped after 4 events\.$/.test(text),
    ),
  );
  assert.ok(texts.some((text) => /^timeout: Watch "idle" timed out .+ Its command never started\.$/.test(text)));
  assert.equal(notes.length, 2);
  assert.deepEqual(store.list(running.task).defs, []);
});
