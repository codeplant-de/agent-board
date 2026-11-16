// The vocabulary shared by the CLI, the server and the UI. docs/machine-api.md documents it.
import { envelopeLength, isBlindIndex, isEnvelope } from './crypto.mts';
import type { Field } from './crypto.mts';
import { isRecord } from './guards.mts';
import { isKeyId } from './keys.mts';
import type { Answer, Question } from './questions.mts';
import type { TranscriptBatch, WireTranscriptBatch } from './transcript.mts';

// What an installed CLI up to 0.7.0 compares exactly. The server reports it as max(LEGACY_CONTRACT, MIN_CLIENT): it stays 9
// until the first breaking change, which then refuses those CLIs as well. Never change this number.
export const LEGACY_CONTRACT = 9;

// The break level of the wire, not a count of changes: it rises only with a change an older client cannot survive. An
// additive change adds a feature name (features.mts) and touches none of the three numbers. They start at 9, the
// contract number of the servers and CLIs out there, so a server that answers no `api` (its contract is taken as both ends) fits.
export const API_VERSION = 9;
// The oldest client break level the server serves. One line, read by scripts/check-cli-release.sh.
export const MIN_CLIENT = 9;
// The oldest server break level this CLI works with.
export const MIN_SERVER = 9;

export const STATUSES = ['backlog', 'todo', 'running', 'waiting', 'needs-me', 'done'] as const;
export type Status = (typeof STATUSES)[number];
// Where a new task may start. Running and Waiting need a run behind them and Done a close, which only their own commands do.
export const DRAFT_STATUSES = ['backlog', 'todo', 'needs-me'] as const satisfies readonly Status[];
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

// What the next run of a task does: start over, or resume the Claude session of the last run with the user's reply.
export const NEXT_RUNS = ['fresh', 'resume'] as const;
export type NextRun = (typeof NEXT_RUNS)[number];

