import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Task, TaskWatch } from '@agent-board/shared';
import { commandDef, commandResult, tempDir, timerDef, watchDef } from '../__tests__/helpers/watch.mts';
import { task as makeTask } from '../__tests__/helpers/fakes.mts';
import { WAKE_MARKER, WATCH_MARKER } from '../task-rules.mts';
import type { RunJob } from './attempt.mts';
import { createWatchStore } from './store.mts';
import { createWatchUnit, runWatchUnit } from './unit.mts';
import type { UnitDeps } from './unit.mts';

const TASK = 'Ab3dEf9x';
const START = Date.parse('2026-01-01T12:00:00Z');

function setup({ wakeApplies = true }: { wakeApplies?: boolean } = {}) {
  const dir = join(tempDir(), 'watches');
  const store = createWatchStore(dir);
  const clock = { ms: START };
  const calls: string[] = [];
  const logs: string[] = [];
  const published: (TaskWatch[] | null)[] = [];
  const alive = new Set<number>();
  const answers = new Map<string, (job: RunJob) => ReturnType<typeof commandResult>>();
  const state = { wakeApplies, failWake: false, failNote: false };
  const deps: UnitDeps = {
    store,
    backend: {
      async addNote(id, text) {
        if (state.failNote) throw new Error('board down');
        calls.push(`note ${id}: ${text}`);
      },
      async wake(id, text) {
        if (state.failWake) throw new Error('board down');
        calls.push(`wake ${id}: ${text}`);
        return { applied: state.wakeApplies, task: makeTask({ id }) as Task };
      },
      async setWatches(_id, watches) {
        published.push(watches === null ? null : [...watches]);
      },
    },
    run: async (job) => (answers.get(job.command) ?? (() => commandResult(1, 'down')))(job),
    now: () => new Date(clock.ms),
    isAlive: (pid) => alive.has(pid),
    log: (line) => logs.push(line),
  };
  const unit = createWatchUnit(deps);
  const pass = async (): Promise<void> => {
    unit.scan();
    await unit.settled();
  };
  const advance = (ms: number): void => {
    clock.ms += ms;
  };
  return { dir, store, unit, deps, calls, logs, published, alive, answers, state, pass, advance };
}

const wakes = (calls: string[]): string[] => calls.filter((call) => call.startsWith('wake'));

test('a pass touches the heartbeat and attempts a watch only when it is due, one period after registration', async () => {
  const { store, pass, advance, answers, logs } = setup();
  store.write(commandDef('probe', { everyMs: 30_000 }));
  let runs = 0;
  answers.set('probe', () => {
    runs += 1;
    return commandResult(1, `try ${runs}`);
  });
  await pass();
  assert.equal(store.heartbeatAt()?.getTime(), START);
  assert.equal(runs, 0);
  advance(30_000);
  await pass();
  assert.equal(runs, 1);
  assert.equal(store.read(TASK, 'health')?.last?.summary, 'exit 1: try 1');
  advance(2000);
  await pass();
  assert.equal(runs, 1);
  advance(28_000);
  await pass();
  assert.equal(runs, 2);
  assert.deepEqual(logs, []);
});

test('an event claims the watch, spools the event, posts the thread note, logs the timing lines and wakes the task', async () => {
  const { store, pass, advance, answers, calls, logs } = setup();
  store.write(commandDef('probe', { everyMs: 30_000 }));
  answers.set('probe', () => commandResult(0, 'all good\n'));
  advance(30_000);
  await pass();
  assert.deepEqual(store.list(TASK).defs, []);
  const [stored] = store.events(TASK);
  assert.equal(stored?.event.text, 'Exit 0. End of its output:\nall good');
  assert.equal(stored?.event.kind, 'event');
  assert.equal(
    calls[0],
    `note ${TASK}: ${WATCH_MARKER} "health" reported.\n\n\`\`\`\nExit 0. End of its output:\nall good\n\`\`\``,
  );
  assert.equal(calls[1], `wake ${TASK}: ${WAKE_MARKER} watch "health" reported.`);
  assert.deepEqual(logs, [
    `EVENT ${TASK} health event at=${new Date(START + 30_000).toISOString()}`,
    `WAKE ${TASK} applied=true event-age=0`,
  ]);
});

