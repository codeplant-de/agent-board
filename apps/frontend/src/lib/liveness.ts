/** How long the agent of a running task has been quiet, in words and a color. */
export interface Liveness {
  text: string;
  color: 'dimmed' | 'yellow' | 'red';
}

const QUIET_WARN_MS = 5 * 60_000;
const QUIET_ALARM_MS = 10 * 60_000;

export function liveness(lastActiveAt: Date | string | null, now: number = Date.now()): Liveness {
  if (lastActiveAt === null) return { text: 'starting', color: 'dimmed' };
  const quiet = Math.max(0, now - new Date(lastActiveAt).getTime());
  const minutes = Math.floor(quiet / 60_000);
  const seconds = Math.floor(quiet / 1000);
  if (quiet < 60_000) return { text: `active ${Math.max(1, seconds)}s ago`, color: 'dimmed' };
  if (quiet < QUIET_WARN_MS) return { text: `active ${minutes}m ${seconds % 60}s ago`, color: 'dimmed' };
  return { text: `quiet for ${minutes} min`, color: quiet < QUIET_ALARM_MS ? 'yellow' : 'red' };
}
