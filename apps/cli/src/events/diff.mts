/**
 * What changed on the board between two listings of the open tasks, as the events `board events` prints. The board's event
 * stream says only that tasks changed, so the changes are found here by comparing the listing with the one before it.
 * Changes between two listings are coalesced: a task that went todo, running, needs-me in between shows one move.
 */
import { BackendError, isPermanentRefusal } from '../backend/backend.mts';
import type { Backend, Note, Status, Task } from '@agent-board/shared';

export const EVENT_TYPES = ['created', 'moved', 'changed', 'closed', 'removed', 'note'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// The fields of a task whose change is an event. The rest changes all the time (the run's activity, the lane, the session) or says
// nothing a person acts on.
export const WATCHED_FIELDS = [
  'title',
  'priority',
  'model',
  'agent',
  'machine',
  'openQuestion',
  'notBefore',
  'wakeAt',
  'prs',
  'promptPrState',
] as const;
export type WatchedField = (typeof WATCHED_FIELDS)[number];

export interface BoardEvent {
  type: EventType;
  // When this CLI saw the change, not when it happened.
  at: Date;
  // The task after the change; for `removed` the last one seen, for `closed` the one the board answered.
  task: Task;
  // The column the task is in after the change; for `closed` and `removed` the last one seen.
  status: Status;
  from?: Status;
  to?: Status;
  fields?: WatchedField[];
  note?: Note;
}

export interface DiffDeps {
  readNotes: Backend['readNotes'];
  getTask: Backend['getTask'];
  at: Date;
}

const time = (date: Date | null): number | null => date?.getTime() ?? null;

const watched: Record<WatchedField, (task: Task) => unknown> = {
  title: (task) => task.title,
  priority: (task) => task.priority,
  model: (task) => task.model,
  agent: (task) => task.agent ?? null,
  machine: (task) => task.machine,
  openQuestion: (task) => task.openQuestion,
  notBefore: (task) => time(task.notBefore),
  wakeAt: (task) => time(task.wakeAt),
  prs: (task) => task.prs.map(({ id, url, state }) => [id, url, state]),
  promptPrState: (task) => task.promptPrState,
};

/** The watched fields that differ between two states of a task, in the order of `WATCHED_FIELDS`. */
export function changedFields(before: Task, after: Task): WatchedField[] {
  return WATCHED_FIELDS.filter(
    (field) => JSON.stringify(watched[field](before)) !== JSON.stringify(watched[field](after)),
  );
}

// The notes the task gained since `before`, oldest first. A server that does not count notes (`noteCount` absent) gains none, and neither
// does a task whose count is seen for the first time (new, reopened or on a server that just learned to count): its thread is not news.
// Reads up to the listed count only: a note written after the listing is the next refresh's.
async function newNotes(task: Task, before: Task | undefined, readNotes: DiffDeps['readNotes']): Promise<Note[]> {
  if (task.noteCount === undefined) return [];
  const known = before?.noteCount;
  if (known === undefined || task.noteCount <= known) return [];
  return (await readNotes(task.id)).slice(known, task.noteCount);
}

// A task that left the open list: closed (the board still has it), deleted (404), or one this CLI cannot read, which is dropped without an event.
async function leftTask(last: Task, deps: DiffDeps): Promise<BoardEvent | undefined> {
  try {
    const task = await deps.getTask(last.id);
    return task.closed ? { type: 'closed', at: deps.at, task, status: last.status } : undefined;
  } catch (error) {
    // Anything else (no network, a 5xx) is worth another try, so the listing is not replaced yet.
    if (!(error instanceof BackendError && error.fromApi && isPermanentRefusal(error))) throw error;
    return error.status === 404 ? { type: 'removed', at: deps.at, task: last, status: last.status } : undefined;
  }
}

/**
 * The events between two listings, in the order a reader expects: task by task in the order of `current`, each with
 * `created`, its new notes, `moved`, `changed`; then `closed` and `removed` for the tasks that left. Throws when the board cannot be
 * read for a note or a vanished task, so the caller keeps its old listing and tries again.
 */
export async function diffTasks(
  previous: readonly Task[],
  current: readonly Task[],
  deps: DiffDeps,
): Promise<BoardEvent[]> {
  const before = new Map(previous.map((task) => [task.id, task]));
  const open = new Set(current.map((task) => task.id));
  const perTask = await Promise.all(
    current.map(async (task): Promise<BoardEvent[]> => {
      const last = before.get(task.id);
      const notes = await newNotes(task, last, deps.readNotes);
      const base = { at: deps.at, task, status: task.status };
      return [
        ...(last === undefined ? [{ ...base, type: 'created' as const }] : []),
        ...notes.map((note) => ({ ...base, type: 'note' as const, note })),
        ...(last !== undefined && last.status !== task.status
          ? [{ ...base, type: 'moved' as const, from: last.status, to: task.status }]
          : []),
        ...(last === undefined || changedFields(last, task).length === 0
          ? []
          : [{ ...base, type: 'changed' as const, fields: changedFields(last, task) }]),
      ];
    }),
  );
  const left = await Promise.all(previous.filter((task) => !open.has(task.id)).map((task) => leftTask(task, deps)));
  return [...perTask.flat(), ...left.filter((event) => event !== undefined)];
}

export interface EventFilter {
  // Task ids; empty for every task.
  tasks: readonly string[];
  // Columns the task is in after the change; empty for every column.
  statuses: readonly Status[];
  types: readonly EventType[];
  machine?: string;
}

export function matchesFilter(event: BoardEvent, filter: EventFilter): boolean {
  return (
    (filter.tasks.length === 0 || filter.tasks.includes(event.task.id)) &&
    (filter.statuses.length === 0 || filter.statuses.includes(event.status)) &&
    (filter.types.length === 0 || filter.types.includes(event.type)) &&
    (filter.machine === undefined || event.task.machine === filter.machine)
  );
}
