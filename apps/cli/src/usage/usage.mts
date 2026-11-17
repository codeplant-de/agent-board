// The Claude subscription's usage as this machine's own runs report it. Every `claude -p --output-format stream-json` run
// emits `rate_limit_event` lines; the worker keeps the newest numbers here, and the dispatcher holds low-priority work back
// while a configured threshold is reached. The event is not a documented interface (checked against Claude Code 2.1.326):
// any other shape counts as no reading, never as an error.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord, isSafeTaskId, MACHINE_USAGE_WINDOWS, MAX_USAGE_TASKS, PRIORITIES } from '@agent-board/shared';
import type { MachineUsage, Priority } from '@agent-board/shared';
import type { UsageLimits } from '../config/config.mts';

export const USAGE_WINDOWS = ['fiveHour', 'sevenDay'] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

const EVENT_NAMES: Record<UsageWindow, string> = { fiveHour: 'five_hour', sevenDay: 'seven_day' };
export const WINDOW_LABELS: Record<UsageWindow, string> = { fiveHour: '5-hour', sevenDay: '7-day' };

/** What one run reported for a window: `utilization` is a fraction (0.28 is 28 %). */
export interface WindowReading {
  utilization: number;
  resetsAt: Date;
}

export type RateLimitReading = Partial<Record<UsageWindow, WindowReading>>;

function windowReading(utilization: unknown, resetsAt: unknown): WindowReading | undefined {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  const date = new Date(resetsAt * 1000);
  return Number.isNaN(date.getTime()) ? undefined : { utilization, resetsAt: date };
}

/** The usage a stream-json line reports, or undefined when it is no rate limit event or holds no usable window. */
export function rateLimitIn(line: string): RateLimitReading | undefined {
  if (!line.includes('"rate_limit_event"')) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || event['type'] !== 'rate_limit_event') return undefined;
  const info = event['rate_limit_info'];
  if (!isRecord(info)) return undefined;
  const reading: RateLimitReading = {};
  const windows = info['unifiedWindows'];
  if (isRecord(windows)) {
    for (const window of USAGE_WINDOWS) {
      const entry = windows[EVENT_NAMES[window]];
      const found = isRecord(entry) ? windowReading(entry['utilization'], entry['resetsAt']) : undefined;
      if (found !== undefined) reading[window] = found;
    }
  } else {
    const window = USAGE_WINDOWS.find((name) => EVENT_NAMES[name] === info['rateLimitType']);
    // A rejected window without a number is full.
    const utilization = info['utilization'] === undefined && info['status'] === 'rejected' ? 1 : info['utilization'];
    const found = window === undefined ? undefined : windowReading(utilization, info['resetsAt']);
    if (window !== undefined && found !== undefined) reading[window] = found;
  }
  return Object.keys(reading).length === 0 ? undefined : reading;
}

/** Whether two readings say the same, so a worker does not write what it wrote last. */
export function sameReading(a: RateLimitReading, b: RateLimitReading): boolean {
  return USAGE_WINDOWS.every((window) => {
    const x = a[window];
    const y = b[window];
    if (x === undefined || y === undefined) return x === y;
    return x.utilization === y.utilization && x.resetsAt.getTime() === y.resetsAt.getTime();
  });
}

export interface StoredWindow {
  utilization: number;
  resetsAt: string;
  seenAt: string;
}

export type StoredUsage = Partial<Record<UsageWindow, StoredWindow>>;

export interface UsageStore {
  /** The last reading per window; empty when the file is missing or unreadable. */
  read: () => StoredUsage;
  /** Replaces the windows `reading` has and keeps the others. */
  record: (reading: RateLimitReading, seenAt: Date) => void;
}

export function usageFile(stateDir: string): string {
  return join(stateDir, 'usage.json');
}

const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function parseStored(raw: unknown): StoredUsage {
  const usage: StoredUsage = {};
  if (!isRecord(raw)) return usage;
  for (const window of USAGE_WINDOWS) {
    const entry = raw[window];
    if (!isRecord(entry)) continue;
    const { utilization, resetsAt, seenAt } = entry;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0) continue;
    if (isTime(resetsAt) && isTime(seenAt)) usage[window] = { utilization, resetsAt, seenAt };
  }
  return usage;
}

