// The vocabulary shared by the CLI, the server and the UI. The README documents it as the backend contract.
import { isRecord, isStringList } from './guards.mts';
import { parseQuestions, parseAnswers } from './questions.mts';
import type { Answer, Question } from './questions.mts';
import type { TranscriptBatch } from './transcript.mts';

export const CONTRACT_VERSION = 5;

export const STATUSES = ['backlog', 'todo', 'running', 'needs-me', 'done'] as const;
export type Status = (typeof STATUSES)[number];

// What the next run of a task does: start over, or resume the Claude session of the last run with the user's reply.
export const NEXT_RUNS = ['fresh', 'resume'] as const;
export type NextRun = (typeof NEXT_RUNS)[number];

export const NOTE_AUTHORS = ['agent', 'user', 'system'] as const;
export type NoteAuthor = (typeof NOTE_AUTHORS)[number];

export const NOTE_KINDS = ['comment', 'question', 'answer', 'event'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

// Highest first: a column lists its tasks by priority, then by their manual order, and workers pick up from the top.
export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const DEFAULT_PRIORITY: Priority = 'normal';

// A running task whose agent has been quiet this long looks stuck: the board shows it red.
export const QUIET_LIMIT_MS = 10 * 60_000;

// The server lets you take a running task back after this much quiet. Longer than the red text: one long tool call is
// quiet for minutes, and a live worker gives up at `inactivityMinutes` (15 by default) plus the sweep's grace.
export const TAKE_BACK_AFTER_MS = 20 * 60_000;

export const TASK_CREATORS = ['intake', 'user', 'agent'] as const;
export type TaskCreator = (typeof TASK_CREATORS)[number];

export interface Task {
  id: string;
  title: string;
  input: string;
  labels: string[];
  status: Status;
  priority: Priority;
  url: string;
  closed: boolean;
  // The machine that claimed the task last; a resume runs only there, because the Claude session lives on it.
  machine: string | null;
  // The Claude session of the last skill run.
  sessionId: string | null;
  // The directory that session was in when it last stopped, on `machine`: a worktree it entered, say. A resume starts there.
  workdir: string | null;
  next: NextRun;
  // The PR head sha (7 to 40 hex characters) the task was made for; intake's review tasks only.
  head: string | null;
  // The last question the agent asked has no answer yet.
  openQuestion: boolean;
  // Who made it. Intake's tasks run with intake's narrow permissions; the others as the user.
  createdBy: TaskCreator;
  // While it runs: the lane of the machine that runs it, whether that lane borrowed it, and the agent's last tool call.
  lane: string | null;
  borrowed: boolean;
  lastActiveAt: Date | null;
  // While it runs: when the worker claimed it; otherwise null.
  runStartedAt: Date | null;
  // The last run gave up its slot (`pause`) and the task has not run since. Set by `pause`, kept through the claim so the
  // worker that resumes it can see it, and cleared by that worker's first `update-task` of the run or by the task leaving
  // Running another way. A worker that reads `paused: true` on its claimed task tells the agent it was paused.
  paused: boolean;
  // Todo only: no worker may claim the task before this time. Cleared when the task leaves Todo.
  notBefore: Date | null;
}

export interface Heartbeat {
  lane: string;
  borrowed: boolean;
}

export interface Note {
  id: string;
  text: string;
  createdAt: Date;
  author: NoteAuthor;
  kind: NoteKind;
  // kind "question": what was asked.
  questions?: Question[];
  // kind "answer": one answer per question of the note `questionNoteId`, in order.
  answers?: Answer[];
  questionNoteId?: string;
}

export interface TaskDraft {
  title: string;
  input: string;
  labels: string[];
  // Default: todo. A task an agent proposes is always created in needs-me, whatever it names.
  status?: Status;
  // Default: the parent's priority for a follow-up, otherwise normal.
  priority?: Priority;
  // Unique per board: a second add-task with the same key returns the first task instead of a new one.
  dedupeKey?: string;
  parentId?: string;
  createdBy?: TaskCreator;
  // Pins the task to a machine and the directory it runs in there (where it was scheduled from).
  machine?: string;
  workdir?: string;
  head?: string;
  // Only with status todo.
  notBefore?: Date;
}

export interface TaskPatch {
  status?: Status;
  priority?: Priority;
  input?: string;
  sessionId?: string | null;
  workdir?: string | null;
  next?: NextRun;
  head?: string | null;
  // Only on a todo task; null starts the wait over: the task is claimable now.
  notBefore?: Date | null;
  // Applies the patch only while the task has this status; otherwise the server answers 409 and writes nothing.
  expect?: Status;
}

export interface AddTaskResult {
  task: Task;
  created: boolean;
}

export interface FailResult {
  // False when the task was no longer running (or was closed): nothing changed.
  applied: boolean;
  task: Task;
}

export interface Backend {
  // Open tasks in priority order (first is the top); `all` adds closed ones.
  listTasks(options?: { all?: boolean }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  addTask(draft: TaskDraft): Promise<AddTaskResult>;
  // With `patch.expect`, a task of another status is left alone and the call throws an error with status 409.
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  // Moves a todo task to running for `machine`; undefined when another caller got it first or it is pinned elsewhere.
  claimTask(id: string, machine: string): Promise<Task | undefined>;
  addNote(id: string, text: string, options?: { author?: 'agent' | 'system' }): Promise<void>;
  // Adds a question note and moves the task to needs-me.
  ask(id: string, questions: Question[]): Promise<void>;
  // The agent of a running task is alive: sets lastActiveAt to now, with the lane it runs in.
  heartbeat(id: string, beat: Heartbeat): Promise<void>;
  // A running task gave up its slot: a note, then back to Todo, resumed next, ahead of new work.
  pause(id: string, note: string): Promise<Task>;
  // A run failed: if the task is still running (and not closed), adds the text as a system event and moves it to needs-me, in one step.
  fail(id: string, text: string): Promise<FailResult>;
  // Appends events to a run's transcript; an event already stored (same run and seq) is kept as it is.
  transcript(id: string, batch: TranscriptBatch): Promise<void>;
  // Oldest first.
  readNotes(id: string): Promise<Note[]>;
}

export class ContractError extends Error {}

// "dispatch" and "intake" would make the worker unit agent-board-<id> collide with the tool's own units.
const RESERVED_TASK_IDS = ['dispatch', 'intake'];

// The id ends up in a systemd unit name, a log file name and argv, so the CLI checks every id it reads from the board or its arguments.
export function isSafeTaskId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) && !RESERVED_TASK_IDS.includes(id);
}

