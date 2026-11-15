// How board content is sealed and opened, for the CLI and the browser alike. The server keeps no key and reads nothing, so
// what a client acts on or shows as trusted is exactly what a client of the user sealed *for that purpose*: every sealed
// value is bound, through the context of its envelope, to the row it belongs to. The table of (field, context) rules is in
// docs/encryption.md; this module is its one implementation.
//
//   field          context
//   title          <origin>
//   input          <origin>:<creator>
//   workdir        <origin>, or for a scheduled task also task:<id>:schedule:<scheduleId> (the worker's rewrite)
//   pr             task:<id>:agent (the PR URL the task's agent reported)
//   note.*         note:<taskId>:<author>:<kind>
//   tr.*           <taskId>:<runId>:<seq>
//
// <origin> is task:<id> for a task, schedule:<id> for a schedule and for a task that is an occurrence of one (the server
// copies the schedule's ciphertext into it); <creator> is who made the task: intake, user or agent.
//
// The plumbing stays with the callers: `Sealer` and `Opener` seal and open one value (the browser memoises opening), and
// everything here is the rules around them. A value that does not open under exactly its binding is unreadable, and an
// unreadable value is never replaced by a looser reading.
import {
  ContractError,
  isSafeWorkdir,
  NOTE_SUGGESTION_CHARS,
  notePreview,
  SEALED_LIMITS,
  UNREADABLE_TITLE,
} from './contract.mts';
import type { NoteKind, TaskCreator, UnreadableField, WireNoteAuthor, WireNoteInput } from './contract.mts';
import { blindIndex } from './crypto.mts';
import type { Field, Keys } from './crypto.mts';
import { isServerEventText } from './events.mts';
import { isPrUrl } from './prompt.mts';
import { parseAnswers, parseQuestions, QuestionError } from './questions.mts';
import type { Answer, Question } from './questions.mts';

export interface Binding {
  field: Field;
  context: string;
}

/** Seals one value under its binding. */
export type Sealer = (binding: Binding, plaintext: string) => Promise<string>;

/** Opens one value under its binding; undefined when it cannot be opened: plain text, another key, another binding, damage. */
export type Opener = (binding: Binding, value: string) => Promise<string | undefined>;

export type RowRef =
  { kind: 'task'; id: string; createdBy: TaskCreator; scheduleId: string | null } | { kind: 'schedule'; id: string };

// The creator an occurrence has: the server makes it as the user's.
const SCHEDULE_CREATOR: TaskCreator = 'user';

function origin(row: RowRef): string {
  if (row.kind === 'schedule') return `schedule:${row.id}`;
  return row.scheduleId === null ? `task:${row.id}` : `schedule:${row.scheduleId}`;
}

const creatorOf = (row: RowRef): TaskCreator => (row.kind === 'schedule' ? SCHEDULE_CREATOR : row.createdBy);

export const titleBinding = (row: RowRef): Binding => ({ field: 'title', context: origin(row) });

export const inputBinding = (row: RowRef): Binding => ({ field: 'input', context: `${origin(row)}:${creatorOf(row)}` });

/** The binding a new directory is sealed under: an occurrence's own rewrite names its schedule, so it is only an occurrence's. */
export function workdirBinding(row: RowRef): Binding {
  if (row.kind === 'task' && row.scheduleId !== null)
    return { field: 'workdir', context: `task:${row.id}:schedule:${row.scheduleId}` };
  return { field: 'workdir', context: origin(row) };
}

/** The bindings a directory opens under: its own, and for an occurrence also the schedule's (which the server copied). */
export function workdirOpenBindings(row: RowRef): Binding[] {
  if (row.kind === 'task' && row.scheduleId !== null)
    return [{ field: 'workdir', context: origin(row) }, workdirBinding(row)];
  return [workdirBinding(row)];
}

/** The PR URL an agent reports for its task: bound to the task and to the agent, so nothing else's ciphertext opens as one. */
export const prBinding = (taskId: string): Binding => ({ field: 'pr', context: `task:${taskId}:agent` });

