// The vocabulary shared by the core, the server, the UI and every backend. The README documents it as the backend spec.
import { isRecord } from "./guards.mts";
import { parseQuestions, parseAnswers } from "./questions.mts";
import type { Answer, Question } from "./questions.mts";

export const CONTRACT_VERSION = 2;
// A backend exits with this code (EX_USAGE) for a subcommand it does not implement.
export const UNKNOWN_COMMAND_EXIT = 64;
// A backend exits with this code (EX_TEMPFAIL) when `claim-task` loses: the task is no longer free for this machine.
export const CLAIM_LOST_EXIT = 75;

export const STATUSES = ["todo", "running", "needs-me", "done"] as const;
export type Status = (typeof STATUSES)[number];

// What the next run of a task does: start over, or resume the Claude session of the last run with the user's reply.
export const NEXT_RUNS = ["fresh", "resume"] as const;
export type NextRun = (typeof NEXT_RUNS)[number];

export const NOTE_AUTHORS = ["agent", "user", "system"] as const;
export type NoteAuthor = (typeof NOTE_AUTHORS)[number];

export const NOTE_KINDS = ["comment", "question", "answer", "event"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const TASK_CREATORS = ["intake", "user", "agent"] as const;
export type TaskCreator = (typeof TASK_CREATORS)[number];

export interface Task {
  id: string;
  title: string;
  input: string;
  labels: string[];
  status: Status;
  url: string;
  closed: boolean;
  // The machine that claimed the task last; a resume runs only there, because the Claude session lives on it.
  machine: string | null;
  // The Claude session of the last skill run.
  sessionId: string | null;
  next: NextRun;
  // The last question the agent asked has no answer yet.
  openQuestion: boolean;
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
  status: Status;
  // Unique per board: a second add-task with the same key returns the first task instead of a new one.
  dedupeKey?: string;
  parentId?: string;
  createdBy?: TaskCreator;
}

export interface TaskPatch {
  status?: Status;
  input?: string;
  sessionId?: string | null;
  next?: NextRun;
}

export interface AddTaskResult {
  task: Task;
  created: boolean;
}

export interface Backend {
  // Open tasks in priority order (first is the top); `all` adds closed ones.
  listTasks(options?: { all?: boolean }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  addTask(draft: TaskDraft): Promise<AddTaskResult>;
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  // Moves a todo task to running for `machine`; undefined when another caller got it first or it is pinned elsewhere.
  claimTask(id: string, machine: string): Promise<Task | undefined>;
  addNote(id: string, text: string, options?: { author?: "agent" | "system" }): Promise<void>;
  // Adds a question note and moves the task to needs-me.
  ask(id: string, questions: Question[]): Promise<void>;
  // Oldest first.
  readNotes(id: string): Promise<Note[]>;
  // What it created (with dryRun: what it would create, writing nothing); undefined when the backend has no setup.
  setup(labels: string[], options?: { dryRun?: boolean }): Promise<string[] | undefined>;
}

export class ContractError extends Error {}

// "dispatch" and "intake" would make the worker unit agent-board-<id> collide with the tool's own units.
const RESERVED_TASK_IDS = ["dispatch", "intake"];

// The id ends up in a systemd unit name, a log file name and argv, so the core never trusts a backend's.
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

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ContractError(`${what} must be a JSON object`);
  return value;
}

function string(obj: Record<string, unknown>, key: string, what: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw new ContractError(`${what}.${key} must be a string`);
  return value;
}

function nullableString(obj: Record<string, unknown>, key: string, what: string): string | null {
  const value = obj[key];
  if (value !== null && typeof value !== "string") throw new ContractError(`${what}.${key} must be a string or null`);
  return value;
}

function boolean(obj: Record<string, unknown>, key: string, what: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") throw new ContractError(`${what}.${key} must be a boolean`);
  return value;
}

function member<T extends string>(obj: Record<string, unknown>, key: string, what: string, values: readonly T[]): T {
  const value = obj[key];
  if (!oneOf(values)(value)) throw new ContractError(`${what}.${key} must be one of ${values.join(", ")}`);
  return value;
}

function labels(obj: Record<string, unknown>, what: string): string[] {
  const value = obj["labels"];
  if (!isStringList(value)) throw new ContractError(`${what}.labels must be a list of strings`);
  return value;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], what: string): void {
  const extra = Object.keys(obj).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new ContractError(`${what} has an unknown key "${extra}"`);
}

function safeId(id: string, what: string): string {
  if (!isSafeTaskId(id)) throw new ContractError(`${what} "${id.slice(0, 40)}" is not safe (letters, digits, - and _, at most 64, not "dispatch" or "intake")`);
  return id;
}

