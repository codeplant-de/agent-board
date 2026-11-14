import {
  DEFAULT_PRIORITY,
  isSafeTaskId,
  parseAnswers,
  PRIORITIES,
  promptSkill,
  TAKE_BACK_AFTER_MS,
  type Answer,
  type Note,
  type Priority,
  type Heartbeat,
  type Question,
  type Status,
  type Task,
  type TaskDraft,
  type TaskPatch,
} from '@agent-board/shared';
import { and, asc, desc, eq, lt, max, min, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db, DbOrTx } from '../db/client';
import { notes, tasks, type NoteRow, type TaskRow } from '../db/schema';
import { AppError } from './errors';
import { DONE_ARCHIVE_DAYS, daysBefore } from './retention';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 8 characters, safe for a systemd unit name; never "dispatch" or "intake". */
export function newId(length = 8): string {
  for (;;) {
    const bytes = randomBytes(length);
    const id = Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
    if (isSafeTaskId(id)) return id;
  }
}

export function toTask(row: TaskRow, publicUrl: string): Task {
  return {
    id: row.id,
    title: row.title,
    input: row.input,
    labels: row.labels,
    status: row.status,
    priority: row.priority,
    url: `${publicUrl}/t/${row.id}`,
    closed: row.closed,
    machine: row.machine,
    sessionId: row.sessionId,
    workdir: row.workdir,
    next: row.next,
    head: row.head,
    openQuestion: row.openQuestionNoteId !== null,
    createdBy: row.createdBy,
    // Run details describe the current run only.
    lane: row.status === 'running' ? row.lane : null,
    borrowed: row.status === 'running' && row.borrowed,
    lastActiveAt: row.status === 'running' ? row.lastActiveAt : null,
    runStartedAt: row.status === 'running' ? row.runStartedAt : null,
    paused: row.pausedAt !== null,
    notBefore: row.notBefore,
  };
}

export function toNote(row: NoteRow): Note {
  const note: Note = {
    id: row.id,
    text: row.body,
    createdAt: row.createdAt,
    author: row.author,
    kind: row.kind,
  };
  if (row.questions) note.questions = row.questions;
  if (row.answers) note.answers = row.answers;
  if (row.questionNoteId) note.questionNoteId = row.questionNoteId;
  return note;
}

/** A position below every task of the status (`bottom`) or above all of them (`top`). */
async function edgePosition(db: DbOrTx, status: Status, edge: 'top' | 'bottom'): Promise<number> {
  const [row] = await db
    .select({ low: min(tasks.position), high: max(tasks.position) })
    .from(tasks)
    .where(eq(tasks.status, status));
  if (edge === 'top') return row?.low == null ? 0 : row.low - 1;
  return row?.high == null ? 0 : row.high + 1;
}

/**
 * Columns by status, then priority (urgent first), then manual order. In Todo, waiting cards (delayed, not yet due) come
 * last, by their start; resumes (answered, replied to, paused) come before the rest: that work is already under way.
 */
const taskOrder = () => [
  asc(tasks.status),
  sql`case when ${tasks.status} = 'todo' and ${tasks.notBefore} > now() then 1 else 0 end`,
  asc(sql`case when ${tasks.status} = 'todo' and ${tasks.notBefore} > now() then ${tasks.notBefore} end`),
  sql`case when ${tasks.status} = 'todo' and ${tasks.next} = 'resume' then 0 else 1 end`,
  asc(tasks.priority),
  asc(tasks.position),
  asc(tasks.createdAt),
];

/** Every task in column order; closed ones only with `all`. */
export async function listTasks(db: DbOrTx, options: { all?: boolean } = {}): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(options.all ? undefined : eq(tasks.closed, false))
    .orderBy(...taskOrder());
}

/** The newest note of a task, as the board card shows it. */
export interface LastNote {
  kind: NoteRow['kind'];
  author: NoteRow['author'];
  /** The start of the text, enough for a one-line preview. */
  text: string;
  createdAt: Date;
}

