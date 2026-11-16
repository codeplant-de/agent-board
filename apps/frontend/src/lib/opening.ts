import {
  ContractError,
  INVALID_VALUE,
  isEnvelope,
  isPriority,
  isSafeNoteId,
  isSessionId,
  openFields,
  openMachineDirs,
  openNote,
  openPr,
  openPreview,
  taskLabels,
  transcriptBinding,
  UNREADABLE_TEXT,
  type Answer,
  type Binding,
  type Keys,
  type NoteKind,
  type Opener,
  type Question,
  type TranscriptEventView,
  type UnreadableField,
} from '@agent-board/shared';
import { openAs } from './contexts';
import {
  checkNoteShapes,
  isCount,
  checkTaskShapes,
  safeId,
  safeNullableId,
  shownName,
  shownRule,
  type ShownAuthor,
} from './shapes';
import type { RouterOutputs } from './wire';

type WireBoardTask = RouterOutputs['tasks']['get']['task'];
type WireListedTask = RouterOutputs['tasks']['list'][number];
type WireLastNote = NonNullable<WireListedTask['lastNote']>;
type WireThreadNote = RouterOutputs['tasks']['get']['thread'][number];
type WireSchedule = RouterOutputs['schedules']['list'][number];
type WireEvent = RouterOutputs['transcript']['events'][number];

interface SealedFields {
  title: string;
  input: string;
  workdir: string | null;
}

export type BoardTask = Omit<WireBoardTask, keyof SealedFields | 'pr'> &
  SealedFields & {
    // The PR its agent reported, when it opens under its binding as a GitHub PR URL; see `prOf`.
    pr: string | null;
    labels: string[];
    unreadable: UnreadableField[];
    // The clear fields the board sent in a shape it does not promise; they are shown as neutral values.
    invalid: string[];
  };

export interface LastNote {
  kind: NoteKind;
  author: ShownAuthor;
  text: string;
  createdAt: string;
  unreadable: boolean;
}

export type ListedTask = BoardTask & { lastNote: LastNote | null };

export interface ThreadNote {
  id: string;
  text: string;
  createdAt: string;
  author: ShownAuthor;
  kind: NoteKind;
  by: string | null;
  // The text, the questions or the answers could not be opened: never show the note as the user's or the agent's words.
  unreadable: boolean;
  // The board sent several notes with this id, so none of them is shown.
  duplicateId?: boolean;
  questions?: Question[];
  answers?: Answer[];
  questionNoteId?: string;
  // On a comment by the agent: the reply it drafted for you.
  suggestion?: string;
  // Your message to a running agent that no worker has handed over yet.
  pending?: boolean;
  // When a worker handed your message to the running agent.
  deliveredAt?: string;
}

export interface TaskDetail {
  task: BoardTask;
  thread: ThreadNote[];
  followUps: BoardTask[];
  parent: BoardTask | null;
}

export type Schedule = Omit<WireSchedule, keyof SealedFields> &
  SealedFields & {
    unreadable: UnreadableField[];
    // The clear fields the board sent in a shape it does not promise; the page shows a placeholder for them.
    invalid: string[];
  };
// A count the board sent that is not a whole number is null.
export type TranscriptRun = Omit<RouterOutputs['transcript']['runs'][number], 'eventCount'> & {
  eventCount: number | null;
};
// `name` is what the board sent, kept to send back (a token with a name that does not pass the shape check can still be revoked);
// `shown` is what the page may print.
export type Machine = Omit<RouterOutputs['machines']['list'][number], 'dirs'> & {
  shown: string;
  // The directories the machine listed, as the user's own text; null when it has no list to offer: none sent, a revoked
  // machine, or a name that does not pass the shape check.
  dirs: string[] | null;
  // The machine has a list that does not open under its name or is not of its shape, so it offers nothing.
  dirsUnreadable: boolean;
};

// One envelope always opens to the same text, so the 5 s polls of every task's prompt decrypt only what is new. Transcript
// values are large and opened once on demand, so they are not kept.
const MAX_CACHED = 5_000;
const opened = new WeakMap<Keys, Map<string, Promise<string | undefined>>>();