export const PR_STATES = ['open', 'merged', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

export const NOTE_AUTHORS = ['agent', 'user', 'system'] as const;
export type NoteAuthor = (typeof NOTE_AUTHORS)[number];

// On the wire a fourth author exists: "server" marks the events the board server writes itself ("Marked done.") and is
// the only author whose note body is plain text, and only the fixed texts of `events.mts`. Everything else is sealed.
// Clients keep the author: a server event is never shown as a "system" note.
export const WIRE_NOTE_AUTHORS = [...NOTE_AUTHORS, 'server'] as const;
export type WireNoteAuthor = (typeof WIRE_NOTE_AUTHORS)[number];

export const NOTE_KINDS = ['comment', 'question', 'answer', 'event', 'polish'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

// Highest first: a column lists its tasks by priority, then by their manual order, and workers pick up from the top.
export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const DEFAULT_PRIORITY: Priority = 'normal';

// The aliases the board offers for a task's Claude model; any name that `isModelName` accepts may be used, a full id included.
export const MODEL_ALIASES = [
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
] as const;

// A running task whose agent has been quiet this long looks stuck: the board shows it red.
export const QUIET_LIMIT_MS = 10 * 60_000;

// The server lets you take a running task back after this much quiet. Longer than the red text: one long tool call is
// quiet for minutes, and a live worker gives up at `inactivityMinutes` (15 by default) plus the sweep's grace.
export const TAKE_BACK_AFTER_MS = 20 * 60_000;

// How far ahead an agent may set a wait's end: the longest it can park a task in Waiting.
export const MAX_WAIT_MS = 7 * 24 * 60 * 60_000;

// The largest count the database holds in an `integer` column (a schedule's runs left, a transcript event's seq).
export const MAX_INT32 = 2_147_483_647;

// The longest interval a schedule may repeat at; far beyond it, the date arithmetic of the next run breaks.
export const MAX_INTERVAL_MS = 10 * 365 * 24 * 60 * 60_000;

export const TASK_CREATORS = ['intake', 'user', 'agent'] as const;
export type TaskCreator = (typeof TASK_CREATORS)[number];

// The sealed fields of a task or schedule a client may find it cannot read.
export type UnreadableField = 'title' | 'input' | 'workdir' | 'agent';

// What a client shows where it could not open a title or a text. Never used as data: an unreadable input is empty, and
// the task's `unreadable` list says so.
export const UNREADABLE_TITLE = '(cannot decrypt this title)';
export const UNREADABLE_TEXT = '(cannot decrypt this text)';

export interface Task {
  id: string;
  // The readable fields below hold a placeholder (title), an empty string (input) or null (workdir) when the client could
  // not open them; `unreadable` names those fields. A task whose input or workdir is unreadable must never be run.
  title: string;
  input: string;
  // Derived from the prompt and the creator by `taskLabels`; the board does not store them.
  labels: string[];
  status: Status;
  priority: Priority;
  // The Claude model the runs use (`claude --model`): an alias or a full id; null is claude's default. A clear value from the
  // server, so a worker shape-checks it with `isModelName` again before it reaches argv.
  model: string | null;
  // The agent of the machine's config.json the task runs as, by name; null or absent for none. Sealed on the wire, and part
  // of the context of `input`, so a task whose agent the server dropped or changed is unreadable. A worker that sees one runs
  // only that agent, or not at all.
  agent?: string | null;
  closed: boolean;
  // The machine that claimed the task last; a resume runs only there, because the Claude session lives on it.
  machine: string | null;
  // The Claude session of the last skill run.
  sessionId: string | null;
  // The directory that session was in when it last stopped, on `machine`: a worktree it entered, say. A resume starts there.
  workdir: string | null;
  next: NextRun;
  // The blind index (`abh1.…`) of the PR head sha the task was made for; set by a script that schedules with `--version` (and by the removed built-in intake). The board never holds
  // the sha itself; `Backend.indexHead` gives the value to compare it with.
  head: string | null;
  // The last question the agent asked has no answer yet.
  openQuestion: boolean;
  // Who made it. "intake" is only on tasks of the removed built-in intake: with an agent they run as it, without one they never run. "agent" is a proposal the user has
  // not started: nothing runs it. Starting it makes it "user" (the client seals the prompt again for that creator).
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
  // The schedule this task is an occurrence of; set by the server, never by a draft or a patch.
  scheduleId: string | null;
  // Waiting only: when the wait ends at the latest (a timer's end, a check's timeout). Cleared when the task leaves Waiting.
  wakeAt: Date | null;
  // Waiting only: the wait ends early when a check on `machine` passes; false for a plain timer.
  waitCheck: boolean;
  // The task left Waiting for Todo (its wait ended) and has not run since. Like `paused`, kept through the claim so the
  // worker that resumes it can tell the agent, and cleared by that worker's first `update-task` of the run.
  woken: boolean;
  // The PR the task's agent reported with `board pr`; null for none, or for one that is not a GitHub PR URL.
  pr: string | null;
  // GitHub's state of the task's PR (`statePrOf`) as a worker's dispatcher last saw it; null while unknown. Clear, not sealed: it tells the
  // board only that some PR of the task merged, never which.
  prState: PrState | null;
  // While it runs: the user asked for the run to be interrupted and no worker has acted on it yet. Absent from a server
  // without the `run-inbox` feature.
  stopRequested?: boolean;
  unreadable: UnreadableField[];
}

// An agent's wait: the task leaves Running for Waiting and frees its slot until `wakeAt`, or until a check passes.
export interface WaitRequest {
  // Shown in the thread as the agent's comment: what it waits for.
  text: string;
  wakeAt: Date;
  // A check command on the task's machine may end the wait early; the command itself never leaves the machine.
  check: boolean;
}

export interface Heartbeat {
  lane: string;
  borrowed: boolean;
}

export interface Note {
  id: string;
  // Empty when `unreadable`.
  text: string;
  createdAt: Date;
  author: WireNoteAuthor;
  kind: NoteKind;
  // The text, the questions or the answers could not be opened: the note is not to be used as the user's words.
  unreadable: boolean;
  // kind "question": what was asked. kind "answer": the questions the user was shown, from the answer's own envelope.
  questions?: Question[];
  // kind "answer": one answer per question of `questions`, in order.
  answers?: Answer[];
  // Where the server says the answer belongs; for display only, never used to find the questions.
  questionNoteId?: string;
  // kind "comment" by the agent: a ready-to-send reply in the user's voice, for the user to use or edit.
  suggestion?: string;
  // A message the user sent to the running agent that no worker has handed over yet.
  pending?: boolean;
  // When a worker handed the message to the running agent (`ack-messages`); a resume prompt does not repeat it.
  deliveredAt?: Date;
  // The user wrote it to a running agent. Never cleared: a resume carries the ones that were never handed over, wherever they
  // fall in the thread.
  queued?: boolean;
}

// What the user sent to a running task since the worker last looked: stop asks the worker to interrupt the run, and the
// messages (oldest first) are for it to hand to the agent.
export interface RunInbox {
  stop: boolean;
  // With `stop`: the message that belongs to the request (Stop & send), among `messages`. Without it the stop is plain: the
  // run ends, and the pending messages stay pending.
  stopMessage?: string;
  messages: Note[];
}

export interface AckMessages {
  // Messages handed to the agent; they stop being pending.
  ids: string[];
  // The worker acted on the stop request: it is cleared, so one request is acted on once.
  stop?: boolean;
}

export interface TaskDraft {
  // The task's id, chosen by the client because its sealed fields are bound to it; the sealing backend makes one when it is absent.
  id?: string;
  title: string;
  input: string;
  // Default: todo. A task an agent proposes is always created in backlog, whatever it names.
  status?: DraftStatus;
  // Default: the parent's priority for a follow-up, otherwise normal.
  priority?: Priority;
  // Default: claude's default model.
  model?: string;
  // Unique per board: a second add-task with the same key returns the first task instead of a new one. The CLI sends the
  // blind index of the key, never the key.
  dedupeKey?: string;
  parentId?: string;
  createdBy?: TaskCreator;
  // Pins the task to a machine and the directory it runs in there (where it was scheduled from).
  machine?: string;
  workdir?: string;
  // The agent the task runs as (sealed on the wire); the sealer of `input` states it too, so it is part of that context.
  agent?: string;
  // The PR head sha; the sealing backend turns it into its blind index.
  head?: string;
  // Only with status todo.
  notBefore?: Date;
}

// What the writer of a patch knows about the task it seals for, which the contexts of the sealed fields depend on. Never sent.
export interface PatchSealing {
  // Who made the task. The writer of a new `input` states it itself, never taking it from the board.
  createdBy: TaskCreator;
  scheduleId: string | null;
  // The task's agent as the writer opened it (null for none): a new `input` is sealed under it too, so it must be stated.
  agent: string | null;
}

export interface TaskPatch {
  status?: Status;
  priority?: Priority;
  // `input` and a `workdir` that is not null need `seal`.
  input?: string;
  sessionId?: string | null;
  workdir?: string | null;
  next?: NextRun;
  // A PR head sha; the sealing backend turns it into its blind index.
  head?: string | null;
  seal?: PatchSealing;
  // Only on a todo task; null starts the wait over: the task is claimable now.
  notBefore?: Date | null;
  // Applies the patch only while the task has this status; otherwise the server answers 409 and writes nothing.
  expect?: Status;
}

// A rule that produces delayed Todo tasks. It always has one pending occurrence: a task in Todo with `notBefore` at the
// next run time. The next one is created when that task leaves Todo (claimed, moved or closed), so a run that was missed
// while nothing claimed it is not repeated, and closing the pending task skips that run.
export interface Schedule {
  id: string;
  title: string;
  input: string;
  priority: Priority;
  // The model of every occurrence; null is claude's default.
  model: string | null;
  // Pins the occurrences to a machine and the directory they run in there.
  machine: string | null;
  workdir: string | null;
  // The agent every occurrence runs as, by name; null for none.
  agent?: string | null;
  // The rule: an interval on the grid `anchorAt + k * everyMs`, or a 5-field cron expression in `timezone`.
  everyMs: number | null;
  cron: string | null;
  timezone: string | null;
  // The first run of an interval; the earliest a cron expression matches.
  anchorAt: Date;
  // The pending occurrence's start time; null while paused (usually) or ended.
  nextRunAt: Date | null;
  // Occurrences still to be created after the pending one; null: forever.
  remaining: number | null;
  // No occurrence starts after this time.
  until: Date | null;
  paused: boolean;
  ended: boolean;
  // The pending occurrence.
  occurrenceTaskId: string | null;
  createdAt: Date;
  unreadable: UnreadableField[];
}

export interface ScheduleDraft {
  // The schedule's id, chosen by the client because its sealed fields are bound to it; the sealing backend makes one when it is absent.
  id?: string;
  title: string;
  input: string;
  priority?: Priority;
  // Default: claude's default model.
  model?: string;
  machine?: string;
  workdir?: string;
  // The agent every occurrence runs as (sealed on the wire).
  agent?: string;
  // Exactly one of `everyMs` and `cron`; a cron expression needs its `timezone` (IANA name).
  everyMs?: number;
  cron?: string;
  timezone?: string;
  // The first run (interval) or the time to match from (cron). Default: now.
  startAt?: Date;
  // The number of occurrences in all; at most one of `times` and `until`. Default: forever.
  times?: number;
  until?: Date;
}

export interface SchedulePatch {
  paused: boolean;
}

export interface AddScheduleResult {
  schedule: Schedule;
  // The pending occurrence.
  task: Task;
}

export interface AddTaskResult {
  task: Task;
  created: boolean;
}

// The result of `wake`: false when the task was no longer waiting (or was closed): nothing changed.
export interface WakeResult {
  applied: boolean;
  task: Task;
}

export interface FailResult {
  // False when the task was no longer running (or was closed): nothing changed.
  applied: boolean;
  task: Task;
}

/** The plaintext view of the board that the CLI works with; `sealingBackend` makes it from a `WireBackend`. */
export interface Backend {
  // Open tasks in priority order (first is the top); `all` adds closed ones.
  listTasks(options?: { all?: boolean }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  // The session of a task and the directory it ended in, for the machine whose token ran it; the server refuses with 409 (running, or no session) or 403 (another machine).
  attachSession(id: string): Promise<{ sessionId: string; workdir: string | null }>;
  addTask(draft: TaskDraft): Promise<AddTaskResult>;
  // With `patch.expect`, a task of another status is left alone and the call throws an error with status 409.
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  // Moves a todo task to running for `machine`; undefined when another caller got it first or it is pinned elsewhere.
  claimTask(id: string, machine: string): Promise<Task | undefined>;
  // A `suggestion` (agent comments only) is the reply the user will most likely send next; a `polish` note is a rewritten prompt.
  addNote(
    id: string,
    text: string,
    options?: { author?: 'agent' | 'system'; kind?: 'comment' | 'polish'; suggestion?: string },
  ): Promise<void>;
  // Adds a question note and moves the task to needs-me.
  ask(id: string, questions: Question[]): Promise<void>;
  // The agent of a running task is alive: sets lastActiveAt to now, with the lane it runs in.
  heartbeat(id: string, beat: Heartbeat): Promise<void>;
  // A running task gave up its slot: a note, then back to Todo, resumed next, ahead of new work.
  pause(id: string, note: string): Promise<Task>;
  // A run failed: if the task is still running (and not closed), adds the text as a system event and moves it to needs-me, in one step.
  fail(id: string, text: string): Promise<FailResult>;
  // A running task waits: the text as the agent's comment, then Waiting until `wakeAt` or a passed check. Frees the slot.
  wait(id: string, request: WaitRequest): Promise<Task>;
  // A wait ended: if the task is still waiting (and not closed), adds the text as a system event and moves it to the top of
  // Todo, resumed next in its session, in one step.
  wake(id: string, text: string): Promise<WakeResult>;
  // The user's stop request and pending messages for a running task of this machine; the server refuses with 409 when the
  // task is not running and 403 for another machine's task.
  runInbox(id: string): Promise<RunInbox>;
  // Marks messages as handed to the agent and, with `stop`, the stop request as acted on.
  ackMessages(id: string, ack: AckMessages): Promise<void>;
  // The run was ended on the user's request: while the task still runs, adds the text as a system event and moves it to
  // needs-me (or, with messages that were not handed over, back to Todo to resume with them).
  stopped(id: string, text: string): Promise<Task>;
  // Appends events to a run's transcript; an event already stored (same run and seq) is kept as it is.
  transcript(id: string, batch: TranscriptBatch): Promise<void>;
  // Oldest first.
  readNotes(id: string): Promise<Note[]>;
  // Creates the schedule and its first occurrence; the server rejects a cron expression it cannot read.
  addSchedule(draft: ScheduleDraft): Promise<AddScheduleResult>;
  listSchedules(): Promise<Schedule[]>;
  // Pausing removes the pending occurrence if it never ran; resuming creates the next one.
  updateSchedule(id: string, patch: SchedulePatch): Promise<Schedule>;
  // Removes a schedule and its never-run pending occurrence; tasks that ran keep their history and their `scheduleId`.
  removeSchedule(id: string): Promise<void>;
  // The value `Task.head` has for a PR head sha: the board holds only a blind index of it.
  indexHead(sha: string): Promise<string>;
  // The agent of a task reports the PR it opened for it; the last one wins. `url` must be a GitHub PR URL.
  setPr(id: string, url: string): Promise<void>;
  // A worker's dispatcher records GitHub's state of the task's PR (`statePrOf`).
  setPrState(id: string, prState: PrState): Promise<void>;
  // Whether the board holds `dirs` as this machine's directory list, by comparing blind indexes; 'unsupported' for a server without the feature.
  checkDirs(machine: string, dirs: readonly MachineDir[]): Promise<DirsOnBoard>;
  // Replaces the board's copy of this machine's directory list. The copy is advice for the New task form and is never read back by a CLI.
  setDirs(machine: string, dirs: readonly MachineDir[]): Promise<void>;
}

/** A directory the machine lists in its config, with the label it gave it (`isSafeDirLabel`). */
export interface MachineDir {
  path: string;
  label?: string;
}

export type DirsOnBoard = 'unsupported' | 'current' | 'stale';

// What the board server stores and returns: the sealed fields are envelopes (`abe1.…`) it cannot read. Values the server
// returns may also be legacy plain text from before encryption; only what a client sends is checked to be sealed.

type SealedTaskFields = 'title' | 'input' | 'workdir' | 'agent' | 'pr' | 'labels' | 'unreadable';

// `pr` is the sealed "pr", or null; a server without the `task.pr` feature leaves it out, and without `task.pr-state`
// it leaves out `prState`. `agent` is the sealed "agent"; the server leaves it out of a task without one.
export type WireTask = Omit<Task, SealedTaskFields> & {
  title: string;
  input: string;
  workdir: string | null;
  agent?: string | null;
  pr: string | null;
};

export type WireSchedule = Omit<Schedule, 'title' | 'input' | 'workdir' | 'agent' | 'unreadable'> & {
  title: string;
  input: string;
  workdir: string | null;
  agent?: string | null;
};

export interface WireNote {
  id: string;
  // Sealed with the field "note.body", bound to the task, the author and the kind, except on a "server" note, whose body is
  // plain text from the fixed list of `events.mts`.
  body: string;
  // Sealed "note.preview" (the start of the plain text), or null for a note without text.
  preview: string | null;
  createdAt: Date;
  author: WireNoteAuthor;
  kind: NoteKind;
  // kind "question": sealed JSON of the Question list ("note.questions").
  questions?: string;
  // kind "answer": sealed JSON of the questions the user was shown and the answers ("note.answers").
  answers?: string;
  questionNoteId?: string;
  // Sealed "note.suggestion", on a comment by the agent only.
  suggestion?: string;
  // Absent on a server without the `run-inbox` feature.
  pending?: boolean;
  deliveredAt?: Date;
  queued?: boolean;
}

export interface WireRunInbox {
  stop: boolean;
  stopMessage?: string;
  messages: WireNote[];
}

// A task draft with its id; title, input and workdir are sealed, dedupeKey and head are blind indexes.
export type WireTaskDraft = Omit<TaskDraft, 'id'> & { id: string };
// A task patch; input and workdir are sealed, head is a blind index.
export type WireTaskPatch = Omit<TaskPatch, 'seal'>;
// A schedule draft with its id; title, input and workdir are sealed.
export type WireScheduleDraft = Omit<ScheduleDraft, 'id'> & { id: string };

export interface WireNoteInput {
  // Sealed note text; sealed empty text for a note without any.
  body: string;
  preview?: string | null;
  // Sealed "note.suggestion"; only an agent comment (add-note) may carry one.
  suggestion?: string;
}

// Body of set-pr: the sealed "pr".
export interface WirePr {
  pr: string;
}

// Body of set-pr-state.
export interface WirePrState {
  prState: PrState;
}

// Body of set-dirs: the sealed list ("machine.dirs") and the blind index of what it holds.
export interface WireDirs {
  dirs: string;
  index: string;
}

// What the `version` answer says of the calling machine's list.
export interface WireDirsState {
  supported: boolean;
  // The blind index the board holds for this machine's list; null when it holds none.
  index: string | null;
}

export interface WireAsk {
  // Sealed empty text: a question note carries its content in `questions`.
  body: string;
  questions: string;
}

export interface WireAddTaskResult {
  task: WireTask;
  created: boolean;
}

export interface WireWait {
  // Sealed note text and its sealed preview, as for add-note.
  body: string;
  preview?: string | null;
  wakeAt: Date;
  check: boolean;
}

export interface WireWakeResult {
  applied: boolean;
  task: WireTask;
}

export interface WireFailResult {
  applied: boolean;
  task: WireTask;
}

export interface WireAddScheduleResult {
  schedule: WireSchedule;
  task: WireTask;
}

/** `Backend` as the server sees it: the same calls with sealed values. */
export interface WireBackend {
  listTasks(options?: { all?: boolean }): Promise<WireTask[]>;
  getTask(id: string): Promise<WireTask>;
  attachSession(id: string): Promise<WireTask>;
  addTask(draft: WireTaskDraft): Promise<WireAddTaskResult>;
  updateTask(id: string, patch: WireTaskPatch): Promise<WireTask>;
  claimTask(id: string, machine: string): Promise<WireTask | undefined>;
  addNote(
    id: string,
    note: WireNoteInput,
    options?: { author?: 'agent' | 'system'; kind?: 'comment' | 'polish' },
  ): Promise<void>;
  ask(id: string, ask: WireAsk): Promise<void>;
  heartbeat(id: string, beat: Heartbeat): Promise<void>;
  pause(id: string, note: WireNoteInput): Promise<WireTask>;
  fail(id: string, note: WireNoteInput): Promise<WireFailResult>;
  wait(id: string, wait: WireWait): Promise<WireTask>;
  wake(id: string, note: WireNoteInput): Promise<WireWakeResult>;
  runInbox(id: string): Promise<WireRunInbox>;
  ackMessages(id: string, ack: AckMessages): Promise<void>;
  stopped(id: string, note: WireNoteInput): Promise<WireTask>;
  transcript(id: string, batch: WireTranscriptBatch): Promise<void>;
  readNotes(id: string): Promise<WireNote[]>;
  addSchedule(draft: WireScheduleDraft): Promise<WireAddScheduleResult>;
  listSchedules(): Promise<WireSchedule[]>;
  updateSchedule(id: string, patch: SchedulePatch): Promise<WireSchedule>;
  removeSchedule(id: string): Promise<void>;
  setPr(id: string, body: WirePr): Promise<void>;
  setPrState(id: string, body: WirePrState): Promise<void>;
  setDirs(body: WireDirs): Promise<void>;
  dirsState(): Promise<WireDirsState>;
}

// The characters of a suggested reply the board takes.
export const NOTE_SUGGESTION_CHARS = 2000;

// How much plaintext each sealed field may hold, in UTF-8 bytes: four times the characters the clients allow. The server
// cannot count characters in what it cannot read, so it bounds the envelope instead (see `envelopeLength`).
export const SEALED_LIMITS: Record<Field, number> = {
  title: 4 * 300,
  input: 4 * 200_000,
  workdir: 4096,
  agent: 256,
  pr: 1024,
  'machine.dirs': 256 * 1024,
  'note.body': 4 * 100_000,
  'note.preview': 4 * 300,
  'note.suggestion': 4 * NOTE_SUGGESTION_CHARS,
  'note.questions': 256 * 1024,
  'note.answers': 256 * 1024,
  'tr.data': 1024 * 1024,
  'tr.output': 4 * 256 * 1024 + 4096,
};

/** Throws when `text` is more UTF-8 than the board takes for `field`; the error names the size and the limit. */
export function checkSealedSize(field: Field, text: string, what: string): void {
  const limit = SEALED_LIMITS[field];
  const size = new TextEncoder().encode(text).length;
  if (size > limit)
    throw new ContractError(`${what} is too long: ${size} bytes of UTF-8, and the board takes at most ${limit}`);
}

// A tool result is cut at 256 KiB characters plus a short note; a client reporting more is lying or broken.
export const MAX_OUTPUT_SIZE = 256 * 1024 + 1024;

export class ContractError extends Error {}

// The CLI's own systemd units are agent-board-<name>, the same shape as a worker unit agent-board-<task id>,
// so these names can never be task ids. Add a name here before the CLI installs a unit with it; `intake` stays because machines
// that have not run `board setup` since the built-in intake was removed still have that unit.
export const TOOL_UNIT_NAMES = ['dispatch', 'intake', 'listen'] as const;
const RESERVED_TASK_IDS: readonly string[] = TOOL_UNIT_NAMES;

// The id ends up in a systemd unit name, a log file name and argv, so the CLI checks every id it reads from the board or its arguments.
export function isSafeTaskId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) && !RESERVED_TASK_IDS.includes(id);
}

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A new task or schedule id: 12 random characters, never a reserved one. The client chooses it, because its sealed fields are bound to it. */
export function newTaskId(): string {
  let id = '';
  while (id.length < 12) {
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(24)))
      if (byte < ID_ALPHABET.length * 4 && id.length < 12) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return id;
}