/** `listTasks` with each task's newest note, in one query. */
export async function listTasksWithLastNote(
  db: DbOrTx,
  options: { all?: boolean } = {},
): Promise<{ row: TaskRow; lastNote: LastNote | null }[]> {
  const latest = db
    .select({
      kind: notes.kind,
      author: notes.author,
      text: sql<string>`left(${notes.body}, 300)`.as('text'),
      createdAt: notes.createdAt,
    })
    .from(notes)
    .where(eq(notes.taskId, tasks.id))
    .orderBy(desc(notes.createdAt), desc(notes.id))
    .limit(1)
    .as('latest');
  const rows = await db
    .select({
      row: tasks,
      lastNote: { kind: latest.kind, author: latest.author, text: latest.text, createdAt: latest.createdAt },
    })
    .from(tasks)
    .leftJoinLateral(latest, sql`true`)
    .where(options.all ? undefined : eq(tasks.closed, false))
    .orderBy(...taskOrder());
  return rows.map(({ row, lastNote }) => ({ row, lastNote: lastNote?.kind ? lastNote : null }));
}

export async function getTask(db: DbOrTx, id: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!row) throw new AppError('NOT_FOUND', `no task ${id.slice(0, 64)}`);
  return row;
}

/** New task at the bottom of its status. A known dedupe key returns the existing task instead. */
export async function addTask(db: Db, draft: TaskDraft): Promise<{ row: TaskRow; created: boolean }> {
  return db.transaction(async (tx) => {
    // A follow-up is as pressing as the task it came from, unless its creator says otherwise.
    const parent = draft.parentId === undefined ? undefined : await getTask(tx, draft.parentId);
    const proposed = draft.createdBy === 'agent';
    // A proposal waits for the user whatever status the agent named.
    const status = proposed ? 'needs-me' : (draft.status ?? 'todo');
    if (draft.notBefore !== undefined && status !== 'todo')
      throw new AppError('BAD_REQUEST', 'Only a task in Todo can have a start time.');
    const [row] = await tx
      .insert(tasks)
      .values({
        id: newId(),
        title: draft.title.trim(),
        input: draft.input,
        // A task is labelled with the skill its prompt starts with, unless its creator says otherwise.
        labels:
          draft.labels.length > 0 ? draft.labels : [promptSkill(draft.input)].filter((skill) => skill !== undefined),
        machine: draft.machine ?? null,
        workdir: draft.workdir ?? null,
        head: draft.head ?? null,
        notBefore: draft.notBefore ?? null,
        status,
        priority: draft.priority ?? parent?.priority ?? DEFAULT_PRIORITY,
        position: await edgePosition(tx, status, 'bottom'),
        dedupeKey: draft.dedupeKey ?? null,
        parentId: draft.parentId ?? null,
        createdBy: draft.createdBy ?? 'user',
        proposed,
      })
      .onConflictDoNothing({ target: tasks.dedupeKey })
      .returning();
    if (row) return { row, created: true };
    const [existing] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.dedupeKey, draft.dedupeKey ?? ''));
    if (!existing) throw new AppError('CONFLICT', 'the task was created and removed at once; try again');
    return { row: existing, created: false };
  });
}

async function lockTask(tx: DbOrTx, id: string): Promise<TaskRow> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
  if (!row) throw new AppError('NOT_FOUND', `no task ${id.slice(0, 64)}`);
  return row;
}

type TaskValues = Partial<typeof tasks.$inferInsert>;

interface Transition {
  /** Default: the task's own status. */
  to?: Status;
  /** Default: where it is when the status stays, else the bottom. A number is a position between neighbours. */
  place?: 'top' | 'bottom' | number;
  /** Only a user starts a proposal. */
  by: 'worker' | 'user';
  /** Columns on top of what the invariants set; they win. */
  set?: TaskValues;
}

/** A pause survives the wait in Todo and the claim; the worker clears it, or the task leaving Running another way does. */
function keepsPause(from: Status, to: Status): boolean {
  return (from === 'todo' && (to === 'todo' || to === 'running')) || (from === 'running' && to === 'running');
}

