// The usage status of a machine: its configured limits, the last usage it saw per window, which windows are over their
// threshold and which Todo tasks it holds back for that. Sent to the board as one sealed document (`machine.usage`, see
// sealing.mts) so the browser can say why a task has not started. It is display only and never acted on, so everything in it is
// shape-checked again when it is opened.
import { isPriority, isSafeTaskId } from './contract.mts';
import type { Priority } from './contract.mts';
import { isRecord } from './guards.mts';

export const MACHINE_USAGE_WINDOWS = ['fiveHour', 'sevenDay'] as const;
export type MachineUsageWindow = (typeof MACHINE_USAGE_WINDOWS)[number];

export interface UsageWindowState {
  // A whole percent of the window's quota, as the machine rounds it for its log.
  percent: number;
  resetsAt: string;
  seenAt: string;
}

export interface MachineUsage {
  // `usageLimits` of the machine's config.json; absent when it has none.
  limits?: { fiveHour?: number; sevenDay?: number; priority: Priority };
  windows: Partial<Record<MachineUsageWindow, UsageWindowState>>;
  // The windows at or over their threshold at the tick.
  reached: MachineUsageWindow[];
  // Todo tasks the machine could serve and held back for usage in that tick.
  held: string[];
  // Todo tasks the machine could serve and does not hold: started or waiting for a slot.
  open: string[];
}

export const MAX_USAGE_TASKS = 500;
const MAX_PERCENT = 1000;
const MAX_TIME_CHARS = 40;

function isTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TIME_CHARS && !Number.isNaN(Date.parse(value));
}

function parseThreshold(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100 ? value : undefined;
}

function parseLimits(value: unknown): MachineUsage['limits'] {
  if (!isRecord(value) || !isPriority(value['priority'])) return undefined;
  const fiveHour = parseThreshold(value['fiveHour']);
  const sevenDay = parseThreshold(value['sevenDay']);
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
    priority: value['priority'],
  };
}

function parseWindow(value: unknown): UsageWindowState | undefined {
  if (!isRecord(value)) return undefined;
  const { percent, resetsAt, seenAt } = value;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > MAX_PERCENT)
    return undefined;
  if (!isTime(resetsAt) || !isTime(seenAt)) return undefined;
  return { percent, resetsAt, seenAt };
}

// The ids in a list, an id that is not a task id dropped; undefined when it is not a list or has more than the cap.
function parseIds(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_USAGE_TASKS) return undefined;
  const entries: unknown[] = value;
  return entries.filter((id): id is string => typeof id === 'string' && isSafeTaskId(id));
}

/**
 * The usage status in a decoded document, or undefined when it is unreadable: not an object, `windows`, `reached`, `held` or
 * `open` of another shape, or more task ids than the cap. An entry of the wrong shape (a window without numbers or times, a
 * limit out of range, an id that is no task id) is dropped without losing the document, and other keys are ignored.
 */
export function parseMachineUsage(json: unknown): MachineUsage | undefined {
  if (!isRecord(json)) return undefined;
  const rawWindows = json['windows'] ?? {};
  const rawReached = json['reached'] ?? [];
  const held = parseIds(json['held']);
  const open = parseIds(json['open']);
  if (!isRecord(rawWindows) || !Array.isArray(rawReached) || held === undefined || open === undefined) return undefined;
  const reachedNames: unknown[] = rawReached;
  const limits = parseLimits(json['limits']);
  const windows: MachineUsage['windows'] = {};
  for (const name of MACHINE_USAGE_WINDOWS) {
    const window = parseWindow(rawWindows[name]);
    if (window !== undefined) windows[name] = window;
  }
  return {
    ...(limits === undefined ? {} : { limits }),
    windows,
    reached: MACHINE_USAGE_WINDOWS.filter((name) => reachedNames.includes(name)),
    held,
    open,
  };
}

/** The one document a usage status is sealed as, and the bytes its blind index is made of: known fields only, in a fixed order. */
export function machineUsageJson(usage: MachineUsage): string {
  const { limits } = usage;
  const windows = MACHINE_USAGE_WINDOWS.flatMap((name) => {
    const window = usage.windows[name];
    return window === undefined
      ? []
      : [[name, { percent: window.percent, resetsAt: window.resetsAt, seenAt: window.seenAt }] as const];
  });
  return JSON.stringify({
    ...(limits === undefined
      ? {}
      : {
          limits: {
            ...(limits.fiveHour === undefined ? {} : { fiveHour: limits.fiveHour }),
            ...(limits.sevenDay === undefined ? {} : { sevenDay: limits.sevenDay }),
            priority: limits.priority,
          },
        }),
    windows: Object.fromEntries(windows),
    reached: usage.reached,
    held: usage.held,
    open: usage.open,
  });
}

/** What is wrong with a usage status the board would not take, or undefined; the sender checks before it seals. */
export function usageProblem(usage: MachineUsage): string | undefined {
  if (usage.held.length > MAX_USAGE_TASKS) return `more than ${MAX_USAGE_TASKS} held tasks`;
  if (usage.open.length > MAX_USAGE_TASKS) return `more than ${MAX_USAGE_TASKS} open tasks`;
  // What a round trip through the document keeps is what the board will show; anything it would drop is a mistake of the sender.
  const kept = parseMachineUsage(JSON.parse(machineUsageJson(usage)));
  if (kept === undefined || machineUsageJson(kept) !== machineUsageJson(usage)) {
    return 'an entry that is not of its shape: a limit, a window reading, a time or a task id';
  }
  return undefined;
}