test('a deadline that passed ends the watch with a timeout event, and a timer ends with its own event', async () => {
  const { store, pass, advance, calls } = setup();
  store.write(commandDef('probe', { deadline: new Date(START + 60_000).toISOString(), everyMs: 600_000 }));
  store.write(timerDef({ deadline: new Date(START + 30_000).toISOString() }));
  advance(31_000);
  await pass();
  assert.deepEqual(
    store.events(TASK).map(({ event }) => [event.name, event.kind]),
    [['timer', 'event']],
  );
  advance(30_000);
  await pass();
  assert.deepEqual(
    store.events(TASK).map(({ event }) => [event.name, event.kind]),
    [
      ['timer', 'event'],
      ['health', 'timeout'],
    ],
  );
  assert.equal(calls.filter((call) => call.startsWith('note')).length, 2);
});

test('an event and a finished watch are published at once, with the event waiting', async () => {
  const { store, pass, advance, answers, published } = setup();
  store.write(commandDef('probe', { everyMs: 30_000 }));
  store.write(timerDef({ deadline: new Date(START + 3_600_000).toISOString() }));
  answers.set('probe', () => commandResult(0, 'secret output'));
  advance(30_000);
  await pass();
  assert.equal(published.length, 1);
  const [list] = published;
  assert.deepEqual(
    list?.map(({ name, kind, label, pendingEvents }) => [name, kind, label, pendingEvents]),
    [['timer', 'timer', 'timer', 0]],
  );
  assert.equal(JSON.stringify(list).includes('probe'), false);
  assert.equal(JSON.stringify(list).includes('secret output'), false);
});

test('a changed state is published at most every 15 seconds per task', async () => {
  const { store, pass, advance, answers, published } = setup();
  store.write(commandDef('probe', { everyMs: 5_000 }));
  let runs = 0;
  answers.set('probe', () => {
    runs += 1;
    return commandResult(1, `try ${runs}`);
  });
  advance(5_000);
  await pass();
  assert.equal(published.length, 1);
  assert.match(published[0]?.[0]?.status ?? '', /^exit 1 at \d\d:\d\d$/);
  for (const _ of [1, 2]) {
    advance(5_000);
    await pass();
  }
  assert.equal(published.length, 1);
  advance(5_000);
  await pass();
  assert.equal(published.length, 2);
});

test('an unchanged state is not published again', async () => {
  const { store, pass, advance, answers, published } = setup();
  store.write(commandDef('probe', { everyMs: 15_000 }));
  answers.set('probe', () => commandResult(1, 'same'));
  for (let pass_ = 0; pass_ < 4; pass_ += 1) {
    advance(15_000);
    await pass();
  }
  assert.equal(published.length, 1);
});

test('a task with a live run is not woken: its worker hands the event over', async () => {
  const { store, pass, advance, answers, alive, calls } = setup();
  store.markLive(TASK, 4242);
  alive.add(4242);
  store.write(commandDef('probe'));
  answers.set('probe', () => commandResult(0, 'ok'));
  advance(60_000);
  await pass();
  assert.equal(store.events(TASK).length, 1);
  assert.deepEqual(wakes(calls), []);
  // Scans go on without asking the board anything while the run lives.
  await pass();
  assert.deepEqual(wakes(calls), []);
  assert.equal(store.events(TASK)[0]?.event.wakeTriedAt, undefined);
});

test('a live marker whose process is gone does not count as a live run', async () => {
  const { store, pass, advance, answers, calls } = setup();
  store.markLive(TASK, 4242);
  store.write(commandDef('probe'));
  answers.set('probe', () => commandResult(0, 'ok'));
  advance(60_000);
  await pass();
  assert.equal(wakes(calls).length, 1);
});

test('when the live run goes away with events pending, a wake is tried once; then no scan asks again', async () => {
  const { store, pass, advance, answers, alive, calls, state } = setup({ wakeApplies: false });
  store.markLive(TASK, 4242);
  alive.add(4242);
  store.write(commandDef('probe'));
  answers.set('probe', () => commandResult(0, 'ok'));
  advance(60_000);
  await pass();
  assert.deepEqual(wakes(calls), []);
  alive.delete(4242);
  await pass();
  assert.equal(wakes(calls).length, 1);
  for (let scan = 0; scan < 5; scan += 1) {
    advance(2000);
    await pass();
  }
  assert.equal(wakes(calls).length, 1);
  // A run that comes and goes again gets the event one more wake attempt.
  alive.add(4242);
  await pass();
  alive.delete(4242);
  state.wakeApplies = true;
  await pass();
  assert.equal(wakes(calls).length, 2);
});