/**
 * Every status change goes through here, in a transaction that holds the task's lock, so the columns that depend
 * on the status cannot drift apart: the open question (only while it waits in Needs me), the run's start, a proposal
 * (only a user starts it), a pause, a start time (only while it waits in Todo), the position.
 */
async function transition(tx: DbOrTx, task: TaskRow, change: Transition): Promise<TaskRow> {
  const to = change.to ?? task.status;
  const moved = to !== task.status;
  if (change.by === 'worker' && moved && task.proposed)
    throw new AppError('FORBIDDEN', 'An agent proposed this task; only you start it.');
  const now = new Date();
  const values: TaskValues = { status: to, updatedAt: now };
  if (to !== 'needs-me') values.openQuestionNoteId = null;
  if (!keepsPause(task.status, to)) values.pausedAt = null;
  if (change.by === 'user' && to === 'todo') values.proposed = false;
  if (to === 'running' && task.status !== 'running') {
    values.runStartedAt = now;
    values.lastActiveAt = now;
    values.lane = null;
    values.borrowed = false;
  }
  if (to !== 'running') values.runStartedAt = null;
  if (to !== 'todo') values.notBefore = null;
  const place = change.place ?? (moved ? 'bottom' : undefined);
  if (typeof place === 'number') values.position = place;
  else if (place !== undefined) values.position = await edgePosition(tx, to, place);
  const [row] = await tx
    .update(tasks)
    .set({ ...values, ...change.set })
    .where(eq(tasks.id, task.id))
    .returning();
  return row!;
}

/** A status or priority change puts the task at the bottom of its new place. */
export async function updateTask(db: Db, id: string, patch: TaskPatch): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const current = await lockTask(tx, id);
    if (patch.expect !== undefined && patch.expect !== current.status)
      throw new AppError('CONFLICT', `the task is ${current.status}, not ${patch.expect}`);
    const set: TaskValues = {};
    if (patch.input !== undefined) set.input = patch.input;
    if (patch.sessionId !== undefined) set.sessionId = patch.sessionId;
    if (patch.workdir !== undefined) set.workdir = patch.workdir;
    if (patch.next !== undefined) set.next = patch.next;
    if (patch.head !== undefined) set.head = patch.head;
    if (patch.notBefore instanceof Date) {
      if ((patch.status ?? current.status) !== 'todo')
        throw new AppError('CONFLICT', 'Only a task in Todo can have a start time.');
      set.notBefore = patch.notBefore;
    } else if (patch.notBefore === null) set.notBefore = null;
    if (patch.priority !== undefined && patch.priority !== current.priority) set.priority = patch.priority;
    // The worker has read the pause by now; its first update of the run consumes it.
    if (current.status === 'running') set.pausedAt = null;
    return transition(tx, current, {
      to: patch.status,
      place: set.priority !== undefined ? 'bottom' : undefined,
      by: 'worker',
      set,
    });
  });
}

/**
 * Todo to running for `machine`; the lock lets two machines claim at once and only one win.
 * A resume is pinned to the machine that holds its session, a proposal is not for a worker to start, and a delayed
 * task is not due before its start time.
 * Undefined when the claim is lost.
 */
export async function claimTask(db: Db, id: string, machine: string): Promise<TaskRow | undefined> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, id);
    const free =
      task.status === 'todo' &&
      !task.closed &&
      !task.proposed &&
      (task.notBefore === null || task.notBefore.getTime() <= Date.now()) &&
      (task.next === 'fresh' || task.sessionId === null || task.machine === null || task.machine === machine);
    return free ? transition(tx, task, { to: 'running', by: 'worker', set: { machine } }) : undefined;
  });
}

