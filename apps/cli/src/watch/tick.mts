// What the dispatcher's tick does for watches. The watch unit normally polls and finishes them; the tick takes the polling over
// when the unit's heartbeat is stale (the unit is not installed or not running), finishes the deadlines of a task it is about
// to wake, and drops the watches of tasks that are over. Both go through the same engine and the same claim, so a watch is never
// finished twice.
import type { Backend } from '@agent-board/shared';
import { attempt, deadlineReport, nextAttemptAt, TICK_ATTEMPT_LIMIT_MS } from './attempt.mts';
import type { WatchRunner } from './attempt.mts';
import { finishWatch } from './finish.mts';
import type { WatchDef, WatchEvent, WatchStore } from './store.mts';

// The unit touches the heartbeat every 2 s; this is long enough for a busy machine and short enough for a tick every 2 minutes.
export const HEARTBEAT_STALE_MS = 30_000;
// A little early is on time: ticks come every two minutes, give or take, and a watch every 30 s is due on every one of them.
const DUE_SLACK_MS = 20_000;

export interface TickWatchDeps {
  store: WatchStore;
  backend: Pick<Backend, 'addNote'>;
  run: WatchRunner;
  now: () => Date;
  log: (line: string) => void;
  // Print what would be done and change nothing.
  dryRun?: boolean;
}

/** Whether the watch unit is running: it touched its heartbeat in the last 30 seconds. */
export function isUnitRunning(store: WatchStore, now: Date): boolean {
  const beat = store.heartbeatAt();
  return beat !== undefined && now.getTime() - beat.getTime() <= HEARTBEAT_STALE_MS;
}

/**
 * Whether the tick has to poll: watches exist and no unit looks after them. Undefined (and the tick stays quiet) when the unit
 * runs or nothing is watched.
 */
export function watchesToPoll(store: WatchStore, now: Date): WatchDef[] | undefined {
  const defs = store.all();
  return defs.length > 0 && !isUnitRunning(store, now) ? defs : undefined;
}

export const UNIT_MISSING_WARNING =
  'WARN watches on this machine are polled by the dispatch tick: the watch unit is not running; run "board setup --enable"';

/**
 * Ends the watches of `task` whose deadline has passed: a timer reports its end, any other watch its timeout. No command runs.
 * Returns the events written.
 */
export async function finishDeadlines(deps: TickWatchDeps, task: string, defs?: WatchDef[]): Promise<WatchEvent[]> {
  const at = deps.now().getTime();
  const events: WatchEvent[] = [];
  for (const def of defs ?? deps.store.list(task).defs) {
    if (at < Date.parse(def.deadline)) continue;
    const report = deadlineReport(def);
    if (deps.dryRun === true) {
      deps.log(`DRY finish watch ${def.name} of ${task}: ${report.kind}`);
      continue;
    }
    const event = await finishWatch(deps, def, report);
    if (event !== undefined) events.push(event);
  }
  return events;
}

/**
 * Polls the watches that are due, side by side, each with the tick's attempt limit, and finishes the ones whose deadline passed.
 * Returns the tasks that got an event. A watch whose attempt would not finish before the tick's limit waits for the next tick.
 */
export async function pollWatches(
  deps: TickWatchDeps,
  defs: WatchDef[],
  { timeLeftMs }: { timeLeftMs: number },
): Promise<string[]> {
  const woken = new Set<string>();
  for (const def of defs) {
    if ((await finishDeadlines(deps, def.task, [def])).length > 0) woken.add(def.task);
  }
  const at = deps.now().getTime();
  const due = defs.filter(
    (def) => def.source.kind !== 'timer' && at < Date.parse(def.deadline) && at + DUE_SLACK_MS >= nextAttemptAt(def),
  );
  if (due.length === 0) return [...woken];
  if (timeLeftMs < TICK_ATTEMPT_LIMIT_MS) {
    deps.log(`DEFER-WATCHES ${due.length}: the tick has ${Math.max(0, Math.round(timeLeftMs / 1000))} s left`);
    return [...woken];
  }
  await Promise.all(
    due.map(async (def) => {
      if (deps.dryRun === true) {
        deps.log(`DRY watch ${def.name} of ${def.task}`);
        return;
      }
      const result = await attempt(def, deps.now(), { run: deps.run, timeLimitMs: TICK_ATTEMPT_LIMIT_MS });
      if (result.kind === 'event') {
        if ((await finishWatch(deps, def, { kind: 'event', text: result.text })) !== undefined) woken.add(def.task);
        return;
      }
      const summary = result.kind === 'pending' ? result.summary : result.reason;
      deps.log(`WATCH ${def.task} ${def.name} ${summary.split('\n')[0]?.slice(0, 120) ?? ''}`);
      deps.store.update({
        ...(result.kind === 'pending' && result.def ? result.def : def),
        last: { at: deps.now().toISOString(), summary },
      });
    }),
  );
  return [...woken];
}

/** When the tick next has a watch to look at: an attempt coming due, or a deadline. Only the tick that polls needs it. */
export function nextWatchDue(defs: WatchDef[]): Date[] {
  return defs.flatMap((def) => {
    const deadline = new Date(def.deadline);
    return def.source.kind === 'timer'
      ? [deadline]
      : [deadline, new Date(Math.min(nextAttemptAt(def), deadline.getTime()))];
  });
}

/** The name of the oldest event of the task that no worker has been handed yet, or undefined. */
export function undeliveredEvent(store: WatchStore, task: string): string | undefined {
  return store.events(task)[0]?.event.name;
}

export type DropReason = 'done' | 'closed' | 'in Backlog' | 'gone';

/** Why a task's watches are dropped, or undefined when they stay: a task that is Running, Waiting, Todo or in Needs me keeps them. */
export function dropReason(task: { status: string; closed: boolean } | undefined): DropReason | undefined {
  if (task === undefined) return 'gone';
  if (task.closed) return 'closed';
  if (task.status === 'done') return 'done';
  return task.status === 'backlog' ? 'in Backlog' : undefined;
}