/** Seals the PR URL the agent of `taskId` opened; refuses anything that is not a GitHub pull request URL. */
export async function sealPr(seal: Sealer, taskId: string, url: string): Promise<string> {
  if (!isPrUrl(url))
    throw new ContractError('the pull request must be a URL like https://github.com/<owner>/<repo>/pull/<number>');
  return sealChecked(seal, prBinding(taskId), url, 'the pull request');
}

/** The PR URL of a task, or null when there is none or what opens is not a GitHub PR URL. */
export async function openPr(open: Opener, taskId: string, wire: string | null | undefined): Promise<string | null> {
  if (wire === null || wire === undefined) return null;
  const url = await open(prBinding(taskId), wire);
  return url !== undefined && isPrUrl(url) ? url : null;
}

// A note is bound to its task, its author and its kind, so one author's text can never be served as another's.
export function noteBinding(
  field: 'note.body' | 'note.preview' | 'note.suggestion' | 'note.questions' | 'note.answers',
  taskId: string,
  author: WireNoteAuthor,
  kind: NoteKind,
): Binding {
  return { field, context: `note:${taskId}:${author}:${kind}` };
}

/** The (author, kind) pairs a client writes; a sealed note of any other pair is unreadable. */
const NOTE_PAIRS: Record<Exclude<WireNoteAuthor, 'server'>, readonly NoteKind[]> = {
  agent: ['comment', 'question', 'polish'],
  system: ['event'],
  user: ['comment', 'answer', 'event'],
};

/** A transcript event is bound to its task as well as its run, so the server cannot show one task's run under another. */
export const transcriptBinding = (
  field: 'tr.data' | 'tr.output',
  taskId: string,
  runId: string,
  seq: number,
): Binding => ({
  field,
  context: `${taskId}:${runId}:${seq}`,
});

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Seals a value, after checking it fits what the board takes for the field; the error names the limit. */
export async function sealChecked(seal: Sealer, binding: Binding, plaintext: string, what: string): Promise<string> {
  const limit = SEALED_LIMITS[binding.field];
  const size = utf8Bytes(plaintext);
  if (size > limit)
    throw new ContractError(`${what} is too long: ${size} bytes of UTF-8, and the board takes at most ${limit}`);
  return seal(binding, plaintext);
}

/** A task's `dedupeKey` as the board stores it: the blind index of the key itself (the PR URL, for intake). */
export const dedupeKeyIndex = (keys: Keys, key: string): Promise<string> => blindIndex(keys, key);

/** A task's `head` as the board stores it: the blind index of `head:<sha>`, which is what intake compares with. */
export const headIndex = (keys: Keys, sha: string): Promise<string> => blindIndex(keys, `head:${sha}`);

export interface SealedFields {
  title: string;
  input: string;
  workdir?: string;
}

export const sealTitle = (seal: Sealer, row: RowRef, text: string): Promise<string> =>
  sealChecked(seal, titleBinding(row), text, 'the title');

export const sealInput = (seal: Sealer, row: RowRef, text: string): Promise<string> =>
  sealChecked(seal, inputBinding(row), text, 'the prompt');

export const sealWorkdir = (seal: Sealer, row: RowRef, text: string): Promise<string> =>
  sealChecked(seal, workdirBinding(row), text, 'the directory');

export async function sealFields(
  seal: Sealer,
  row: RowRef,
  fields: { title: string; input: string; workdir?: string | undefined },
): Promise<SealedFields> {
  return {
    title: await sealTitle(seal, row, fields.title),
    input: await sealInput(seal, row, fields.input),
    ...(fields.workdir === undefined ? {} : { workdir: await sealWorkdir(seal, row, fields.workdir) }),
  };
}