export async function addNote(
  db: DbOrTx,
  taskId: string,
  note: {
    author: NoteRow['author'];
    kind?: NoteRow['kind'];
    body: string;
    by: string | null;
    questions?: Question[];
    answers?: Answer[];
    questionNoteId?: string;
  },
): Promise<NoteRow> {
  await getTask(db, taskId);
  const [row] = await db
    .insert(notes)
    .values({
      id: newId(12),
      taskId,
      author: note.author,
      kind: note.kind ?? 'comment',
      body: note.body,
      by: note.by,
      questions: note.questions ?? null,
      answers: note.answers ?? null,
      questionNoteId: note.questionNoteId ?? null,
    })
    .returning();
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
  return row!;
}

/** The agent's question: a question note, and the task waits in needs-me for the answer. */
export async function ask(db: Db, taskId: string, questions: Question[], by: string): Promise<NoteRow> {
  return db.transaction(async (tx) => {
    const current = await lockTask(tx, taskId);
    // Answering a question starts the task as the user, so a proposal cannot ask one.
    if (current.proposed) throw new AppError('FORBIDDEN', 'An agent proposed this task; only you start it.');
    const note = await addNote(tx, taskId, { author: 'agent', kind: 'question', body: '', by, questions });
    await transition(tx, current, { to: 'needs-me', by: 'worker', set: { openQuestionNoteId: note.id } });
    return note;
  });
}

export async function readNotes(db: DbOrTx, taskId: string): Promise<NoteRow[]> {
  await getTask(db, taskId);
  return db.select().from(notes).where(eq(notes.taskId, taskId)).orderBy(asc(notes.createdAt), asc(notes.id));
}

function requireNotRunning(task: TaskRow): void {
  if (task.status === 'running') throw new AppError('CONFLICT', 'The task is running. Wait until it reports back.');
}

/**
 * The user's answer to the open question. With `resume` the task goes to the top of Todo and the next
 * run resumes the agent's session with it.
 */
export async function answer(
  db: Db,
  input: { taskId: string; questionNoteId: string; answers: unknown; message: string; by: string },
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    requireNotRunning(task);
    if (task.openQuestionNoteId !== input.questionNoteId)
      throw new AppError('CONFLICT', 'This question was already answered or replaced.');
    const [question] = await tx.select().from(notes).where(eq(notes.id, input.questionNoteId));
    if (!question?.questions) throw new AppError('NOT_FOUND', 'The question is gone.');
    let answers: Answer[];
    try {
      answers = parseAnswers(question.questions, input.answers);
    } catch (error) {
      throw new AppError('BAD_REQUEST', error instanceof Error ? error.message : String(error));
    }
    await addNote(tx, task.id, {
      author: 'user',
      kind: 'answer',
      body: input.message.trim(),
      by: input.by,
      answers,
      questionNoteId: question.id,
    });
    return continueTask(tx, task);
  });
}

/** A user comment; with `resume` it also sends the task back to the agent. */
export async function reply(
  db: Db,
  input: { taskId: string; message: string; resume: boolean; by: string },
): Promise<TaskRow> {
  const message = input.message.trim();
  if (message === '') throw new AppError('BAD_REQUEST', 'Write something first.');
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (input.resume) requireNotRunning(task);
    await addNote(tx, task.id, { author: 'user', kind: 'comment', body: message, by: input.by });
    return input.resume ? continueTask(tx, task) : lockTask(tx, task.id);
  });
}

/**
 * Back to the agent: top of Todo, because the user is waiting on it. With a session it resumes there,
 * on the machine that holds it; without one the next run starts fresh and reads the thread.
 */
async function continueTask(tx: DbOrTx, task: TaskRow): Promise<TaskRow> {
  return transition(tx, task, {
    to: 'todo',
    place: 'top',
    by: 'user',
    set: { next: task.sessionId ? 'resume' : 'fresh', closed: false, closedAt: null },
  });
}

async function systemEvent(tx: DbOrTx, taskId: string, body: string, by: string | null): Promise<void> {
  await addNote(tx, taskId, { author: 'system', kind: 'event', body, by });
}

export async function markDone(db: Db, taskId: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireNotRunning(task);
    await systemEvent(tx, taskId, 'Marked done.', by);
    return transition(tx, task, { to: 'done', place: 'top', by: 'user' });
  });
}