// Several workers write the file: each reads what is there, replaces its windows and renames a temp file over it, so a reader
// never sees half a file. Two workers writing at the same moment may lose one reading, which the next run's event restores.
export function createUsageStore(file: string): UsageStore {
  const read = (): StoredUsage => {
    try {
      return parseStored(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return {};
    }
  };
  return {
    read,
    record(reading, seenAt) {
      const merged: StoredUsage = read();
      for (const window of USAGE_WINDOWS) {
        const found = reading[window];
        if (found !== undefined)
          merged[window] = {
            utilization: found.utilization,
            resetsAt: found.resetsAt.toISOString(),
            seenAt: seenAt.toISOString(),
          };
      }
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify(merged)}\n`, { mode: 0o600 });
        renameSync(temp, file);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },
  };
}

const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

export interface ReachedWindow {
  window: UsageWindow;
  // Rounded to a whole percent, for the log.
  percent: number;
  threshold: number;
  resetsAt: Date;
}

/**
 * The windows whose last reading is at or over their threshold. A reading counts only until its window resets: after that the
 * window started over, so what it said is void.
 */
export function reachedWindows(input: { limits: UsageLimits; usage: StoredUsage; now: Date }): ReachedWindow[] {
  return USAGE_WINDOWS.flatMap((window) => {
    const threshold = input.limits[window];
    const stored = input.usage[window];
    if (threshold === undefined || stored === undefined) return [];
    const resetsAt = new Date(stored.resetsAt);
    if (resetsAt.getTime() <= input.now.getTime()) return [];
    // No window is longer than seven days: a reset further off is not a time this code understands (another unit, say),
    // and believing it would hold work for good.
    if (resetsAt.getTime() - input.now.getTime() > MAX_RESET_AHEAD_MS) return [];
    // Rounded past float noise: 0.29 * 100 is 28.999999999999996.
    const percent = Math.round(stored.utilization * 100 * 1e6) / 1e6;
    return percent >= threshold ? [{ window, percent: Math.round(percent), threshold, resetsAt }] : [];
  });
}

/** Whether a task of `priority` is held back by a limit that lets `lowest` and above start. */
export function isBelowPriority(priority: Priority, lowest: Priority): boolean {
  return PRIORITIES.indexOf(priority) > PRIORITIES.indexOf(lowest);
}

export function describeReached(reached: ReachedWindow[]): string {
  return reached
    .map(
      ({ window, percent, threshold, resetsAt }) =>
        `${WINDOW_LABELS[window]} usage ${percent}% (limit ${threshold}%, resets ${resetsAt.toISOString()})`,
    )
    .join('; ');
}

export function earliestReset(reached: ReachedWindow[]): Date | undefined {
  return reached.reduce<Date | undefined>(
    (first, { resetsAt }) => (first === undefined || resetsAt < first ? resetsAt : first),
    undefined,
  );
}

/** A whole percent for the board, rounded like `reachedWindows` does and kept within what the board takes. */
function wholePercent(utilization: number): number {
  return Math.min(1000, Math.round(Math.round(utilization * 100 * 1e6) / 1e6));
}

// Sorted, so the same tasks give the same document whatever order the board listed them in.
function taskIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter(isSafeTaskId).sort().slice(0, MAX_USAGE_TASKS);
}

/** The usage status this machine tells the board: its limits and last readings, the windows at the threshold, and which tasks it holds or leaves open. */
export function buildMachineUsage(input: {
  limits: UsageLimits | undefined;
  stored: StoredUsage;
  reached: ReachedWindow[];
  heldIds: readonly string[];
  openIds: readonly string[];
}): MachineUsage {
  const { limits, stored, reached } = input;
  const windows: MachineUsage['windows'] = {};
  for (const name of MACHINE_USAGE_WINDOWS) {
    const reading = stored[name];
    if (reading !== undefined)
      windows[name] = {
        percent: wholePercent(reading.utilization),
        resetsAt: reading.resetsAt,
        seenAt: reading.seenAt,
      };
  }
  return {
    ...(limits === undefined
      ? {}
      : {
          limits: {
            ...(limits.fiveHour === undefined ? {} : { fiveHour: limits.fiveHour }),
            ...(limits.sevenDay === undefined ? {} : { sevenDay: limits.sevenDay }),
            priority: limits.priority,
          },
        }),
    windows,
    reached: reached.map(({ window }) => window),
    held: taskIds(input.heldIds),
    open: taskIds(input.openIds),
  };
}