// A machine name travels in argv and is shown in the UI.
export function isSafeMachineName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name);
}

// The url lands inside a Slack link, where `<`, `>` and `|` end the link early.
export function isSafeTaskUrl(url: string): boolean {
  return /^https?:\/\/[^\s<>|]+$/.test(url);
}

function oneOf<T extends string>(values: readonly T[]): (value: unknown) => value is T {
  return (value: unknown): value is T => values.some((candidate) => candidate === value);
}

export const isStatus = oneOf(STATUSES);
export const isNextRun = oneOf(NEXT_RUNS);
export const isNoteAuthor = oneOf(NOTE_AUTHORS);
export const isNoteKind = oneOf(NOTE_KINDS);
export const isTaskCreator = oneOf(TASK_CREATORS);
export const isPriority = oneOf(PRIORITIES);

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ContractError(`${what} must be a JSON object`);
  return value;
}

function string(obj: Record<string, unknown>, key: string, what: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw new ContractError(`${what}.${key} must be a string`);
  return value;
}

function nullableString(obj: Record<string, unknown>, key: string, what: string): string | null {
  const value = obj[key];
  if (value !== null && typeof value !== 'string') throw new ContractError(`${what}.${key} must be a string or null`);
  return value;
}

function nullableDate(obj: Record<string, unknown>, key: string, what: string): Date | null {
  const value = nullableString(obj, key, what);
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ContractError(`${what}.${key} is not a date`);
  return date;
}

function date(obj: Record<string, unknown>, key: string, what: string): Date {
  const value = nullableDate(obj, key, what);
  if (value === null) throw new ContractError(`${what}.${key} must be a date`);
  return value;
}

function boolean(obj: Record<string, unknown>, key: string, what: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') throw new ContractError(`${what}.${key} must be a boolean`);
  return value;
}

function member<T extends string>(obj: Record<string, unknown>, key: string, what: string, values: readonly T[]): T {
  const value = obj[key];
  if (!oneOf(values)(value)) throw new ContractError(`${what}.${key} must be one of ${values.join(', ')}`);
  return value;
}

function head(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,40}$/i.test(value))
    throw new ContractError(`${what}.head must be 7 to 40 hex characters`);
  return value;
}

function labels(obj: Record<string, unknown>, what: string): string[] {
  const value = obj['labels'];
  if (!isStringList(value)) throw new ContractError(`${what}.labels must be a list of strings`);
  return value;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], what: string): void {
  const extra = Object.keys(obj).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new ContractError(`${what} has an unknown key "${extra}"`);
}

function safeId(id: string, what: string): string {
  if (!isSafeTaskId(id))
    throw new ContractError(
      `${what} "${id.slice(0, 40)}" is not safe (letters, digits, - and _, at most 64, not "dispatch" or "intake")`,
    );
  return id;
}