test('a wake the board did not apply keeps the event in the spool and is not repeated', async () => {
  const { store, pass, advance, answers, calls, logs } = setup({ wakeApplies: false });
  store.write(commandDef('probe'));
  answers.set('probe', () => commandResult(0, 'ok'));
  advance(60_000);
  await pass();
  for (let scan = 0; scan < 4; scan += 1) {
    advance(2000);
    await pass();
  }
  assert.equal(wakes(calls).length, 1);
  assert.equal(store.events(TASK).length, 1);
  assert.ok(store.events(TASK)[0]?.event.wakeTriedAt);
  assert.ok(logs.includes(`WAKE ${TASK} applied=false event-age=0`));
});

test('a board that fails never stops the unit: the event is in the spool, the failures are logged, nothing is retried', async () => {
  const { store, pass, advance, answers, calls, logs, state } = setup();
  state.failNote = true;
  state.failWake = true;
  store.write(commandDef('probe'));
  store.write(
    watchDef({ name: 'other', source: { kind: 'command', command: 'other', cwd: '/work' }, everyMs: 30_000 }),
  );
  answers.set('probe', () => commandResult(0, 'ok'));
  advance(60_000);
  await pass();
  advance(2000);
  await pass();
  assert.equal(store.events(TASK).length, 1);
  assert.equal(calls.length, 0);
  assert.equal(logs.filter((line) => line.startsWith('WARN')).length, 2);
  // The other watch was attempted all the same.
  assert.match(store.read(TASK, 'other')?.last?.summary ?? '', /^exit 1/);
});

test('a watch that was removed or replaced while its attempt ran produces no event and no write', async () => {
  const { store, advance, deps } = setup();
  store.write(commandDef('probe', { everyMs: 30_000 }));
  advance(30_000);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const unit = createWatchUnit({
    ...deps,
    run: async () => {
      await gate;
      return commandResult(0, 'ok');
    },
  });
  unit.scan();
  store.claim(TASK, 'health')?.done();
  release();
  await unit.settled();
  assert.deepEqual(store.events(TASK), []);
  assert.deepEqual(store.list(TASK).defs, []);
});

test('an attempt is not started twice while one is in flight', async () => {
  const { store, advance, deps } = setup();
  store.write(commandDef('probe', { everyMs: 30_000 }));
  advance(30_000);
  let runs = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const unit = createWatchUnit({
    ...deps,
    run: async () => {
      runs += 1;
      await gate;
      return commandResult(1, 'no');
    },
  });
  unit.scan();
  advance(5000);
  unit.scan();
  unit.scan();
  release();
  await unit.settled();
  assert.equal(runs, 1);
});

test('an unreadable watch file is logged once and skipped', async () => {
  const { dir, store, pass, logs } = setup();
  store.write(commandDef('probe'));
  mkdirSync(join(dir, TASK), { recursive: true });
  writeFileSync(join(dir, TASK, 'watch-broken.json'), '{"half');
  await pass();
  await pass();
  await pass();
  assert.deepEqual(logs, ['WARN Ab3dEf9x/watch-broken.json cannot be read and is skipped']);
});

test('a stopped unit kills what is in flight and writes nothing for it', async () => {
  const { store, deps, advance, logs } = setup();
  store.write(commandDef('probe', { everyMs: 30_000 }));
  advance(30_000);
  let aborted = false;
  const unit = createWatchUnit({
    ...deps,
    run: (job) =>
      new Promise((resolve) => {
        job.signal?.addEventListener('abort', () => {
          aborted = true;
          resolve(commandResult(null));
        });
      }),
  });
  unit.scan();
  unit.stop();
  await unit.settled();
  assert.equal(aborted, true);
  assert.equal(store.read(TASK, 'health')?.last, undefined);
  assert.deepEqual(logs, []);
});

test('the main loop scans every period and stops on its signal, waiting for what is in flight', async () => {
  const { deps, store, logs } = setup();
  store.write(commandDef('probe', { everyMs: 15_000 }));
  const stop = new AbortController();
  let scans = 0;
  await runWatchUnit(deps, stop.signal, {
    scanMs: 2000,
    wait: async (ms) => {
      assert.equal(ms, 2000);
      scans += 1;
      if (scans === 3) stop.abort();
    },
  });
  assert.equal(scans, 3);
  assert.deepEqual(logs, ['watch unit started', 'watch unit stopped']);
});
