// The watch unit (`board internal watch`): one long-running process per machine that looks at every watch on its own timer,
// ends the ones whose time has come, and wakes a task whose event nobody is running to receive. Its state is on disk only
// (see store.mts), so a restart loses nothing but the attempts in flight. The dispatcher's tick takes the polling over when
// the heartbeat this unit touches goes stale (see tick.mts).
import { isProcessAlive } from '../worker/process.mts';
import { buildContext, print } from '../cli.mts';
import { errorText } from '../output/text.mts';
import { runCommand } from '../dispatch/waits.mts';
import type { Backend } from '@agent-board/shared';
import { attempt, deadlineReport, nextAttemptAt, UNIT_ATTEMPT_LIMIT_MS } from './attempt.mts';
import type { WatchRunner } from './attempt.mts';
import { finishWatch } from './finish.mts';
import { createWatchStore } from './store.mts';
import type { WatchDef, WatchStore } from './store.mts';
import { forgetWakeTries, isRunLive, tryWake } from './wake.mts';

export const SCAN_MS = 2000;

export interface UnitDeps {
  store: WatchStore;
  backend: Pick<Backend, 'addNote' | 'wake'>;
  run: WatchRunner;
  now: () => Date;
  isAlive: (pid: number) => boolean;
  log: (line: string) => void;
}

export interface WatchUnit {
  // One pass: touches the heartbeat and starts what is due. The attempts and board calls it starts run on, so a slow command or
  // a slow board does not hold the next pass back.
  scan: () => void;
  // Resolves when everything `scan` started has ended.
  settled: () => Promise<void>;
  // Kills the attempts in flight.
  stop: () => void;
}

export function createWatchUnit(deps: UnitDeps): WatchUnit {
  const { store, backend, now, isAlive, log } = deps;
  const flights = new Map<string, Promise<void>>();
  const abort = new AbortController();
  // Tasks whose worker was running at the last scan.
  const wasLive = new Set<string>();
  const reported = new Set<string>();

  const launch = (key: string, job: () => Promise<void>): void => {
    if (flights.has(key)) return;
    const flight = job()
      .catch((error: unknown) => log(`WARN ${key} failed: ${errorText(error)}`))
      .finally(() => flights.delete(key));
    flights.set(key, flight);
  };

  const wake = (task: string): Promise<void> =>
    tryWake({ store, backend, now, log, isAlive }, task).then(() => undefined);

  const finish = async (def: WatchDef, report: { kind: 'event' | 'timeout'; text: string }): Promise<void> => {
    if ((await finishWatch({ store, backend, now, log }, def, report)) !== undefined) await wake(def.task);
  };

  const look = async (def: WatchDef): Promise<void> => {
    const result = await attempt(def, now(), {
      run: deps.run,
      timeLimitMs: UNIT_ATTEMPT_LIMIT_MS,
      signal: abort.signal,
    });
    if (abort.signal.aborted) return;
    if (result.kind === 'event') return finish(def, { kind: 'event', text: result.text });
    const summary = result.kind === 'pending' ? result.summary : result.reason;
    store.update({
      ...(result.kind === 'pending' && result.def ? result.def : def),
      last: { at: now().toISOString(), summary },
    });
  };

  const scanTask = (task: string): void => {
    const { defs, unreadable } = store.list(task);
    for (const file of unreadable) {
      if (reported.has(`${task}/${file}`)) continue;
      reported.add(`${task}/${file}`);
      log(`WARN ${task}/${file} cannot be read and is skipped`);
    }
    const at = now().getTime();
    for (const def of defs) {
      const key = `${task}/${def.name}/${def.id}`;
      if (at >= Date.parse(def.deadline)) launch(key, () => finish(def, deadlineReport(def)));
      else if (def.source.kind !== 'timer' && at >= nextAttemptAt(def)) launch(key, () => look(def));
    }
    if (isRunLive(store, task, isAlive)) {
      wasLive.add(task);
      return;
    }
    // The worker went away with events pending: a wake tried while it ran did not count.
    if (wasLive.delete(task)) forgetWakeTries(store, task);
    if (store.events(task).some(({ event }) => event.wakeTriedAt === undefined))
      launch(`${task}/wake`, () => wake(task));
  };

  return {
    scan() {
      store.touchHeartbeat(now());
      for (const task of store.tasks()) scanTask(task);
    },
    async settled() {
      while (flights.size > 0) await Promise.all([...flights.values()]);
    },
    stop() {
      abort.abort();
    },
  };
}

// Waits `ms`, or until `signal` aborts.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Scans every `scanMs` until `signal` aborts, then kills the attempts in flight and waits for them. */
export async function runWatchUnit(
  deps: UnitDeps,
  signal: AbortSignal,
  {
    scanMs = SCAN_MS,
    wait = sleep,
  }: { scanMs?: number; wait?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
): Promise<void> {
  const unit = createWatchUnit(deps);
  deps.log('watch unit started');
  while (!signal.aborted) {
    try {
      unit.scan();
    } catch (error) {
      deps.log(`WARN scan failed: ${errorText(error)}`);
    }
    await wait(scanMs, signal);
  }
  unit.stop();
  await unit.settled();
  deps.log('watch unit stopped');
}

export async function watchUnitMain(): Promise<void> {
  const { backend } = buildContext(false);
  const stop = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT'] as const) process.once(name, () => stop.abort());
  await runWatchUnit(
    {
      store: createWatchStore(),
      backend,
      run: (job) => runCommand(job),
      now: () => new Date(),
      isAlive: isProcessAlive,
      log: print,
    },
    stop.signal,
  );
}
