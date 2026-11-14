// What the board server sends in the clear is checked here, with the same validators the CLI's wire parsers use, before the
// browser shows it: a value that is not of the shape the contract allows for its field is replaced by a neutral one and named
// in `invalid`, never shown. Ids that routes and bindings are built from cannot be replaced, so a bad one refuses the reply.
import {
  ContractError,
  INVALID_VALUE,
  isBlindIndex,
  isCronExpression,
  isKeyId,
  isNextRun,
  isPriority,
  isSafeLane,
  isSafeMachineName,
  isSafeNoteId,
  isSafeTaskId,
  isSessionId,
  isStatus,
  isTaskCreator,
  isTimeZoneName,
  hasControlCharacter,
  NOTE_KINDS,
  WIRE_NOTE_AUTHORS,
  type NextRun,
  type NoteKind,
  type Priority,
  type Status,
  type TaskCreator,
  type WireNoteAuthor,
} from '@agent-board/shared';

/** The author of a note whose author the board did not name properly. */
export const UNKNOWN_AUTHOR = 'unknown';
export type ShownAuthor = WireNoteAuthor | typeof UNKNOWN_AUTHOR;

/** Neutral stand-ins for the closed sets: the least a value of that kind can mean. */
const NEUTRAL_STATUS: Status = 'needs-me';
const NEUTRAL_PRIORITY: Priority = 'normal';
const NEUTRAL_NEXT: NextRun = 'fresh';
// A task of a creator the board did not name properly must never look like one the user made.
const NEUTRAL_CREATOR: TaskCreator = 'agent';

interface Checked<T> {
  value: T;
  invalid: boolean;
}

const checked = <T>(ok: boolean, value: T, neutral: T): Checked<T> => ({ value: ok ? value : neutral, invalid: !ok });

export function safeId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !isSafeTaskId(value)) throw new ContractError(`The board sent an invalid ${what}.`);
  return value;
}

export function safeNullableId(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : safeId(value, what);
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && values.some((candidate) => candidate === value);

/** A machine or lane name, or a placeholder. */
export function shownName(value: string | null): string | null {
  return value === null || isSafeMachineName(value) ? value : INVALID_VALUE;
}

export interface TaskShapes {
  status: Status;
  priority: Priority;
  next: NextRun;
  createdBy: TaskCreator;
  machine: string | null;
  lane: string | null;
  sessionId: string | null;
  head: string | null;
  scheduleId: string | null;
  parentId: string | null;
  // The fields that did not have the shape the board promises, for the page to say so.
  invalid: string[];
}

/** The clear, server-controlled fields of a task, each checked for its shape. */
export function checkTaskShapes(wire: {
  id: string;
  status: unknown;
  priority: unknown;
  next: unknown;
  createdBy: unknown;
  machine: string | null;
  lane: string | null;
  sessionId: string | null;
  head: string | null;
  scheduleId: string | null;
  parentId?: string | null;
}): TaskShapes {
  safeId(wire.id, 'task id');
  const fields: [string, Checked<unknown>][] = [
    ['status', checked(isStatus(wire.status), wire.status, NEUTRAL_STATUS)],
    ['priority', checked(isPriority(wire.priority), wire.priority, NEUTRAL_PRIORITY)],
    ['next', checked(isNextRun(wire.next), wire.next, NEUTRAL_NEXT)],
    ['createdBy', checked(isTaskCreator(wire.createdBy), wire.createdBy, NEUTRAL_CREATOR)],
    ['machine', checked(wire.machine === null || isSafeMachineName(wire.machine), wire.machine, INVALID_VALUE)],
    ['lane', checked(wire.lane === null || isSafeLane(wire.lane), wire.lane, INVALID_VALUE)],
    ['sessionId', checked(wire.sessionId === null || isSessionId(wire.sessionId), wire.sessionId, null)],
    ['head', checked(wire.head === null || isBlindIndex(wire.head), wire.head, null)],
  ];
  const by = Object.fromEntries(fields.map(([name, { value }]) => [name, value]));
  return {
    status: by['status'] as Status,
    priority: by['priority'] as Priority,
    next: by['next'] as NextRun,
    createdBy: by['createdBy'] as TaskCreator,
    machine: by['machine'] as string | null,
    lane: by['lane'] as string | null,
    sessionId: by['sessionId'] as string | null,
    head: by['head'] as string | null,
    scheduleId: safeNullableId(wire.scheduleId, 'schedule id'),
    parentId: safeNullableId(wire.parentId, 'parent id'),
    invalid: fields.filter(([, { invalid }]) => invalid).map(([name]) => name),
  };
}

/** What a note shows of the author, kind and who wrote it, each checked; `ok` is false when any of them is not of its shape. */
export function checkNoteShapes(wire: { id: string; author: unknown; kind: unknown; by: string | null }): {
  id: string;
  author: ShownAuthor;
  kind: NoteKind;
  by: string | null;
  ok: boolean;
} {
  const author = isOneOf(WIRE_NOTE_AUTHORS, wire.author);
  const kind = isOneOf(NOTE_KINDS, wire.kind);
  const id = typeof wire.id === 'string' && isSafeNoteId(wire.id);
  return {
    id: id ? wire.id : INVALID_VALUE,
    author: author ? (wire.author as WireNoteAuthor) : UNKNOWN_AUTHOR,
    kind: kind ? (wire.kind as NoteKind) : 'comment',
    by: shownName(wire.by),
    ok: author && kind && id,
  };
}

/** The rule of a schedule, as far as it is of its shape. */
export function shownRule(wire: { cron: string | null; timezone: string | null }): {
  cron: string | null;
  timezone: string | null;
} {
  return {
    cron: wire.cron === null || isCronExpression(wire.cron) ? wire.cron : INVALID_VALUE,
    timezone: wire.timezone === null || isTimeZoneName(wire.timezone) ? wire.timezone : INVALID_VALUE,
  };
}

/** The name the board reports for the signed-in user: one line, as the CLI requires of it. */
export function isUserName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 256 && !hasControlCharacter(value);
}

export function parseMe(value: { username: unknown; keyId: unknown }): { username: string; keyId: string | null } {
  if (!isUserName(value.username)) throw new ContractError('The board sent a user name this browser does not accept.');
  if (value.keyId !== null && !isKeyId(value.keyId))
    throw new ContractError('The board sent a key id that is not one.');
  return { username: value.username, keyId: value.keyId };
}
