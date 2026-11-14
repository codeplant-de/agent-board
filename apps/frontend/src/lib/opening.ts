import {
  isEnvelope,
  parseAnswers,
  parseQuestions,
  taskLabels,
  UNREADABLE_TEXT,
  UNREADABLE_TITLE,
  type Answer,
  type Keys,
  type NoteAuthor,
  type NoteKind,
  type Question,
  type TranscriptEventView,
  type UnreadableField,
} from '@agent-board/shared';
import {
  noteAnswers,
  noteBody,
  notePreviewOf,
  noteQuestions,
  openAs,
  scheduleFields,
  taskFields,
  transcriptData,
  transcriptOutput,
  type Binding,
  type FieldBindings,
} from './contexts';
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
  author: NoteAuthor;
  text: string;
  createdAt: string;
  unreadable: boolean;
}

export type ListedTask = BoardTask & { lastNote: LastNote | null };

export interface ThreadNote {
  id: string;
  text: string;
  createdAt: string;
  author: NoteAuthor;
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

async function tryOpenJson<T>(
  keys: Keys,
  binding: Binding,
  value: string,
  check: (json: unknown) => T,
): Promise<T | undefined> {
  const text = await tryOpen(keys, binding, value);
  if (text === undefined) return undefined;
  try {
    return check(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Opens the title, prompt and directory of a task or schedule. A field that cannot be opened (or a directory that is not an
 * absolute path) is listed in `unreadable` and replaced: the title by a placeholder, the prompt by nothing, the directory
 * by none. The same rules as the CLI's.
 */
async function openFields(
  keys: Keys,
  wire: SealedFields,
  bindings: FieldBindings,
): Promise<SealedFields & { unreadable: UnreadableField[] }> {
  const [title, input, workdir] = await Promise.all([
    tryOpen(keys, bindings.title, wire.title),
    tryOpen(keys, bindings.input, wire.input),
    wire.workdir === null ? null : tryOpen(keys, bindings.workdir, wire.workdir),
  ]);
  const unreadable: UnreadableField[] = [];
  if (title === undefined) unreadable.push('title');
  if (input === undefined) unreadable.push('input');
  const validWorkdir = workdir === undefined || workdir === null || workdir.startsWith('/');
  if (!validWorkdir || workdir === undefined) unreadable.push('workdir');
  return {
    title: title ?? UNREADABLE_TITLE,
    input: input ?? '',
    workdir: workdir !== undefined && validWorkdir ? workdir : null,
    unreadable,
  };
}

export async function openBoardTask(keys: Keys, wire: WireBoardTask): Promise<BoardTask> {
  const fields = await openFields(keys, wire, taskFields());
  return { ...wire, ...fields, labels: taskLabels({ input: fields.input, createdBy: wire.createdBy }) };
}

/**
 * The newest note's preview. A server event is plain text; any other preview is sealed with the task id, and one that
 * cannot be opened shows as a placeholder, never as text.
 */
async function openLastNote(keys: Keys, taskId: string, wire: WireLastNote): Promise<LastNote> {
  const base = { kind: wire.kind, createdAt: wire.createdAt };
  if (wire.author === 'server')
    return {
      ...base,
      author: 'system',
      text: wire.kind === 'event' ? (wire.preview ?? '') : '',
      unreadable: wire.kind !== 'event',
    };
  if (wire.preview === null) return { ...base, author: wire.author, text: '', unreadable: false };
  const text = await tryOpen(keys, notePreviewOf(taskId), wire.preview);
  return { ...base, author: wire.author, text: text ?? UNREADABLE_TEXT, unreadable: text === undefined };
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

/**
 * The server's own events (author "server") are plain text and shown as system notes. Any other note is opened; one that
 * cannot be opened, or whose questions or answers do not parse, comes back `unreadable` with no text.
 */
async function openThreadNote(keys: Keys, taskId: string, wire: WireThreadNote): Promise<ThreadNote> {
  const base = { id: wire.id, createdAt: wire.createdAt, kind: wire.kind, by: wire.by };
  if (wire.author === 'server')
    return {
      ...base,
      text: wire.kind === 'event' ? wire.body : '',
      author: 'system',
      unreadable: wire.kind !== 'event',
    };
  const [text, questions, answers] = await Promise.all([
    tryOpen(keys, noteBody(taskId), wire.body),
    wire.questions === undefined ? null : tryOpenJson(keys, noteQuestions(taskId), wire.questions, parseQuestions),
    wire.answers === undefined
      ? null
      : tryOpenJson(keys, noteAnswers(taskId), wire.answers, (json) => parseAnswers(undefined, json)),
  ]);
  return {
    ...base,
    text: text ?? '',
    author: wire.author,
    unreadable: text === undefined || questions === undefined || answers === undefined,
    ...(questions ? { questions } : {}),
    ...(answers ? { answers } : {}),
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
  return { ...wire, ...(await openFields(keys, wire, scheduleFields())) };
}

export async function openSchedules(keys: Keys, wire: WireSchedule[]): Promise<Schedule[]> {
  return Promise.all(wire.map((schedule) => openSchedule(keys, schedule)));
}

/** An event that cannot be opened becomes a note saying so, so the rest of the run still reads. */
export async function openEvent(keys: Keys, runId: string, wire: WireEvent): Promise<TranscriptEventView> {
  const text = await tryOpen(keys, transcriptData(runId, wire.seq), wire.data);
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
  return (await tryOpen(keys, transcriptOutput(runId, seq), wire)) ?? UNREADABLE_TEXT;
}
