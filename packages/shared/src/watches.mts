// The watches of a task as the board shows them (`board watch`): what a machine's CLI publishes about the watches it runs for
// the task, and what the user asked to stop. The list is agent-sealed text (`watches`, see sealing.mts) and is shape-checked
// when it is opened. It never holds a command or its output: those stay on the machine.
import { isRecord, isStringList } from './guards.mts';

/** The most watches a task shows, and the most stop requests it holds. */
export const MAX_TASK_WATCHES = 32;

/** A watch's name is a file name, argv and a message to the agent on the machine; nothing else is taken. */
export const MAX_WATCH_NAME_CHARS = 32;
const WATCH_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isWatchName(name: string): boolean {
  return WATCH_NAME.test(name);
}

const WATCH_ID = /^[0-9a-f]{16}$/;

/** A watch's id: 16 lowercase hex digits, which the CLI makes. */
export function isWatchId(value: unknown): value is string {
  return typeof value === 'string' && WATCH_ID.test(value);
}

export const WATCH_KINDS = ['ci', 'command', 'stream', 'timer'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export const MAX_WATCH_LABEL_CHARS = 120;
export const MAX_WATCH_STATUS_CHARS = 200;

/** One watch of a task, opened. `label` is what it watches ("CI #116"), `status` its one-line state ("4 of 7 passed, 3 running"). */
export interface TaskWatch {
  id: string;
  name: string;
  kind: WatchKind;
  label: string;
  status: string;
  /** ISO time: when the watch ends at the latest. */
  deadline: string;
  /** ISO time of the watch's last look, when it has made one. */
  lastAttemptAt?: string;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

// One line of at most `max` characters, without control characters.
function isOneLine(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length > max) return false;
  return [...value].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f) && code !== 0x2028 && code !== 0x2029;
  });
}

/** The watch `value` describes, or undefined when it is not one of the shape `TaskWatch` documents. Other keys are ignored. */
export function parseTaskWatch(value: unknown): TaskWatch | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, kind, label, status, deadline, lastAttemptAt } = value;
  if (!isWatchId(id) || typeof name !== 'string' || !isWatchName(name)) return undefined;
  const watchKind = WATCH_KINDS.find((known) => known === kind);
  if (watchKind === undefined) return undefined;
  if (!isOneLine(label, MAX_WATCH_LABEL_CHARS) || label === '' || !isOneLine(status, MAX_WATCH_STATUS_CHARS))
    return undefined;
  if (!isIsoTime(deadline)) return undefined;
  if (lastAttemptAt !== undefined && !isIsoTime(lastAttemptAt)) return undefined;
  return {
    id,
    name,
    kind: watchKind,
    label,
    status,
    deadline,
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
  };
}

/** The sealed document of a task's watches: the list, and how many spooled events of the task wait for the agent. */
export interface TaskWatchDocument {
  watches: TaskWatch[];
  pendingEvents: number;
}

/**
 * The sealed document `{"watches":[…],"pendingEvents":n}`, or undefined when it is not one: not an object, no list, more than
 * 32 entries, or a count that is not a non-negative integer (absent counts as 0). An entry of the wrong shape is dropped and the
 * rest kept, as is a repeated id (the first stays).
 */
export function parseTaskWatches(json: unknown): TaskWatchDocument | undefined {
  if (!isRecord(json) || !Array.isArray(json['watches']) || json['watches'].length > MAX_TASK_WATCHES) return undefined;
  const pendingEvents = json['pendingEvents'] ?? 0;
  if (typeof pendingEvents !== 'number' || !Number.isSafeInteger(pendingEvents) || pendingEvents < 0) return undefined;
  const entries: unknown[] = json['watches'];
  const watches = entries.flatMap((entry) => parseTaskWatch(entry) ?? []);
  return {
    watches: watches.filter((watch, index) => watches.findIndex(({ id }) => id === watch.id) === index),
    pendingEvents,
  };
}

/** The one document a task's watches are sealed as. */
export const taskWatchesJson = (watches: readonly TaskWatch[], pendingEvents: number): string =>
  JSON.stringify({
    watches: watches.map(({ id, name, kind, label, status, deadline, lastAttemptAt }) => ({
      id,
      name,
      kind,
      label,
      status,
      deadline,
      ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
    })),
    pendingEvents,
  });

/** The ids a list names when every one is a watch id and there are at most 32, else undefined. */
export function parseWatchIds(value: unknown): string[] | undefined {
  if (!isStringList(value) || value.length > MAX_TASK_WATCHES || !value.every(isWatchId)) return undefined;
  return value;
}
