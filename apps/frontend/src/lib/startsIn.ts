import { formatDuration } from '@agent-board/shared';

/** How long a delayed task still waits, as badge text ("Starts in 4h"); undefined once it is due. */
export function startsIn(notBefore: Date | string | null, now: number = Date.now()): string | undefined {
  if (notBefore === null) return undefined;
  const remaining = new Date(notBefore).getTime() - now;
  if (remaining <= 0) return undefined;
  return remaining < 60_000 ? 'Starts in under 1m' : `Starts in ${formatDuration(remaining)}`;
}