// The source of the machine-name pattern: the server events of `events.mts` match names with it too. The character set carries
// the protection (no space or punctuation, so a name cannot be a sentence); 64 characters is what every CLI before accepted, so
// no name that worked stops working, and it holds any host name (63 at most).
export const MACHINE_NAME_PATTERN = '[A-Za-z0-9][A-Za-z0-9_.-]{0,63}';
export const MACHINE_NAME_RULE =
  "1 to 64 characters: letters, digits, '.', '-' and '_', starting with a letter or digit";
const MACHINE_NAME = new RegExp(`^${MACHINE_NAME_PATTERN}$`);

// A machine name travels in argv and is shown in the UI.
export function isSafeMachineName(name: string): boolean {
  return MACHINE_NAME.test(name);
}

export const isSafeLane = isSafeMachineName;

export const AGENT_NAME_RULE =
  'lowercase letters, digits and dashes, at most 32 characters, starting with a letter or a digit';
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// The name of an agent of a machine's config.json; it reaches a CLI flag and a file there, so nothing else is taken.
export const isAgentName = (name: string): boolean => AGENT_NAME.test(name);

/** Whether a text holds a control character (the C0 ones and DEL): newlines and NULs that a line, a path or an argument must not carry. */
export function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

// The id of a Claude session, which the worker hands to `claude --resume`: only a UUID, so it can never read as a flag.
export function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// A directory a task runs in: absolute, without control characters, of a length a path can have.
export function isSafeWorkdir(path: string): boolean {
  return path.startsWith('/') && path.length <= 4096 && !hasControlCharacter(path);
}