export function parseTask(value: unknown): Task {
  const obj = record(value, 'task');
  const id = safeId(string(obj, 'id', 'task'), 'task id');
  const url = string(obj, 'url', 'task');
  if (!isSafeTaskUrl(url))
    throw new ContractError(`task url "${url.slice(0, 40)}" must be an http(s) URL without spaces, <, > or |`);
  const machine = nullableString(obj, 'machine', 'task');
  if (machine !== null && !isSafeMachineName(machine))
    throw new ContractError(`task machine "${machine.slice(0, 40)}" is not a safe name`);
  return {
    id,
    title: string(obj, 'title', 'task'),
    input: string(obj, 'input', 'task'),
    labels: labels(obj, 'task'),
    status: member(obj, 'status', 'task', STATUSES),
    priority: member(obj, 'priority', 'task', PRIORITIES),
    url,
    closed: boolean(obj, 'closed', 'task'),
    machine,
    sessionId: nullableString(obj, 'sessionId', 'task'),
    workdir: nullableString(obj, 'workdir', 'task'),
    next: member(obj, 'next', 'task', NEXT_RUNS),
    head: obj['head'] === null ? null : head(obj['head'], 'task'),
    openQuestion: boolean(obj, 'openQuestion', 'task'),
    createdBy: member(obj, 'createdBy', 'task', TASK_CREATORS),
    lane: nullableString(obj, 'lane', 'task'),
    borrowed: boolean(obj, 'borrowed', 'task'),
    lastActiveAt: nullableDate(obj, 'lastActiveAt', 'task'),
    runStartedAt: nullableDate(obj, 'runStartedAt', 'task'),
    paused: boolean(obj, 'paused', 'task'),
    notBefore: nullableDate(obj, 'notBefore', 'task'),
  };
}

export function parseTasks(value: unknown): Task[] {
  if (!Array.isArray(value)) throw new ContractError('expected a JSON array of tasks');
  return value.map(parseTask);
}

export function parseAddTaskResult(value: unknown): AddTaskResult {
  const obj = record(value, 'add-task result');
  return { task: parseTask(obj['task']), created: boolean(obj, 'created', 'add-task result') };
}

export function parseFailResult(value: unknown): FailResult {
  const obj = record(value, 'fail result');
  return { applied: boolean(obj, 'applied', 'fail result'), task: parseTask(obj['task']) };
}

export function parseNote(value: unknown): Note {
  const obj = record(value, 'note');
  const createdAt = new Date(string(obj, 'createdAt', 'note'));
  if (Number.isNaN(createdAt.getTime())) throw new ContractError('note.createdAt is not a date');
  const note: Note = {
    id: string(obj, 'id', 'note'),
    text: string(obj, 'text', 'note'),
    createdAt,
    author: member(obj, 'author', 'note', NOTE_AUTHORS),
    kind: member(obj, 'kind', 'note', NOTE_KINDS),
  };
  if (note.kind === 'question') note.questions = parseQuestions(obj['questions']);
  if (note.kind === 'answer') {
    note.questionNoteId = string(obj, 'questionNoteId', 'note');
    if (!Array.isArray(obj['answers'])) throw new ContractError('note.answers must be a list');
    // The answers were checked against their questions when they were given; here only their shape.
    note.answers = parseAnswers(undefined, obj['answers']);
  }
  return note;
}

export function parseNotes(value: unknown): Note[] {
  if (!Array.isArray(value)) throw new ContractError('expected a JSON array of notes');
  return value.map(parseNote);
}

// The JSON form of a note, as `read-notes` sends it.
export function serializeNote(note: Note): Record<string, unknown> {
  return { ...note, createdAt: note.createdAt.toISOString() };
}

export function parseVersion(value: unknown): number {
  const contract = record(value, 'version')['contract'];
  if (typeof contract !== 'number') throw new ContractError('version.contract must be a number');
  return contract;
}