export async function sealNote(
  seal: Sealer,
  note: { taskId: string; author: Exclude<WireNoteAuthor, 'server'>; kind: NoteKind },
  text: string,
  // `previewSource` is what the preview is cut from, when that is not the note's text itself.
  options: { suggestion?: string; previewSource?: string } = {},
): Promise<WireNoteInput> {
  const { taskId, author, kind } = note;
  const { suggestion, previewSource = text } = options;
  const preview = notePreview(previewSource);
  if (suggestion !== undefined) {
    if (author !== 'agent' || kind !== 'comment')
      throw new ContractError('only a comment by the agent can carry a suggestion');
    if (suggestion.trim() === '') throw new ContractError('the suggestion is empty');
    if (Array.from(suggestion).length > NOTE_SUGGESTION_CHARS)
      throw new ContractError(`the suggestion is too long: at most ${NOTE_SUGGESTION_CHARS} characters`);
  }
  return {
    body: await sealChecked(seal, noteBinding('note.body', taskId, author, kind), text, 'the note'),
    ...(preview === null
      ? {}
      : {
          preview: await sealChecked(seal, noteBinding('note.preview', taskId, author, kind), preview, 'the preview'),
        }),
    ...(suggestion === undefined
      ? {}
      : {
          suggestion: await sealChecked(
            seal,
            noteBinding('note.suggestion', taskId, author, kind),
            suggestion,
            'the suggestion',
          ),
        }),
  };
}

export async function sealQuestions(
  seal: Sealer,
  taskId: string,
  questions: Question[],
): Promise<{ body: string; questions: string }> {
  return {
    body: await sealChecked(seal, noteBinding('note.body', taskId, 'agent', 'question'), '', 'the question'),
    questions: await sealChecked(
      seal,
      noteBinding('note.questions', taskId, 'agent', 'question'),
      JSON.stringify(parseQuestions(questions)),
      'the questions',
    ),
  };
}

/**
 * The user's answers, sealed together with the questions they were shown in one envelope, so that what the agent is later told
 * comes from that envelope alone. Throws a `QuestionError` when the answers do not fit the questions.
 */
export async function sealAnswers(
  seal: Sealer,
  taskId: string,
  questions: Question[],
  answers: Answer[],
): Promise<string> {
  const checked = parseAnswers(questions, answers);
  return sealChecked(
    seal,
    noteBinding('note.answers', taskId, 'user', 'answer'),
    JSON.stringify({ questions, answers: checked }),
    'the answers',
  );
}

export interface OpenedFields {
  title: string;
  input: string;
  workdir: string | null;
  unreadable: UnreadableField[];
}