export const DIR_LABEL_RULE = '1 to 64 characters, no control characters, no space around it';

// The short name a machine gives a listed directory: shown beside its path, so one line of plain text.
export function isSafeDirLabel(label: string): boolean {
  const length = Array.from(label).length;
  return length >= 1 && length <= 64 && label === label.trim() && !hasControlCharacter(label);
}

// The ids of notes and runs the server makes.
export function isSafeNoteId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// A text from the server that a parser keeps in clear: one line without control characters, bounded.
function isPlainLine(value: string, max: number): boolean {
  return value.length <= max && !hasControlCharacter(value);
}

const CRON_FIELD = /^(?:[0-9*/,#?\-LW]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|sun|mon|tue|wed|thu|fri|sat)+$/i;

/** A 5-field cron expression: its fields hold only digits, the cron symbols and month and day abbreviations, so it cannot carry a sentence. */
export function isCronExpression(value: string): boolean {
  const fields = value.trim().split(/ +/);
  return value.length <= 100 && fields.length === 5 && fields.every((field) => CRON_FIELD.test(field));
}

/** An IANA time zone name this runtime knows; anything else (a sentence without spaces included) is not one. */
export function isTimeZoneName(value: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// What a client shows where a value from the server is not of the shape the contract allows for it.
export const INVALID_VALUE = '(invalid)';

function oneOf<T extends string>(values: readonly T[]): (value: unknown) => value is T {
  return (value: unknown): value is T => values.some((candidate) => candidate === value);
}

export const isStatus = oneOf(STATUSES);
export const isDraftStatus = oneOf(DRAFT_STATUSES);
export const isNextRun = oneOf(NEXT_RUNS);
export const isWireNoteAuthor = oneOf(WIRE_NOTE_AUTHORS);
export const isNoteKind = oneOf(NOTE_KINDS);
export const isTaskCreator = oneOf(TASK_CREATORS);
export const isPriority = oneOf(PRIORITIES);

// The characters carry the protection: a model name reaches argv as one `--model=` argument and is shown in the UI. It fits
// the aliases (`opus`) and full ids (`claude-opus-5-5`, `claude-sonnet-5-5[1m]`).
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;

export function isModelName(value: string): boolean {
  return MODEL_NAME.test(value);
}

/** The server's one check of a sealed value: it is an envelope and within the field's size limit. */
export function parseSealed(value: unknown, field: Field, what: string): string {
  if (typeof value !== 'string') throw new ContractError(`${what} must be a string`);
  if (!isEnvelope(value)) throw new ContractError(`${what} must be encrypted (an "abe1." value)`);
  if (value.length > envelopeLength(SEALED_LIMITS[field])) throw new ContractError(`${what} is too long`);
  return value;
}

/** A dedupe key is the blind index of the real key, never the key itself. */
export function parseBlindIndex(value: unknown, what: string): string {
  if (typeof value !== 'string' || !isBlindIndex(value))
    throw new ContractError(`${what} must be a blind index ("abh1." value)`);
  return value;
}

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

/** The `model` of a task or schedule; a server that predates the key leaves it out, which means claude's default. */
function modelOf(obj: Record<string, unknown>, what: string): string | null {
  const value = obj['model'] ?? null;
  if (value !== null && !(typeof value === 'string' && isModelName(value)))
    throw new ContractError(`${what}.model is not a model name`);
  return value;
}

function modelName(obj: Record<string, unknown>, what: string): string {
  const value = obj['model'];
  if (typeof value !== 'string' || !isModelName(value)) throw new ContractError(`${what}.model is not a model name`);
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

function positiveInt(obj: Record<string, unknown>, key: string, what: string, max = Number.MAX_SAFE_INTEGER): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new ContractError(`${what}.${key} must be a positive integer`);
  if (value > max) throw new ContractError(`${what}.${key} must be at most ${max}`);
  return value;
}

function nullablePositiveInt(obj: Record<string, unknown>, key: string, what: string): number | null {
  return obj[key] === null ? null : positiveInt(obj, key, what);
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
  return parseBlindIndex(value, `${what}.head`);
}

/** What a parser may quote of a value it refuses: bounded and JSON-quoted, so it cannot read as anything else in an error. */
function quoted(value: string): string {
  return JSON.stringify(value.slice(0, 40));
}

function sessionId(value: string | null, what: string): string | null {
  if (value !== null && !isSessionId(value)) throw new ContractError(`${what}.sessionId must be a UUID or null`);
  return value;
}

export function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], what: string): void {
  const extra = Object.keys(obj).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new ContractError(`${what} has an unknown key "${extra}"`);
}

function safeId(id: string, what: string): string {
  if (!isSafeTaskId(id))
    throw new ContractError(
      `${what} ${quoted(id)} is not safe (letters, digits, - and _, at most 64, not "dispatch" or "intake")`,
    );
  return id;
}

/** A list element left out because one of its enum fields holds a value this build does not know. */
export interface SkippedItem {
  what: 'task' | 'note' | 'schedule';
  field: string;
  /** Bounded, so it is safe to print. */
  value: string;
}

export interface ListOptions {
  /** Called for each element left out; without it an unknown enum value fails the list like any other shape error. */
  onSkip?: (skipped: SkippedItem) => void;
}

/** Parses each element, leaving out the ones whose enum field is a string this build does not know, when `onSkip` is given. */
function skippingUnknown<T>(
  items: unknown[],
  { onSkip }: ListOptions,
  parse: (value: unknown) => T,
  what: SkippedItem['what'],
  enums: [field: string, values: readonly string[]][],
): T[] {
  const parsed: T[] = [];
  for (const item of items) {
    const unknown =
      onSkip !== undefined && isRecord(item)
        ? enums.flatMap(([field, values]) => {
            const value = item[field];
            return typeof value === 'string' && !values.includes(value) ? [{ field, value }] : [];
          })[0]
        : undefined;
    if (unknown === undefined) parsed.push(parse(item));
    else onSkip?.({ what, field: unknown.field, value: unknown.value.slice(0, 40) });
  }
  return parsed;
}

// What the server returns is parsed leniently: a sealed field is any string (it may be legacy plain text), and the
// client decides what it can open.

export function parseWireTask(value: unknown): WireTask {
  const obj = record(value, 'task');
  const id = safeId(string(obj, 'id', 'task'), 'task id');
  const machine = nullableString(obj, 'machine', 'task');
  if (machine !== null && !isSafeMachineName(machine))
    throw new ContractError(`task machine ${quoted(machine)} is not a safe name`);
  const lane = nullableString(obj, 'lane', 'task');
  if (lane !== null && !isSafeLane(lane)) throw new ContractError(`task lane ${quoted(lane)} is not a safe name`);
  return {
    id,
    title: string(obj, 'title', 'task'),
    input: string(obj, 'input', 'task'),
    status: member(obj, 'status', 'task', STATUSES),
    priority: member(obj, 'priority', 'task', PRIORITIES),
    model: modelOf(obj, 'task'),
    closed: boolean(obj, 'closed', 'task'),
    machine,
    sessionId: sessionId(nullableString(obj, 'sessionId', 'task'), 'task'),
    workdir: nullableString(obj, 'workdir', 'task'),
    ...(obj['agent'] == null ? {} : { agent: string(obj, 'agent', 'task') }),
    pr: obj['pr'] === undefined ? null : nullableString(obj, 'pr', 'task'),
    prState: PR_STATES.find((state) => state === obj['prState']) ?? null,
    next: member(obj, 'next', 'task', NEXT_RUNS),
    head: obj['head'] === null ? null : head(obj['head'], 'task'),
    openQuestion: boolean(obj, 'openQuestion', 'task'),
    createdBy: member(obj, 'createdBy', 'task', TASK_CREATORS),
    lane,
    borrowed: boolean(obj, 'borrowed', 'task'),
    lastActiveAt: nullableDate(obj, 'lastActiveAt', 'task'),
    runStartedAt: nullableDate(obj, 'runStartedAt', 'task'),
    paused: boolean(obj, 'paused', 'task'),
    notBefore: nullableDate(obj, 'notBefore', 'task'),
    scheduleId: obj['scheduleId'] === null ? null : safeId(string(obj, 'scheduleId', 'task'), 'task scheduleId'),
    wakeAt: nullableDate(obj, 'wakeAt', 'task'),
    waitCheck: boolean(obj, 'waitCheck', 'task'),
    woken: boolean(obj, 'woken', 'task'),
    ...(obj['stopRequested'] === undefined ? {} : { stopRequested: boolean(obj, 'stopRequested', 'task') }),
  };
}

export function parseWireTasks(value: unknown, options: ListOptions = {}): WireTask[] {
  if (!Array.isArray(value)) throw new ContractError('expected a JSON array of tasks');
  return skippingUnknown(value, options, parseWireTask, 'task', [
    ['status', STATUSES],
    ['priority', PRIORITIES],
    ['next', NEXT_RUNS],
    ['createdBy', TASK_CREATORS],
  ]);
}

export function parseWireAddTaskResult(value: unknown): WireAddTaskResult {
  const obj = record(value, 'add-task result');
  return { task: parseWireTask(obj['task']), created: boolean(obj, 'created', 'add-task result') };
}

export function parseWireWakeResult(value: unknown): WireWakeResult {
  const obj = record(value, 'wake result');
  return { applied: boolean(obj, 'applied', 'wake result'), task: parseWireTask(obj['task']) };
}

export function parseWireFailResult(value: unknown): WireFailResult {
  const obj = record(value, 'fail result');
  return { applied: boolean(obj, 'applied', 'fail result'), task: parseWireTask(obj['task']) };
}

export function parseWireSchedule(value: unknown): WireSchedule {
  const obj = record(value, 'schedule');
  const everyMs = nullablePositiveInt(obj, 'everyMs', 'schedule');
  const cron = nullableString(obj, 'cron', 'schedule');
  const timezone = nullableString(obj, 'timezone', 'schedule');
  if ((everyMs === null) === (cron === null)) throw new ContractError('schedule needs exactly one of everyMs and cron');
  if (cron !== null && timezone === null) throw new ContractError('schedule.timezone is required with cron');
  if (cron !== null && !isCronExpression(cron)) throw new ContractError('schedule.cron is not a cron expression');
  if (timezone !== null && !isTimeZoneName(timezone))
    throw new ContractError('schedule.timezone is not a time zone name');
  const machine = nullableString(obj, 'machine', 'schedule');
  if (machine !== null && !isSafeMachineName(machine))
    throw new ContractError(`schedule machine ${quoted(machine)} is not a safe name`);
  return {
    id: safeId(string(obj, 'id', 'schedule'), 'schedule id'),
    title: string(obj, 'title', 'schedule'),
    input: string(obj, 'input', 'schedule'),
    priority: member(obj, 'priority', 'schedule', PRIORITIES),
    model: modelOf(obj, 'schedule'),
    machine,
    workdir: nullableString(obj, 'workdir', 'schedule'),
    ...(obj['agent'] == null ? {} : { agent: string(obj, 'agent', 'schedule') }),
    everyMs,
    cron,
    timezone,
    anchorAt: date(obj, 'anchorAt', 'schedule'),
    nextRunAt: nullableDate(obj, 'nextRunAt', 'schedule'),
    remaining: obj['remaining'] === 0 ? 0 : nullablePositiveInt(obj, 'remaining', 'schedule'),
    until: nullableDate(obj, 'until', 'schedule'),
    paused: boolean(obj, 'paused', 'schedule'),
    ended: boolean(obj, 'ended', 'schedule'),
    occurrenceTaskId:
      obj['occurrenceTaskId'] === null
        ? null
        : safeId(string(obj, 'occurrenceTaskId', 'schedule'), 'schedule occurrenceTaskId'),
    createdAt: date(obj, 'createdAt', 'schedule'),
  };
}

export function parseWireSchedules(value: unknown, options: ListOptions = {}): WireSchedule[] {
  if (!Array.isArray(value)) throw new ContractError('expected a JSON array of schedules');
  return skippingUnknown(value, options, parseWireSchedule, 'schedule', [['priority', PRIORITIES]]);
}

export function parseWireAddScheduleResult(value: unknown): WireAddScheduleResult {
  const obj = record(value, 'add-schedule result');
  return { schedule: parseWireSchedule(obj['schedule']), task: parseWireTask(obj['task']) };
}

// The JSON form of a schedule, as the machine API sends it.
export function serializeSchedule(schedule: WireSchedule): Record<string, unknown> {
  return {
    ...schedule,
    anchorAt: schedule.anchorAt.toISOString(),
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    until: schedule.until?.toISOString() ?? null,
    createdAt: schedule.createdAt.toISOString(),
  };
}

export function parseWireNote(value: unknown): WireNote {
  const obj = record(value, 'note');
  const createdAt = new Date(string(obj, 'createdAt', 'note'));
  if (Number.isNaN(createdAt.getTime())) throw new ContractError('note.createdAt is not a date');
  const noteId = (key: string): string => {
    const id = string(obj, key, 'note');
    if (!isSafeNoteId(id)) throw new ContractError(`note.${key} ${quoted(id)} is not an id`);
    return id;
  };
  const note: WireNote = {
    id: noteId('id'),
    body: string(obj, 'body', 'note'),
    preview: nullableString(obj, 'preview', 'note'),
    createdAt,
    author: member(obj, 'author', 'note', WIRE_NOTE_AUTHORS),
    kind: member(obj, 'kind', 'note', NOTE_KINDS),
  };
  if (obj['questions'] !== undefined) note.questions = string(obj, 'questions', 'note');
  if (obj['answers'] !== undefined) note.answers = string(obj, 'answers', 'note');
  if (obj['questionNoteId'] !== undefined) note.questionNoteId = noteId('questionNoteId');
  if (obj['suggestion'] !== undefined) note.suggestion = string(obj, 'suggestion', 'note');
  if (obj['pending'] !== undefined) note.pending = boolean(obj, 'pending', 'note');
  if (obj['queued'] !== undefined) note.queued = boolean(obj, 'queued', 'note');
  if (obj['deliveredAt'] !== undefined && obj['deliveredAt'] !== null) {
    const deliveredAt = new Date(string(obj, 'deliveredAt', 'note'));
    if (Number.isNaN(deliveredAt.getTime())) throw new ContractError('note.deliveredAt is not a date');
    note.deliveredAt = deliveredAt;
  }
  return note;
}

export function parseWireNotes(value: unknown, options: ListOptions = {}): WireNote[] {
  if (!Array.isArray(value)) throw new ContractError('expected a JSON array of notes');
  return skippingUnknown(value, options, parseWireNote, 'note', [
    ['author', WIRE_NOTE_AUTHORS],
    ['kind', NOTE_KINDS],
  ]);
}

// The JSON form of a note, as `read-notes` sends it.
export function serializeWireNote(note: WireNote): Record<string, unknown> {
  const { deliveredAt, ...rest } = note;
  return {
    ...rest,
    createdAt: note.createdAt.toISOString(),
    ...(deliveredAt === undefined ? {} : { deliveredAt: deliveredAt.toISOString() }),
  };
}

// The answer of run-inbox.
export function parseWireRunInbox(value: unknown): WireRunInbox {
  const obj = record(value, 'run-inbox result');
  if (!Array.isArray(obj['messages'])) throw new ContractError('run-inbox result.messages must be a list');
  const stopMessage = obj['stopMessage'];
  if (stopMessage !== undefined && !(typeof stopMessage === 'string' && isSafeNoteId(stopMessage)))
    throw new ContractError('run-inbox result.stopMessage must be a note id');
  return {
    stop: boolean(obj, 'stop', 'run-inbox result'),
    ...(stopMessage === undefined ? {} : { stopMessage }),
    messages: obj['messages'].map(parseWireNote),
  };
}

// At most this many notes are acknowledged in one call.
const MAX_ACK_IDS = 100;

// Body of ack-messages.
export function parseAckMessages(value: unknown): AckMessages {
  const obj = record(value, 'ack-messages');
  rejectUnknownKeys(obj, ['ids', 'stop'], 'ack-messages');
  const ids = obj['ids'];
  if (!Array.isArray(ids) || ids.length > MAX_ACK_IDS || !ids.every((id) => typeof id === 'string' && isSafeNoteId(id)))
    throw new ContractError(`ack-messages.ids must be a list of at most ${MAX_ACK_IDS} note ids`);
  return {
    ids: ids as string[],
    ...(obj['stop'] === undefined ? {} : { stop: boolean(obj, 'stop', 'ack-messages') }),
  };
}

/** The API range a server answers with: `api` when present, else the legacy `contract` as both ends. */
export function parseVersion(value: unknown): { version: number; minClient: number } {
  const obj = record(value, 'version');
  const api = obj['api'];
  if (api === undefined) {
    const contract = obj['contract'];
    if (typeof contract !== 'number') throw new ContractError('version.contract must be a number');
    return { version: contract, minClient: contract };
  }
  const range = record(api, 'version.api');
  const apiVersion = range['version'];
  const minClient = range['minClient'];
  if (!isWholeNumber(apiVersion) || !isWholeNumber(minClient))
    throw new ContractError('version.api.version and version.api.minClient must be whole numbers');
  if (minClient > apiVersion) throw new ContractError('version.api.minClient is above version.api.version');
  return { version: apiVersion, minClient };
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// The rest of the `version` answer: whose board this is and which data key it expects (null before encryption is set up).
export function parseVersionIdentity(value: unknown): { owner: string; keyId: string | null } {
  const obj = record(value, 'version');
  const owner = string(obj, 'owner', 'version');
  if (owner === '' || !isPlainLine(owner, 256)) throw new ContractError('version.owner is not a user name');
  const keyId = obj['keyId'];
  if (keyId !== null && !isKeyId(keyId)) throw new ContractError('version.keyId is not a key id');
  return { owner, keyId };
}

/** The headers every machine API request carries: the CLI's version and the API level it speaks. */
export const CLIENT_VERSION_HEADER = 'x-board-client';
export const CLIENT_API_HEADER = 'x-board-client-api';

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const CLIENT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,20})?$/;