/** Start over: a new session on whichever machine claims it first. */
export async function rerunFresh(db: Db, taskId: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireNotRunning(task);
    await systemEvent(tx, taskId, 'Queued for a fresh run.', by);
    return transition(tx, task, {
      to: 'todo',
      place: 'bottom',
      by: 'user',
      set: { next: 'fresh', sessionId: null, workdir: null, closed: false, closedAt: null },
    });
  });
}

/** Closing takes a task out of the workflow; it stays readable and can be reopened. */
export async function setClosed(db: Db, taskId: string, closed: boolean, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (closed) requireNotRunning(task);
    await systemEvent(tx, taskId, closed ? 'Closed.' : 'Reopened.', by);
    return closeOrReopen(tx, task, closed);
  });
}

function closeOrReopen(tx: DbOrTx, task: TaskRow, closed: boolean): Promise<TaskRow> {
  return transition(tx, task, {
    by: 'user',
    set: { closed, closedAt: closed ? new Date() : null, proposed: closed ? task.proposed : false },
  });
}

/**
 * Closes what has sat untouched in Done for the archive period. Returns how many tasks it closed.
 * Intake's tasks stay open: intake reads a closed task as "never again", which would block a re-requested review.
 */
export async function archiveStaleDone(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = daysBefore(now, DONE_ARCHIVE_DAYS);
  const stale = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'done'),
        eq(tasks.closed, false),
        ne(tasks.createdBy, 'intake'),
        lt(tasks.updatedAt, cutoff),
      ),
    );
  let closed = 0;
  for (const { id } of stale) {
    await db.transaction(async (tx) => {
      // Someone may have touched it since the listing.
      const task = await lockTask(tx, id);
      if (task.status !== 'done' || task.closed || task.createdBy === 'intake' || task.updatedAt >= cutoff) return;
      await systemEvent(tx, id, `Closed after ${DONE_ARCHIVE_DAYS} days in Done.`, null);
      await closeOrReopen(tx, task, true);
      closed += 1;
    });
  }
  return closed;
}

/**
 * Drag and drop: into `status`, between `afterId` (above) and `beforeId` (below), or at the bottom.
 * Nobody but a worker moves a task into or out of Running.
 */
export async function moveTask(
  db: Db,
  input: { taskId: string; status: Status; beforeId?: string; afterId?: string; by: string },
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.status === 'running' && input.status !== 'running')
      throw new AppError('CONFLICT', 'The task is running. Wait until it reports back.');
    if (task.status !== 'running' && input.status === 'running')
      throw new AppError('BAD_REQUEST', 'Only a worker moves a task to Running.');
    const neighbour = async (id: string | undefined) => {
      if (id === undefined) return undefined;
      const [row] = await tx
        .select({ position: tasks.position, priority: tasks.priority })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.status, input.status), ne(tasks.id, task.id)));
      return row;
    };
    const above = await neighbour(input.afterId);
    const below = await neighbour(input.beforeId);
    // Columns sort by priority first, so a card dropped among tasks of another priority takes theirs.
    const priority = droppedPriority(task.priority, above?.priority, below?.priority);
    const upper = above?.priority === priority ? above.position : undefined;
    const lower = below?.priority === priority ? below.position : undefined;
    let position: number;
    if (upper !== undefined && lower !== undefined) position = (upper + lower) / 2;
    else if (lower !== undefined) position = lower - 1;
    else if (upper !== undefined) position = upper + 1;
    else position = await edgePosition(tx, input.status, 'bottom');
    if (task.status !== input.status) {
      await systemEvent(tx, task.id, `Moved from ${task.status} to ${input.status}.`, input.by);
    }
    if (task.priority !== priority) {
      await systemEvent(tx, task.id, `Priority ${task.priority} → ${priority}.`, input.by);
    }
    // Into Todo it behaves like "Send & continue" without a reply: it starts a proposal and drops the open question,
    // and a task with a session keeps its `next` (a resume with nothing to say starts fresh).
    return transition(tx, task, { to: input.status, place: position, by: 'user', set: { priority } });
  });
}