/** Opens one value; undefined when it cannot be opened: legacy plain text, another key, or damage. */
export function tryOpen(keys: Keys, binding: Binding, value: string): Promise<string | undefined> {
  if (!isEnvelope(value)) return Promise.resolve(undefined);
  const attempt = (): Promise<string | undefined> => openAs(keys, binding, value).catch(() => undefined);
  if (binding.field.startsWith('tr.')) return attempt();
  const cache = opened.get(keys) ?? new Map<string, Promise<string | undefined>>();
  opened.set(keys, cache);
  const id = `${binding.field}\0${binding.context}\0${value}`;
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const pending = attempt();
  cache.set(id, pending);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value ?? id);
  return pending;
}

export const openerFor =
  (keys: Keys): Opener =>
  (binding, value) =>
    tryOpen(keys, binding, value);

export async function openBoardTask(keys: Keys, wire: WireBoardTask): Promise<BoardTask> {
  const { invalid, ...shapes } = checkTaskShapes(wire);
  const row = { kind: 'task', id: wire.id, createdBy: shapes.createdBy, scheduleId: shapes.scheduleId } as const;
  const [fields, pr] = await Promise.all([
    openFields(openerFor(keys), row, wire),
    openPr(openerFor(keys), wire.id, wire.pr),
  ]);
  return {
    ...wire,
    ...shapes,
    ...fields,
    pr,
    labels: taskLabels({ input: fields.input, createdBy: shapes.createdBy }),
    invalid,
  };
}

async function openLastNote(keys: Keys, taskId: string, wire: WireLastNote): Promise<LastNote> {
  const shapes = checkNoteShapes({ id: 'last', author: wire.author, kind: wire.kind, by: null });
  if (shapes.author === 'unknown' || !shapes.ok)
    return {
      kind: shapes.kind,
      createdAt: wire.createdAt,
      author: shapes.author,
      text: UNREADABLE_TEXT,
      unreadable: true,
    };
  const { text, unreadable } = await openPreview(openerFor(keys), taskId, {
    author: shapes.author,
    kind: shapes.kind,
    preview: wire.preview,
  });
  return {
    kind: shapes.kind,
    createdAt: wire.createdAt,
    author: shapes.author,
    text: text ?? UNREADABLE_TEXT,
    unreadable,
  };
}

export async function openListedTasks(keys: Keys, wire: WireListedTask[]): Promise<ListedTask[]> {
  return Promise.all(
    wire.map(async ({ lastNote, ...task }) => {
      const [opened, note] = await Promise.all([
        openBoardTask(keys, task),
        lastNote === null ? null : openLastNote(keys, task.id, lastNote),
      ]);
      return { ...opened, lastNote: note };
    }),
  );
}

async function openThreadNote(
  keys: Keys,
  taskId: string,
  wire: WireThreadNote,
  duplicate: boolean,
): Promise<ThreadNote> {
  const shapes = checkNoteShapes(wire);
  const base = { id: shapes.id, createdAt: wire.createdAt, kind: shapes.kind, by: shapes.by };
  const unreadable = { ...base, author: shapes.author, text: '', unreadable: true };
  if (duplicate) return { ...unreadable, duplicateId: true };
  if (!shapes.ok || shapes.author === 'unknown') return unreadable;
  const opened = await openNote(openerFor(keys), taskId, { ...wire, author: shapes.author, kind: shapes.kind });
  const questionNoteId =
    wire.questionNoteId !== undefined && isSafeNoteId(wire.questionNoteId)
      ? { questionNoteId: wire.questionNoteId }
      : {};
  const delivery = {
    ...(wire.pending === true ? { pending: true } : {}),
    ...(typeof wire.deliveredAt === 'string' && !Number.isNaN(Date.parse(wire.deliveredAt))
      ? { deliveredAt: wire.deliveredAt }
      : {}),
  };
  return { ...base, ...opened, ...questionNoteId, ...delivery };
}

/**
 * A thread as it is shown. Notes of one id are one note, so a board that sends the same id twice (to put an earlier question
 * where the open one is, say) gets none of them shown: every note with a repeated id is unreadable.
 */
export async function openThread(keys: Keys, taskId: string, wire: WireThreadNote[]): Promise<ThreadNote[]> {
  const counts = new Map<string, number>();
  for (const note of wire) counts.set(note.id, (counts.get(note.id) ?? 0) + 1);
  return Promise.all(wire.map((note) => openThreadNote(keys, taskId, note, (counts.get(note.id) ?? 0) > 1)));
}

