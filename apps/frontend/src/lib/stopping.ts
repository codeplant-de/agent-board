import type { BoardTask } from './trpc';

/** What stopping a task does now; null when it cannot be stopped. */
export type StopKind = 'run' | 'resume' | 'wait';

/** A stop request still set this long after the click suggests the machine's CLI does not act on stop requests. */
export const STOP_HINT_AFTER_MS = 60_000;

export const STOP_LABEL: Record<StopKind, string> = {
  run: 'Interrupts the agent; the task moves to Needs me',
  resume: 'Hold back: move to Needs me, so the queued answer is not sent yet',
  wait: 'Moves the task to Backlog and ends its wait',
};

export function stopKind(task: Pick<BoardTask, 'status' | 'next' | 'closed' | 'createdBy'>): StopKind | null {
  if (task.closed || task.createdBy === 'agent') return null;
  if (task.status === 'running') return 'run';
  if (task.status === 'todo' && task.next === 'resume') return 'resume';
  if (task.status === 'waiting') return 'wait';
  return null;
}

export const isStopping = (task: Pick<BoardTask, 'status' | 'stopRequested'>): boolean =>
  task.status === 'running' && task.stopRequested === true;

export const isStopHintDue = (clickedAt: number | null, now: number): boolean =>
  clickedAt !== null && now - clickedAt >= STOP_HINT_AFTER_MS;
