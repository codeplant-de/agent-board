// An event that arrives for a task nobody is running ends the task's wait. While the task has a live worker the worker hands the
// event to the agent itself.
import type { Backend } from '@agent-board/shared';
import { errorText } from '../output/text.mts';
import { WAKE_MARKER } from '../task-rules.mts';
import type { WatchStore } from './store.mts';

export interface WakeDeps {
  store: WatchStore;
  backend: Pick<Backend, 'wake'>;
  now: () => Date;
  log: (line: string) => void;
  isAlive: (pid: number) => boolean;
}

/** Whether a worker runs the task now: its `live` marker names a process that exists. */
export function isRunLive(store: WatchStore, task: string, isAlive: (pid: number) => boolean): boolean {
  const pid = store.livePid(task);
  return pid !== undefined && isAlive(pid);
}

// The first paragraph of the wake note; the name was shape-checked when the event was read.
export const wakeReason = (name: string): string => `watch "${name}" reported.`;

export type WakeOutcome =
  // No event waits for a wake attempt.
  | 'none'
  // A worker runs: it delivers the events itself.
  | 'live'
  | 'woken'
  // The board did not wake the task (it does not wait); the events stay for its next resume.
  | 'kept'
  | 'failed';

/**
 * Wakes the task for the events no wake was tried for yet, once: the events are marked `wakeTriedAt` first, so the next scan does not
 * ask again, and an event that fires between a worker's decision to park and its exit is not tried until the worker is gone.
 */
export async function tryWake(deps: WakeDeps, task: string): Promise<WakeOutcome> {
  const untried = deps.store.events(task).filter(({ event }) => event.wakeTriedAt === undefined);
  const oldest = untried[0];
  if (oldest === undefined) return 'none';
  if (isRunLive(deps.store, task, deps.isAlive)) return 'live';
  const triedAt = deps.now().toISOString();
  for (const stored of untried)
    deps.store.updateEvent(task, { ...stored, event: { ...stored.event, wakeTriedAt: triedAt } });
  try {
    const { applied } = await deps.backend.wake(task, `${WAKE_MARKER} ${wakeReason(oldest.event.name)}`);
    deps.log(`WAKE ${task} applied=${applied} event-age=${deps.now().getTime() - Date.parse(oldest.event.at)}`);
    return applied ? 'woken' : 'kept';
  } catch (error) {
    deps.log(`WARN wake ${task} failed: ${errorText(error)}`);
    return 'failed';
  }
}

/** Lets the next scan try a wake again for the task's events: its worker went away with events pending. */
export function forgetWakeTries(store: WatchStore, task: string): void {
  for (const stored of store.events(task)) {
    if (stored.event.wakeTriedAt === undefined) continue;
    const { wakeTriedAt: _tried, ...event } = stored.event;
    store.updateEvent(task, { ...stored, event });
  }
}