export function parseTask(value: unknown): Task {
  const obj = record(value, "task");
  const id = safeId(string(obj, "id", "task"), "task id");
  const url = string(obj, "url", "task");
  if (!isSafeTaskUrl(url)) throw new ContractError(`task url "${url.slice(0, 40)}" must be an http(s) URL without spaces, <, > or |`);
  const machine = nullableString(obj, "machine", "task");
  if (machine !== null && !isSafeMachineName(machine)) throw new ContractError(`task machine "${machine.slice(0, 40)}" is not a safe name`);
  return {
    id,
    title: string(obj, "title", "task"),
    input: string(obj, "input", "task"),
    labels: labels(obj, "task"),
    status: member(obj, "status", "task", STATUSES),
    url,
    closed: boolean(obj, "closed", "task"),
    machine,
    sessionId: nullableString(obj, "sessionId", "task"),
    next: member(obj, "next", "task", NEXT_RUNS),
    openQuestion: boolean(obj, "openQuestion", "task"),
  };
}

export function parseTasks(value: unknown): Task[] {
  if (!Array.isArray(value)) throw new ContractError("expected a JSON array of tasks");
  return value.map(parseTask);
}

export function parseAddTaskResult(value: unknown): AddTaskResult {
  const obj = record(value, "add-task result");
  return { task: parseTask(obj["task"]), created: boolean(obj, "created", "add-task result") };
}

export function parseNote(value: unknown): Note {
  const obj = record(value, "note");
  const createdAt = new Date(string(obj, "createdAt", "note"));
  if (Number.isNaN(createdAt.getTime())) throw new ContractError("note.createdAt is not a date");
  const note: Note = {
    id: string(obj, "id", "note"),
    text: string(obj, "text", "note"),
    createdAt,
    author: member(obj, "author", "note", NOTE_AUTHORS),
    kind: member(obj, "kind", "note", NOTE_KINDS),
  };
  if (note.kind === "question") note.questions = parseQuestions(obj["questions"]);
  if (note.kind === "answer") {
    note.questionNoteId = string(obj, "questionNoteId", "note");
    if (!Array.isArray(obj["answers"])) throw new ContractError("note.answers must be a list");
    // The answers were checked against their questions when they were given; here only their shape.
    note.answers = parseAnswers(undefined, obj["answers"]);
  }
  return note;
}

export function parseNotes(value: unknown): Note[] {
  if (!Array.isArray(value)) throw new ContractError("expected a JSON array of notes");
  return value.map(parseNote);
}

// The JSON form of a note, as `read-notes` prints it.
export function serializeNote(note: Note): Record<string, unknown> {
  return { ...note, createdAt: note.createdAt.toISOString() };
}

export function parseVersion(value: unknown): number {
  const contract = record(value, "version")["contract"];
  if (typeof contract !== "number") throw new ContractError("version.contract must be a number");
  return contract;
}

export function parseSetupResult(value: unknown): string[] {
  const created = record(value, "setup result")["created"];
  if (!isStringList(created)) throw new ContractError("setup result.created must be a list of strings");
  return created;
}

// Stdin of add-task. Only `title` is required.
export function parseDraft(value: unknown): TaskDraft {
  const obj = record(value, "draft");
  rejectUnknownKeys(obj, ["title", "input", "labels", "status", "dedupeKey", "parentId", "createdBy"], "draft");
  const title = string(obj, "title", "draft");
  if (title.trim() === "") throw new ContractError("draft.title must not be empty");
  const draft: TaskDraft = {
    title,
    input: "input" in obj ? string(obj, "input", "draft") : "",
    labels: "labels" in obj ? labels(obj, "draft") : [],
    status: "status" in obj ? member(obj, "status", "draft", STATUSES) : "todo",
  };
  if ("dedupeKey" in obj) {
    draft.dedupeKey = string(obj, "dedupeKey", "draft");
    if (draft.dedupeKey === "") throw new ContractError("draft.dedupeKey must not be empty");
  }
  if ("parentId" in obj) draft.parentId = safeId(string(obj, "parentId", "draft"), "draft.parentId");
  if ("createdBy" in obj) draft.createdBy = member(obj, "createdBy", "draft", TASK_CREATORS);
  return draft;
}

// Stdin of update-task. At least one key.
export function parsePatch(value: unknown): TaskPatch {
  const obj = record(value, "patch");
  const keys = ["status", "input", "sessionId", "next"];
  rejectUnknownKeys(obj, keys, "patch");
  if (!keys.some((key) => key in obj)) throw new ContractError(`patch needs one of ${keys.join(", ")}`);
  const patch: TaskPatch = {};
  if ("status" in obj) patch.status = member(obj, "status", "patch", STATUSES);
  if ("input" in obj) patch.input = string(obj, "input", "patch");
  if ("sessionId" in obj) patch.sessionId = nullableString(obj, "sessionId", "patch");
  if ("next" in obj) patch.next = member(obj, "next", "patch", NEXT_RUNS);
  return patch;
}

// Stdin of setup.
export function parseSetupRequest(value: unknown): string[] {
  return labels(record(value, "setup request"), "setup request");
}