export async function openTaskDetail(keys: Keys, wire: RouterOutputs['tasks']['get']): Promise<TaskDetail> {
  const [task, thread, followUps, parent] = await Promise.all([
    openBoardTask(keys, wire.task),
    openThread(keys, wire.task.id, wire.thread),
    Promise.all(wire.followUps.map((followUp) => openBoardTask(keys, followUp))),
    wire.parent === null ? null : openBoardTask(keys, wire.parent),
  ]);
  return { task, thread, followUps, parent };
}

export async function openSchedule(keys: Keys, wire: WireSchedule): Promise<Schedule> {
  const id = safeId(wire.id, 'schedule id');
  const fields = await openFields(openerFor(keys), { kind: 'schedule', id }, wire);
  const remainingOk = wire.remaining === null || isCount(wire.remaining);
  const everyOk = wire.everyMs === null || (isCount(wire.everyMs) && wire.everyMs > 0);
  return {
    ...wire,
    ...fields,
    id,
    priority: isPriority(wire.priority) ? wire.priority : 'normal',
    machine: shownName(wire.machine),
    ...shownRule(wire),
    remaining: remainingOk ? wire.remaining : null,
    everyMs: everyOk ? wire.everyMs : null,
    invalid: [...(remainingOk ? [] : ['remaining']), ...(everyOk ? [] : ['everyMs'])],
    occurrenceTaskId: safeNullableId(wire.occurrenceTaskId, 'occurrence id'),
  };
}

export async function openSchedules(keys: Keys, wire: WireSchedule[]): Promise<Schedule[]> {
  return Promise.all(wire.map((schedule) => openSchedule(keys, schedule)));
}

/** The runs of a task: ids are what the events are asked for, so a bad one refuses the reply; a machine name or session that is not of its shape shows as neutral. */
export function openRuns(wire: RouterOutputs['transcript']['runs']): TranscriptRun[] {
  return wire.map((run) => {
    if (!isSafeNoteId(run.id)) throw new ContractError('The board sent a run id that is not an id.');
    return {
      ...run,
      machine: shownName(run.machine) ?? INVALID_VALUE,
      eventCount: isCount(run.eventCount) ? run.eventCount : null,
      sessionId: run.sessionId !== null && isSessionId(run.sessionId) ? run.sessionId : null,
    };
  });
}

export async function openMachines(keys: Keys, wire: RouterOutputs['machines']['list']): Promise<Machine[]> {
  return Promise.all(
    wire.map(async ({ dirs: sealed, ...machine }) => {
      const shown = shownName(machine.name) ?? INVALID_VALUE;
      const offers = machine.revokedAt === null && shown !== INVALID_VALUE && sealed !== null && sealed !== undefined;
      const opened = offers ? await openMachineDirs(openerFor(keys), machine.name, sealed) : undefined;
      return {
        ...machine,
        shown,
        dirs: opened?.map(({ path }) => path) ?? null,
        dirsUnreadable: offers && opened === undefined,
      };
    }),
  );
}

/** An event that cannot be opened becomes a note saying so, so the rest of the run still reads. */
export async function openEvent(
  keys: Keys,
  run: { taskId: string; runId: string },
  wire: WireEvent,
): Promise<TranscriptEventView> {
  const text = await tryOpen(keys, transcriptBinding('tr.data', run.taskId, run.runId, wire.seq), wire.data);
  try {
    const data: unknown = text === undefined ? undefined : JSON.parse(text);
    if (typeof data === 'object' && data !== null && 'kind' in data && 'seq' in data)
      if (data.kind === wire.kind && data.seq === wire.seq)
        // The shape within the sealed JSON is the worker's; only the kind and position are checked against the listing.
        return { ...data, outputSize: isCount(wire.outputSize) ? wire.outputSize : null } as TranscriptEventView;
  } catch {
    // Falls through to the placeholder.
  }
  const parent = wire.parent !== null && isSafeNoteId(wire.parent) ? wire.parent : null;
  return { seq: wire.seq, at: wire.at, parent, kind: 'note', text: UNREADABLE_TEXT, outputSize: null };
}

export async function openEvents(
  keys: Keys,
  run: { taskId: string; runId: string },
  wire: WireEvent[],
): Promise<TranscriptEventView[]> {
  return Promise.all(wire.map((event) => openEvent(keys, run, event)));
}

export async function openOutput(
  keys: Keys,
  run: { taskId: string; runId: string },
  seq: number,
  wire: string | null,
): Promise<string> {
  if (wire === null) return '';
  return (await tryOpen(keys, transcriptBinding('tr.output', run.taskId, run.runId, seq), wire)) ?? UNREADABLE_TEXT;
}
