import { formatDuration } from '@agent-board/shared';

/** How long a delayed task still waits, as badge text ("Starts in 4h"); undefined once it is due. */
export function startsIn(notBefore: Date | string | null, now: number = Date.now()): string | undefined {
  if (notBefore === null) return undefined;
  const remaining = new Date(notBefore).getTime() - now;
  if (remaining <= 0) return undefined;
  return remaining < 60_000 ? 'Starts in under 1m' : `Starts in ${formatDuration(remaining)}`;
}

/**
 * What a waiting task's badge says: when a timer wakes it ("Wakes in 12m"), or that a check may wake it any time and when it
 * gives up ("Checking · up to 1h 50m"). Undefined for a task without a wait.
 */
export function wakesIn(wakeAt: Date | string | null, check: boolean, now: number = Date.now()): string | undefined {
  if (wakeAt === null) return undefined;
  const remaining = new Date(wakeAt).getTime() - now;
  const left = remaining < 60_000 ? 'under 1m' : formatDuration(remaining);
  if (check) return remaining <= 0 ? 'Checking · timed out' : `Checking · up to ${left}`;
  return remaining <= 0 ? 'Waking' : `Wakes in ${left}`;
}