/** A release as `cli-v<x.y.z>` names it. */
export function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && RELEASE_VERSION.test(value);
}

/** Orders versions by their x.y.z; a suffix such as `-dev` counts as its base. Negative, zero or positive like a subtraction. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] =>
    (version.split('-')[0] ?? version).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** A CLI version a client reports: a release, or a checkout's `x.y.z-dev`. Anything else is ignored, never refused. */
export function parseClientVersion(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 40 && CLIENT_VERSION.test(value) ? value : null;
}

/** The API level a client reports: an integer from 1 to 10000, else ignored. */
export function parseClientApi(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return null;
  const level = Number(value);
  return level >= 1 && level <= 10_000 ? level : null;
}

/** The newest CLI release the server advertises in the `version` answer; null when it names none or something else. */
export function parseVersionCli(value: unknown): string | null {
  const cli = record(value, 'version')['cli'];
  return isReleaseVersion(cli) ? cli : null;
}

/** The blind index of the calling machine's list in a `version` answer. Lenient: anything but a blind index is null, never an error. */
export function parseVersionDirsIndex(value: unknown): string | null {
  const dirsIndex = isRecord(value) ? value['dirsIndex'] : undefined;
  return typeof dirsIndex === 'string' && isBlindIndex(dirsIndex) ? dirsIndex : null;
}

