import {
  isEnvelope,
  openFields,
  openNote,
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
  type WireNoteAuthor,
} from '@agent-board/shared';
import { openAs } from './contexts';
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

export type BoardTask = Omit<WireBoardTask, keyof SealedFields> &
  SealedFields & { labels: string[]; unreadable: UnreadableField[] };

export interface LastNote {
  kind: NoteKind;
  author: WireNoteAuthor;
  text: string;
  createdAt: string;
  unreadable: boolean;
}

export type ListedTask = BoardTask & { lastNote: LastNote | null };

export interface ThreadNote {
  id: string;
  text: string;
  createdAt: string;
  author: WireNoteAuthor;
  kind: NoteKind;
  by: string | null;
  // The text, the questions or the answers could not be opened: never show the note as the user's or the agent's words.
  unreadable: boolean;
  questions?: Question[];
  answers?: Answer[];
  questionNoteId?: string;
}

export interface TaskDetail {
  task: BoardTask;
  thread: ThreadNote[];
  followUps: BoardTask[];
  parent: BoardTask | null;
}

export type Schedule = Omit<WireSchedule, keyof SealedFields> & SealedFields & { unreadable: UnreadableField[] };

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
  const row = { kind: 'task', id: wire.id, createdBy: wire.createdBy, scheduleId: wire.scheduleId } as const;
  const fields = await openFields(openerFor(keys), row, wire);
  return { ...wire, ...fields, labels: taskLabels({ input: fields.input, createdBy: wire.createdBy }) };
}

async function openLastNote(keys: Keys, taskId: string, wire: WireLastNote): Promise<LastNote> {
  const { text, unreadable } = await openPreview(openerFor(keys), taskId, wire);
  return { kind: wire.kind, createdAt: wire.createdAt, author: wire.author, text: text ?? UNREADABLE_TEXT, unreadable };
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

async function openThreadNote(keys: Keys, taskId: string, wire: WireThreadNote): Promise<ThreadNote> {
  const opened = await openNote(openerFor(keys), taskId, wire);
  return {
    id: wire.id,
    createdAt: wire.createdAt,
    kind: wire.kind,
    by: wire.by,
    ...opened,
    ...(wire.questionNoteId !== undefined ? { questionNoteId: wire.questionNoteId } : {}),
  };
}

export async function openThread(keys: Keys, taskId: string, wire: WireThreadNote[]): Promise<ThreadNote[]> {
  return Promise.all(wire.map((note) => openThreadNote(keys, taskId, note)));
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
  return { ...wire, ...(await openFields(openerFor(keys), { kind: 'schedule', id: wire.id }, wire)) };
}

export async function openSchedules(keys: Keys, wire: WireSchedule[]): Promise<Schedule[]> {
  return Promise.all(wire.map((schedule) => openSchedule(keys, schedule)));
}

/** An event that cannot be opened becomes a note saying so, so the rest of the run still reads. */
export async function openEvent(keys: Keys, runId: string, wire: WireEvent): Promise<TranscriptEventView> {
  const text = await tryOpen(keys, transcriptBinding('tr.data', runId, wire.seq), wire.data);
  try {
    const data: unknown = text === undefined ? undefined : JSON.parse(text);
    if (typeof data === 'object' && data !== null && 'kind' in data && 'seq' in data)
      if (data.kind === wire.kind && data.seq === wire.seq)
        // The shape within the sealed JSON is the worker's; only the kind and position are checked against the listing.
        return { ...data, outputSize: wire.outputSize } as TranscriptEventView;
  } catch {
    // Falls through to the placeholder.
  }
  return { seq: wire.seq, at: wire.at, parent: wire.parent, kind: 'note', text: UNREADABLE_TEXT, outputSize: null };
}

export async function openEvents(keys: Keys, runId: string, wire: WireEvent[]): Promise<TranscriptEventView[]> {
  return Promise.all(wire.map((event) => openEvent(keys, runId, event)));
}

export async function openOutput(keys: Keys, runId: string, seq: number, wire: string | null): Promise<string> {
  if (wire === null) return '';
  return (await tryOpen(keys, transcriptBinding('tr.output', runId, seq), wire)) ?? UNREADABLE_TEXT;
}
