import type { Schedule, ScheduleSettings } from '@agent-board/shared';

/** The schedule as `settings` would leave it, for the dry run and the test fakes; the server does the real work. */
export function withScheduleSettings(schedule: Schedule, settings: ScheduleSettings): Schedule {
  const { agent, place, repeat, at, runsLeft, until, ...rest } = settings;
  const pendingCard = schedule.occurrenceTaskId === null ? 0 : 1;
  return {
    ...schedule,
    ...rest,
    agent: agent ?? null,
    machine: place?.machine ?? null,
    workdir: place?.workdir ?? null,
    everyMs: 'everyMs' in repeat ? repeat.everyMs : null,
    cron: 'cron' in repeat ? repeat.cron : null,
    timezone: 'cron' in repeat ? repeat.timezone : null,
    after: 'after' in repeat ? repeat.after : null,
    ...(schedule.moreCrons === undefined && !('cron' in repeat)
      ? {}
      : { moreCrons: 'cron' in repeat ? (repeat.moreCrons ?? []) : [] }),
    anchorAt: at ?? schedule.anchorAt,
    remaining: runsLeft === null ? null : Math.max(0, runsLeft - pendingCard),
    until,
  };
}