// What the server checks of every request: the shape, the sealed fields being envelopes, and nothing about their content.

function sealedField(obj: Record<string, unknown>, key: string, what: string, field: Field): string {
  return parseSealed(obj[key], field, `${what}.${key}`);
}

function nullableSealedField(obj: Record<string, unknown>, key: string, what: string, field: Field): string | null {
  return obj[key] === null ? null : sealedField(obj, key, what, field);
}

// Body of set-pr: a sealed PR URL.
export function parseWirePr(value: unknown): WirePr {
  const obj = record(value, 'pr');
  rejectUnknownKeys(obj, ['pr'], 'pr');
  return { pr: sealedField(obj, 'pr', 'pr', 'pr') };
}

// Body of set-pr-state.
export function parseWirePrState(value: unknown): WirePrState {
  const obj = record(value, 'prState');
  rejectUnknownKeys(obj, ['prState'], 'prState');
  return { prState: member(obj, 'prState', 'prState', PR_STATES) };
}

// Body of set-dirs: the sealed list and its blind index.
export function parseWireDirs(value: unknown): WireDirs {
  const obj = record(value, 'dirs');
  rejectUnknownKeys(obj, ['dirs', 'index'], 'dirs');
  return {
    dirs: sealedField(obj, 'dirs', 'dirs', 'machine.dirs'),
    index: parseBlindIndex(obj['index'], 'dirs.index'),
  };
}