/**
 * The priority of a card dropped between `above` and `below`: its own when it fits there (equal to a
 * neighbour, or between theirs), else the neighbour's above it, else the one below. Without neighbours it keeps its own.
 */
export function droppedPriority(own: Priority, above: Priority | undefined, below: Priority | undefined): Priority {
  const rank = (p: Priority) => PRIORITIES.indexOf(p);
  const fitsAbove = above === undefined || rank(above) <= rank(own);
  const fitsBelow = below === undefined || rank(own) <= rank(below);
  if (fitsAbove && fitsBelow) return own;
  return above ?? below ?? own;
}

/** A new priority from the UI: the task goes to the bottom of its new band. */
export async function setPriority(db: Db, taskId: string, priority: Priority, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.priority === priority) return task;
    await systemEvent(tx, taskId, `Priority ${task.priority} → ${priority}.`, by);
    return transition(tx, task, { place: 'bottom', by: 'user', set: { priority } });
  });
}

/** Sets or clears (null) the start time of a Todo task. */
export async function setNotBefore(db: Db, taskId: string, notBefore: Date | null, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'todo') throw new AppError('CONFLICT', `The task is ${task.status}, not in Todo.`);
    await systemEvent(
      tx,
      taskId,
      notBefore === null ? 'Start time cleared.' : `Start time set to ${notBefore.toISOString()}.`,
      by,
    );
    return transition(tx, task, { by: 'user', set: { notBefore } });
  });
}

/** The agent of a running task made a tool call. A task that stopped running in between is left alone. */
export async function heartbeat(db: Db, taskId: string, beat: Heartbeat): Promise<void> {
  await getTask(db, taskId);
  await db
    .update(tasks)
    .set({ lane: beat.lane, borrowed: beat.borrowed, lastActiveAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')));
}

/**
 * A worker gave up the task's slot for its own lane's work. Back to Todo, ahead of new work (resumes come first),
 * and resumed in its session on the same machine.
 */
export async function pause(db: Db, taskId: string, note: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'running') throw new AppError('CONFLICT', `the task is ${task.status}, not running`);
    await systemEvent(tx, taskId, note, by);
    return transition(tx, task, {
      to: 'todo',
      place: 'top',
      by: 'worker',
      set: { next: task.sessionId ? 'resume' : 'fresh', pausedAt: new Date() },
    });
  });
}

/** A run failed: while the task still runs, the reason goes into its thread and it waits in Needs me. Otherwise nothing changes. */
export async function failTask(
  db: Db,
  taskId: string,
  text: string,
  by: string,
): Promise<{ applied: boolean; row: TaskRow }> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'running' || task.closed) return { applied: false, row: task };
    await systemEvent(tx, taskId, text, by);
    return { applied: true, row: await transition(tx, task, { to: 'needs-me', by: 'worker' }) };
  });
}

/**
 * A running task whose agent has been quiet for the limit has lost its worker (the machine is off, the process
 * died): only that machine could end the run, so the user may take the task back, into Needs me.
 */
export async function takeBack(db: Db, taskId: string, by: string, now: Date = new Date()): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'running') throw new AppError('CONFLICT', 'The task is not running.');
    const quietMs = task.lastActiveAt === null ? Infinity : now.getTime() - task.lastActiveAt.getTime();
    if (quietMs < TAKE_BACK_AFTER_MS)
      throw new AppError(
        'CONFLICT',
        `The agent was active ${Math.floor(quietMs / 60_000)} min ago. A task can be taken back after ${TAKE_BACK_AFTER_MS / 60_000} quiet minutes.`,
      );
    await systemEvent(
      tx,
      taskId,
      `Taken back from ${task.machine ?? 'its worker'}: no sign of life for ${TAKE_BACK_AFTER_MS / 60_000} minutes.`,
      by,
    );
    return transition(tx, task, { to: 'needs-me', by: 'user' });
  });
}