async function openFirst(open: Opener, bindings: Binding[], value: string): Promise<string | undefined> {
  for (const binding of bindings) {
    const text = await open(binding, value);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * Opens the title, input and directory of a task or schedule. A field that cannot be opened under its binding (or a directory
 * that is not a safe absolute path) is listed in `unreadable` and replaced: the title by a placeholder, the input by an empty
 * prompt, the directory by none. A task with an unreadable input or directory must never be run.
 */
export async function openFields(
  open: Opener,
  row: RowRef,
  wire: { title: string; input: string; workdir?: string | null | undefined },
): Promise<OpenedFields> {
  const [title, input, workdir] = await Promise.all([
    open(titleBinding(row), wire.title),
    open(inputBinding(row), wire.input),
    wire.workdir == null ? null : openFirst(open, workdirOpenBindings(row), wire.workdir),
  ]);
  const unreadable: UnreadableField[] = [];
  if (title === undefined) unreadable.push('title');
  if (input === undefined) unreadable.push('input');
  const validWorkdir = workdir === undefined || workdir === null || isSafeWorkdir(workdir);
  if (!validWorkdir || workdir === undefined) unreadable.push('workdir');
  return {
    title: title ?? UNREADABLE_TITLE,
    input: input ?? '',
    workdir: workdir !== undefined && validWorkdir ? workdir : null,
    unreadable,
  };
}

export interface WireNoteParts {
  author: WireNoteAuthor;
  kind: NoteKind;
  body: string;
  preview: string | null;
  questions?: string | undefined;
  answers?: string | undefined;
  suggestion?: string | undefined;
}

export interface OpenedNote {
  // Empty when `unreadable`.
  text: string;
  author: WireNoteAuthor;
  unreadable: boolean;
  // A question note's questions; an answer note's own copy of the questions it answered.
  questions?: Question[];
  answers?: Answer[];
  // A comment by the agent: the reply it drafted for the user.
  suggestion?: string;
}

async function openJson<T>(
  open: Opener,
  binding: Binding,
  value: string,
  check: (json: unknown) => T,
): Promise<T | undefined> {
  const text = await open(binding, value);
  if (text === undefined) return undefined;
  try {
    return check(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof QuestionError) return undefined;
    throw error;
  }
}

function openAnswerEnvelope(json: unknown): { questions: Question[]; answers: Answer[] } {
  if (typeof json !== 'object' || json === null || !('questions' in json) || !('answers' in json))
    throw new QuestionError('an answer envelope holds the questions and the answers');
  const questions = parseQuestions(json.questions);
  return { questions, answers: parseAnswers(questions, json.answers) };
}

const isKnownPair = (author: WireNoteAuthor, kind: NoteKind): boolean =>
  author !== 'server' && NOTE_PAIRS[author].includes(kind);

/**
 * Opens a thread note. A server event is accepted only for one of the fixed texts (and as author "server"); any other note
 * must be an (author, kind) pair a client writes, and open under its own author and kind, with the questions or answers it
 * needs and nothing else. Otherwise it is unreadable, with no text, and never taken for what anyone wrote.
 */
export async function openNote(open: Opener, taskId: string, wire: WireNoteParts): Promise<OpenedNote> {
  const { author, kind } = wire;
  const unreadable: OpenedNote = { text: '', author, unreadable: true };
  if (author === 'server') {
    const plain = kind === 'event' && wire.questions === undefined && wire.answers === undefined;
    return plain && isServerEventText(wire.body) ? { text: wire.body, author, unreadable: false } : unreadable;
  }
  if (!isKnownPair(author, kind)) return unreadable;
  if ((wire.questions !== undefined) !== (kind === 'question')) return unreadable;
  if ((wire.answers !== undefined) !== (kind === 'answer')) return unreadable;
  if (wire.suggestion !== undefined && (author !== 'agent' || kind !== 'comment')) return unreadable;
  const [text, questions, envelope, suggestion] = await Promise.all([
    open(noteBinding('note.body', taskId, author, kind), wire.body),
    wire.questions === undefined
      ? null
      : openJson(open, noteBinding('note.questions', taskId, author, kind), wire.questions, parseQuestions),
    wire.answers === undefined
      ? null
      : openJson(open, noteBinding('note.answers', taskId, author, kind), wire.answers, openAnswerEnvelope),
    wire.suggestion === undefined ? null : open(noteBinding('note.suggestion', taskId, author, kind), wire.suggestion),
  ]);
  if (text === undefined || questions === undefined || envelope === undefined || suggestion === undefined)
    return unreadable;
  return {
    text,
    author,
    unreadable: false,
    ...(questions ? { questions } : {}),
    ...(envelope ? { questions: envelope.questions, answers: envelope.answers } : {}),
    ...(suggestion === null ? {} : { suggestion }),
  };
}

/**
 * The text a board card shows for the newest note: a server event's own text when it is one of the fixed ones, otherwise the
 * sealed preview opened under the note's binding. An unreadable one has `text` undefined, for the client to put its
 * placeholder there.
 */
export async function openPreview(
  open: Opener,
  taskId: string,
  wire: { author: WireNoteAuthor; kind: NoteKind; preview: string | null },
): Promise<{ text: string | undefined; unreadable: boolean }> {
  const { author, kind, preview } = wire;
  if (author === 'server')
    return kind === 'event' && preview !== null && isServerEventText(preview)
      ? { text: preview, unreadable: false }
      : { text: undefined, unreadable: true };
  if (!isKnownPair(author, kind)) return { text: undefined, unreadable: true };
  if (preview === null) return { text: '', unreadable: false };
  const text = await open(noteBinding('note.preview', taskId, author, kind), preview);
  return { text, unreadable: text === undefined };
}
