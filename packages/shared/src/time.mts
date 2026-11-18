// Durations and points in time as people type them: `board schedule --in 1h30m`, `--at 09:00`, the form's date field.
import { ContractError } from './contract.mts';
import type { Schedule } from './contract.mts';

const UNIT_MS = { w: 7 * 86_400_000, d: 86_400_000, h: 3_600_000, m: 60_000 } as const;
const UNITS = ['w', 'd', 'h', 'm'] as const;

const DURATION_FORMS = 'a number and a unit (m, h, d, w), largest unit first, such as 30m, 2h, 1d or 1h30m';
const WHEN_FORMS =
  'an ISO date and time with an offset or Z (2027-01-01T12:00:00Z), without one for local time (2027-01-01T12:00), ' +
  'a date (2027-01-01, local midnight) or a time of day (09:30, the next one)';

export function parseDuration(text: string): number {
  const match = /^(?:(\d+)w\s*)?(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?$/.exec(text.trim());
  if (match === null || text.trim() === '')
    throw new ContractError(`"${text.slice(0, 40)}" is not a duration; use ${DURATION_FORMS}`);
  const ms = UNITS.reduce((sum, unit, index) => sum + Number(match[index + 1] ?? 0) * UNIT_MS[unit], 0);
  if (ms <= 0) throw new ContractError(`a duration must be longer than zero; use ${DURATION_FORMS}`);
  return ms;
}

export function formatDuration(ms: number): string {
  let rest = Math.round(ms / 60_000) * 60_000;
  const parts = UNITS.flatMap((unit) => {
    const count = Math.floor(rest / UNIT_MS[unit]);
    rest -= count * UNIT_MS[unit];
    return count > 0 ? [`${count}${unit}`] : [];
  });
  return parts.length > 0 ? parts.join(' ') : '0m';
}

// "every 2h", "cron 0 9 * * 1-5 (Europe/Berlin)", "cron 0 9 * * 5#1 | 0 9 * * 5#3 (Europe/Berlin)" or "after Ab3dEf9x +10m".
export function describeRule(
  schedule: Pick<Schedule, 'everyMs' | 'cron' | 'timezone'> & Partial<Pick<Schedule, 'moreCrons' | 'after'>>,
): string {
  if (schedule.everyMs !== null) return `every ${formatDuration(schedule.everyMs)}`;
  if (schedule.after != null)
    return `after ${schedule.after.scheduleId}${schedule.after.delayMs > 0 ? ` +${formatDuration(schedule.after.delayMs)}` : ''}`;
  return `cron ${[schedule.cron ?? '', ...(schedule.moreCrons ?? [])].join(' | ')} (${schedule.timezone ?? ''})`;
}

// Runs the schedule still has, the pending one included; null: forever.
export function runsLeft(schedule: Pick<Schedule, 'remaining' | 'occurrenceTaskId'>): number | null {
  return schedule.remaining === null ? null : schedule.remaining + (schedule.occurrenceTaskId === null ? 0 : 1);
}

function localDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date | null {
  const date = new Date(year, month - 1, day, hour, minute, second);
  const exact =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute;
  return exact ? date : null;
}

function parsedAt(text: string, now: Date): Date | null {
  const input = text.trim();
  const offset = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(input);
  if (offset !== null) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return null;
    // Date rolls an impossible calendar date over (02-30 becomes 03-02); the stated fields must survive in UTC.
    const [year, month, day, hour, minute, second] = offset.slice(1).map((part) => Number(part ?? 0));
    const stated = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0, hour ?? 0, minute ?? 0, second ?? 0));
    const exact =
      stated.getUTCFullYear() === year &&
      stated.getUTCMonth() === (month ?? 1) - 1 &&
      stated.getUTCDate() === day &&
      stated.getUTCHours() === hour &&
      stated.getUTCMinutes() === minute;
    return exact ? date : null;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(input);
  if (local !== null) {
    const [year, month, day, hour, minute, second] = local.slice(1).map((part) => Number(part ?? 0));
    return localDate(year ?? 0, month ?? 0, day ?? 0, hour ?? 0, minute ?? 0, second ?? 0);
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(input);
  if (clock !== null) {
    const [hour, minute] = [Number(clock[1]), Number(clock[2])];
    if (hour > 23 || minute > 59) return null;
    const ahead = hour * 60 + minute > now.getHours() * 60 + now.getMinutes();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (ahead ? 0 : 1));
    return localDate(day.getFullYear(), day.getMonth() + 1, day.getDate(), hour, minute, 0);
  }
  return null;
}

export function parseWhen(text: string, now: Date): Date {
  const date = parsedAt(text, now);
  if (date === null) throw new ContractError(`"${text.slice(0, 40)}" is not a time; use ${WHEN_FORMS}`);
  if (date.getTime() <= now.getTime()) throw new ContractError(`"${text.slice(0, 40)}" is in the past`);
  return date;
}
