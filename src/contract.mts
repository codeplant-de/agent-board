// The vocabulary shared by the core and every backend. The README documents it as the backend spec.
import { isRecord } from "./guards.mts";

export const CONTRACT_VERSION = 1;
// A backend exits with this code (EX_USAGE) for a subcommand it does not implement.
export const UNKNOWN_COMMAND_EXIT = 64;

export const STATUSES = ["todo", "running", "needs-me", "done"] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  input: string;
  labels: string[];
  status: Status;
  url: string;
  closed: boolean;
}

export interface Note {
  text: string;
  createdAt: Date;
}

export interface TaskDraft {
  title: string;
  input: string;
  labels: string[];
  status: Status;
}

export interface TaskPatch {
  status?: Status;
  input?: string;
}

export interface Backend {
  // Open tasks in priority order (first is the top); `all` adds closed ones.
  listTasks(options?: { all?: boolean }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  addTask(draft: TaskDraft): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  addNote(id: string, text: string): Promise<void>;
  // Oldest first.
  readNotes(id: string): Promise<Note[]>;
  // What it created; undefined when the backend has no setup.
  setup(labels: string[]): Promise<string[] | undefined>;
}

export class ContractError extends Error {}

// The id ends up in a systemd unit name, a log file name and argv, so the core never trusts a backend's.
export function isSafeTaskId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}

export function isStatus(value: unknown): value is Status {
  return STATUSES.some((status) => status === value);
}

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

function status(obj: Record<string, unknown>, what: string): Status {
  const value = obj["status"];
  if (!isStatus(value)) throw new ContractError(`${what}.status must be one of ${STATUSES.join(", ")}`);
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

export function parseTask(value: unknown): Task {
  const obj = record(value, "task");
  const id = string(obj, "id", "task");
  if (!isSafeTaskId(id)) throw new ContractError(`task id "${id.slice(0, 40)}" is not safe (letters, digits, - and _, at most 64)`);
  const closed = obj["closed"];
  if (typeof closed !== "boolean") throw new ContractError("task.closed must be a boolean");
  return {
    id,
    title: string(obj, "title", "task"),
    input: string(obj, "input", "task"),
    labels: labels(obj, "task"),
    status: status(obj, "task"),
    url: string(obj, "url", "task"),
    closed,
  };
}

export function parseTasks(value: unknown): Task[] {
  if (!Array.isArray(value)) throw new ContractError("expected a JSON array of tasks");
  return value.map(parseTask);
}

export function parseNotes(value: unknown): Note[] {
  if (!Array.isArray(value)) throw new ContractError("expected a JSON array of notes");
  return value.map((item) => {
    const obj = record(item, "note");
    const createdAt = new Date(string(obj, "createdAt", "note"));
    if (Number.isNaN(createdAt.getTime())) throw new ContractError("note.createdAt is not a date");
    return { text: string(obj, "text", "note"), createdAt };
  });
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
  rejectUnknownKeys(obj, ["title", "input", "labels", "status"], "draft");
  const title = string(obj, "title", "draft");
  if (title.trim() === "") throw new ContractError("draft.title must not be empty");
  return {
    title,
    input: "input" in obj ? string(obj, "input", "draft") : "",
    labels: "labels" in obj ? labels(obj, "draft") : [],
    status: "status" in obj ? status(obj, "draft") : "todo",
  };
}

// Stdin of update-task. At least one of `status` and `input`.
export function parsePatch(value: unknown): TaskPatch {
  const obj = record(value, "patch");
  rejectUnknownKeys(obj, ["status", "input"], "patch");
  if (!("status" in obj) && !("input" in obj)) throw new ContractError("patch needs status or input");
  const patch: TaskPatch = {};
  if ("status" in obj) patch.status = status(obj, "patch");
  if ("input" in obj) patch.input = string(obj, "input", "patch");
  return patch;
}

// Stdin of setup.
export function parseSetupRequest(value: unknown): string[] {
  return labels(record(value, "setup request"), "setup request");
}