// Body of add-task. Only `title` is required.
export function parseDraft(value: unknown): TaskDraft {
  const obj = record(value, 'draft');
  rejectUnknownKeys(
    obj,
    [
      'title',
      'input',
      'labels',
      'status',
      'priority',
      'dedupeKey',
      'parentId',
      'createdBy',
      'machine',
      'workdir',
      'head',
      'notBefore',
    ],
    'draft',
  );
  const title = string(obj, 'title', 'draft');
  if (title.trim() === '') throw new ContractError('draft.title must not be empty');
  const draft: TaskDraft = {
    title,
    input: 'input' in obj ? string(obj, 'input', 'draft') : '',
    labels: 'labels' in obj ? labels(obj, 'draft') : [],
    status: 'status' in obj ? member(obj, 'status', 'draft', STATUSES) : 'todo',
  };
  if ('priority' in obj) draft.priority = member(obj, 'priority', 'draft', PRIORITIES);
  if ('dedupeKey' in obj) {
    draft.dedupeKey = string(obj, 'dedupeKey', 'draft');
    if (draft.dedupeKey === '') throw new ContractError('draft.dedupeKey must not be empty');
  }
  if ('parentId' in obj) draft.parentId = safeId(string(obj, 'parentId', 'draft'), 'draft.parentId');
  if ('createdBy' in obj) draft.createdBy = member(obj, 'createdBy', 'draft', TASK_CREATORS);
  if ('machine' in obj) {
    draft.machine = string(obj, 'machine', 'draft');
    if (!isSafeMachineName(draft.machine)) throw new ContractError('draft.machine is not a safe name');
  }
  if ('workdir' in obj) {
    draft.workdir = string(obj, 'workdir', 'draft');
    if (!draft.workdir.startsWith('/')) throw new ContractError('draft.workdir must be an absolute path');
  }
  if ('head' in obj) draft.head = head(obj['head'], 'draft');
  if ('notBefore' in obj) {
    draft.notBefore = date(obj, 'notBefore', 'draft');
    if (draft.status !== 'todo') throw new ContractError('draft.notBefore needs status todo');
  }
  if ((draft.machine === undefined) !== (draft.workdir === undefined))
    throw new ContractError('draft.machine and draft.workdir go together');
  return draft;
}

// Body of update-task. At least one key.
export function parsePatch(value: unknown): TaskPatch {
  const obj = record(value, 'patch');
  const keys = ['status', 'priority', 'input', 'sessionId', 'workdir', 'next', 'head', 'notBefore'];
  rejectUnknownKeys(obj, [...keys, 'expect'], 'patch');
  if (!keys.some((key) => key in obj)) throw new ContractError(`patch needs one of ${keys.join(', ')}`);
  const patch: TaskPatch = {};
  if ('status' in obj) patch.status = member(obj, 'status', 'patch', STATUSES);
  if ('priority' in obj) patch.priority = member(obj, 'priority', 'patch', PRIORITIES);
  if ('expect' in obj) patch.expect = member(obj, 'expect', 'patch', STATUSES);
  if ('input' in obj) patch.input = string(obj, 'input', 'patch');
  if ('sessionId' in obj) patch.sessionId = nullableString(obj, 'sessionId', 'patch');
  if ('next' in obj) patch.next = member(obj, 'next', 'patch', NEXT_RUNS);
  if ('head' in obj) patch.head = obj['head'] === null ? null : head(obj['head'], 'patch');
  if ('notBefore' in obj) patch.notBefore = nullableDate(obj, 'notBefore', 'patch');
  if ('workdir' in obj) {
    patch.workdir = nullableString(obj, 'workdir', 'patch');
    if (patch.workdir !== null && !patch.workdir.startsWith('/'))
      throw new ContractError('patch.workdir must be an absolute path');
  }
  return patch;
}

// Body of heartbeat.
export function parseHeartbeat(value: unknown): Heartbeat {
  const obj = record(value, 'heartbeat');
  rejectUnknownKeys(obj, ['lane', 'borrowed'], 'heartbeat');
  const lane = string(obj, 'lane', 'heartbeat');
  if (!isSafeMachineName(lane))
    throw new ContractError("heartbeat.lane must be a name of letters, digits, '.', '-' and '_'");
  return { lane, borrowed: boolean(obj, 'borrowed', 'heartbeat') };
}

// The JSON form of a task, as the machine API sends it.
export function serializeTask(task: Task): Record<string, unknown> {
  return {
    ...task,
    lastActiveAt: task.lastActiveAt?.toISOString() ?? null,
    runStartedAt: task.runStartedAt?.toISOString() ?? null,
    notBefore: task.notBefore?.toISOString() ?? null,
  };
}

/**
 * The skill a task's prompt starts with: `/review-pr 17741` → "review-pr", `/pr-review:review-pr x` → "pr-review:review-pr".
 * Undefined for a prompt that does not start with one.
 */
export function promptSkill(input: string): string | undefined {
  return /^\s*\/([A-Za-z0-9][A-Za-z0-9:_.-]*)(?=\s|$)/.exec(input)?.[1];
}

// A skill's name without its plugin: `pr-review:review-pr` → "review-pr".
export function shortSkill(skill: string): string {
  return skill.includes(':') ? skill.slice(skill.lastIndexOf(':') + 1) : skill;
}