// Body of add-task. `id`, `title` and `input` are required.
export function parseWireTaskDraft(value: unknown): WireTaskDraft {
  const obj = record(value, 'draft');
  rejectUnknownKeys(
    obj,
    [
      'id',
      'title',
      'input',
      'status',
      'priority',
      'model',
      'dedupeKey',
      'parentId',
      'createdBy',
      'machine',
      'workdir',
      'agent',
      'head',
      'notBefore',
    ],
    'draft',
  );
  const draft: WireTaskDraft = {
    id: safeId(string(obj, 'id', 'draft'), 'draft.id'),
    title: sealedField(obj, 'title', 'draft', 'title'),
    input: sealedField(obj, 'input', 'draft', 'input'),
    status: 'status' in obj ? member(obj, 'status', 'draft', DRAFT_STATUSES) : 'todo',
  };
  if ('priority' in obj) draft.priority = member(obj, 'priority', 'draft', PRIORITIES);
  if ('model' in obj) draft.model = modelName(obj, 'draft');
  if ('dedupeKey' in obj) draft.dedupeKey = parseBlindIndex(obj['dedupeKey'], 'draft.dedupeKey');
  if ('parentId' in obj) draft.parentId = safeId(string(obj, 'parentId', 'draft'), 'draft.parentId');
  if ('createdBy' in obj) draft.createdBy = member(obj, 'createdBy', 'draft', TASK_CREATORS);
  if ('machine' in obj) {
    draft.machine = string(obj, 'machine', 'draft');
    if (!isSafeMachineName(draft.machine)) throw new ContractError('draft.machine is not a safe name');
  }
  if ('workdir' in obj) draft.workdir = sealedField(obj, 'workdir', 'draft', 'workdir');
  if ('agent' in obj) draft.agent = sealedField(obj, 'agent', 'draft', 'agent');
  if (draft.agent !== undefined && draft.createdBy === 'agent')
    throw new ContractError(
      'draft.agent cannot go with createdBy agent: a proposal runs under no agent until the user starts it',
    );
  if ('head' in obj) draft.head = head(obj['head'], 'draft');
  if ('notBefore' in obj) {
    draft.notBefore = date(obj, 'notBefore', 'draft');
    if (draft.status !== 'todo') throw new ContractError('draft.notBefore needs status todo');
  }
  if ((draft.machine === undefined) !== (draft.workdir === undefined))
    throw new ContractError('draft.machine and draft.workdir go together');
  return draft;
}

// Body of add-schedule. `id`, `title`, `input` and one rule are required.
export function parseWireScheduleDraft(value: unknown): WireScheduleDraft {
  const obj = record(value, 'schedule draft');
  rejectUnknownKeys(
    obj,
    [
      'id',
      'title',
      'input',
      'priority',
      'model',
      'machine',
      'workdir',
      'agent',
      'everyMs',
      'cron',
      'timezone',
      'startAt',
      'times',
      'until',
    ],
    'schedule draft',
  );
  const what = 'schedule draft';
  const draft: WireScheduleDraft = {
    id: safeId(string(obj, 'id', what), 'schedule draft.id'),
    title: sealedField(obj, 'title', what, 'title'),
    input: sealedField(obj, 'input', what, 'input'),
  };
  if ('priority' in obj) draft.priority = member(obj, 'priority', what, PRIORITIES);
  if ('model' in obj) draft.model = modelName(obj, what);
  if ('machine' in obj) {
    draft.machine = string(obj, 'machine', what);
    if (!isSafeMachineName(draft.machine)) throw new ContractError('schedule draft.machine is not a safe name');
  }
  if ('workdir' in obj) draft.workdir = sealedField(obj, 'workdir', what, 'workdir');
  if ('agent' in obj) draft.agent = sealedField(obj, 'agent', what, 'agent');
  if ((draft.machine === undefined) !== (draft.workdir === undefined))
    throw new ContractError('schedule draft.machine and schedule draft.workdir go together');
  if ('everyMs' in obj === 'cron' in obj) throw new ContractError('a schedule needs exactly one of everyMs and cron');
  if ('everyMs' in obj) draft.everyMs = positiveInt(obj, 'everyMs', what, MAX_INTERVAL_MS);
  if ('cron' in obj) {
    draft.cron = string(obj, 'cron', what);
    draft.timezone = string(obj, 'timezone', what);
    if (draft.timezone === '') throw new ContractError('schedule draft.timezone must not be empty');
  } else if ('timezone' in obj) throw new ContractError('schedule draft.timezone only goes with cron');
  if ('startAt' in obj) draft.startAt = date(obj, 'startAt', what);
  if ('times' in obj) draft.times = positiveInt(obj, 'times', what, MAX_INT32);
  if ('until' in obj) draft.until = date(obj, 'until', what);
  if ('times' in obj && 'until' in obj)
    throw new ContractError('schedule draft.times and schedule draft.until exclude each other');
  return draft;
}

// Body of update-schedule.
export function parseSchedulePatch(value: unknown): SchedulePatch {
  const obj = record(value, 'schedule patch');
  rejectUnknownKeys(obj, ['paused'], 'schedule patch');
  return { paused: boolean(obj, 'paused', 'schedule patch') };
}

// Body of update-task. At least one key.
export function parseWireTaskPatch(value: unknown): WireTaskPatch {
  const obj = record(value, 'patch');
  const keys = ['status', 'priority', 'input', 'sessionId', 'workdir', 'next', 'head', 'notBefore'];
  rejectUnknownKeys(obj, [...keys, 'expect'], 'patch');
  if (!keys.some((key) => key in obj)) throw new ContractError(`patch needs one of ${keys.join(', ')}`);
  const patch: WireTaskPatch = {};
  if ('status' in obj) patch.status = member(obj, 'status', 'patch', STATUSES);
  if ('priority' in obj) patch.priority = member(obj, 'priority', 'patch', PRIORITIES);
  if ('expect' in obj) patch.expect = member(obj, 'expect', 'patch', STATUSES);
  if ('input' in obj) patch.input = sealedField(obj, 'input', 'patch', 'input');
  if ('sessionId' in obj) patch.sessionId = sessionId(nullableString(obj, 'sessionId', 'patch'), 'patch');
  if ('next' in obj) patch.next = member(obj, 'next', 'patch', NEXT_RUNS);
  if ('head' in obj) patch.head = obj['head'] === null ? null : head(obj['head'], 'patch');
  if ('notBefore' in obj) patch.notBefore = nullableDate(obj, 'notBefore', 'patch');
  if ('workdir' in obj) patch.workdir = nullableSealedField(obj, 'workdir', 'patch', 'workdir');
  return patch;
}

// Body of add-note, pause and fail: a sealed text and, optionally, the sealed start of it. Only add-note takes a suggestion.
export function parseWireNoteInput(
  value: unknown,
  what: string,
  { allowSuggestion = false }: { allowSuggestion?: boolean } = {},
): WireNoteInput {
  const obj = record(value, what);
  rejectUnknownKeys(obj, allowSuggestion ? ['body', 'preview', 'suggestion'] : ['body', 'preview'], what);
  const input: WireNoteInput = { body: sealedField(obj, 'body', what, 'note.body') };
  if (obj['preview'] !== undefined) input.preview = nullableSealedField(obj, 'preview', what, 'note.preview');
  if (obj['suggestion'] !== undefined) input.suggestion = sealedField(obj, 'suggestion', what, 'note.suggestion');
  return input;
}

// Body of ask.
export function parseWireAsk(value: unknown): WireAsk {
  const obj = record(value, 'ask');
  rejectUnknownKeys(obj, ['body', 'questions'], 'ask');
  return {
    body: sealedField(obj, 'body', 'ask', 'note.body'),
    questions: sealedField(obj, 'questions', 'ask', 'note.questions'),
  };
}

// Body of wait: the sealed comment, the end of the wait and whether a check may end it early.
export function parseWireWait(value: unknown): WireWait {
  const obj = record(value, 'wait');
  rejectUnknownKeys(obj, ['body', 'preview', 'wakeAt', 'check'], 'wait');
  const wait: WireWait = {
    body: sealedField(obj, 'body', 'wait', 'note.body'),
    wakeAt: date(obj, 'wakeAt', 'wait'),
    check: boolean(obj, 'check', 'wait'),
  };
  if (obj['preview'] !== undefined) wait.preview = nullableSealedField(obj, 'preview', 'wait', 'note.preview');
  return wait;
}

// Body of heartbeat.
export function parseHeartbeat(value: unknown): Heartbeat {
  const obj = record(value, 'heartbeat');
  rejectUnknownKeys(obj, ['lane', 'borrowed'], 'heartbeat');
  const lane = string(obj, 'lane', 'heartbeat');
  if (!isSafeMachineName(lane)) throw new ContractError(`heartbeat.lane must be a name of ${MACHINE_NAME_RULE}`);
  return { lane, borrowed: boolean(obj, 'borrowed', 'heartbeat') };
}

// The JSON form of a task, as the machine API sends it.
export function serializeTask(task: WireTask): Record<string, unknown> {
  return {
    ...task,
    lastActiveAt: task.lastActiveAt?.toISOString() ?? null,
    runStartedAt: task.runStartedAt?.toISOString() ?? null,
    notBefore: task.notBefore?.toISOString() ?? null,
    wakeAt: task.wakeAt?.toISOString() ?? null,
  };
}

// The characters of a note's text the board card shows next to the task.
export const NOTE_PREVIEW_CHARS = 300;

/**
 * The text a note carries as its sealed preview: the first characters of its text, or null for a note without any text.
 * Every client-written note with text carries one, so the board lists a task's newest note without opening the thread.
 */
export function notePreview(text: string): string | null {
  return text.trim() === '' ? null : Array.from(text).slice(0, NOTE_PREVIEW_CHARS).join('');
}

/**
 * A task's labels, derived from its prompt and creator: the skill the prompt starts with, and "review" for a task of the removed
 * built-in intake whose prompt names none (kept so that existing tasks keep their label). The board does not store labels.
 */
export function taskLabels(task: Pick<Task, 'input' | 'createdBy'>): string[] {
  const skill = promptSkill(task.input);
  if (skill !== undefined) return [skill];
  return task.createdBy === 'intake' ? ['review'] : [];
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
