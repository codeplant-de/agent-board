import {
  isSafeTaskId,
  parseAnswers,
  type Answer,
  type Note,
  type Question,
  type Status,
  type Task,
  type TaskDraft,
  type TaskPatch,
} from '@agent-board/shared';
import { and, asc, eq, inArray, max, min, ne, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db, DbOrTx } from '../db/client';
import { labels, notes, tasks, type NoteRow, type TaskRow } from '../db/schema';
import { AppError } from './errors';

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
    url: `${publicUrl}/t/${row.id}`,
    closed: row.closed,
    machine: row.machine,
    sessionId: row.sessionId,
    next: row.next,
    openQuestion: row.openQuestionNoteId !== null,
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

/** Every task, in priority order within its status; closed ones only with `all`. */
export async function listTasks(db: DbOrTx, options: { all?: boolean } = {}): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(options.all ? undefined : eq(tasks.closed, false))
    .orderBy(asc(tasks.status), asc(tasks.position), asc(tasks.createdAt));
}

export async function getTask(db: DbOrTx, id: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!row) throw new AppError('NOT_FOUND', `no task ${id.slice(0, 64)}`);
  return row;
}

async function requireLabels(db: DbOrTx, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const known = await db.select({ name: labels.name }).from(labels).where(inArray(labels.name, names));
  const missing = names.filter((name) => !known.some((row) => row.name === name));
  if (missing.length > 0)
    throw new AppError('BAD_REQUEST', `unknown label ${missing.join(', ')} (run: board setup)`);
}

/** New task at the bottom of its status. A known dedupe key returns the existing task instead. */
export async function addTask(
  db: Db,
  draft: TaskDraft,
): Promise<{ row: TaskRow; created: boolean }> {
  return db.transaction(async (tx) => {
    await requireLabels(tx, draft.labels);
    if (draft.parentId !== undefined) await getTask(tx, draft.parentId);
    const proposed = draft.createdBy === 'agent';
    const [row] = await tx
      .insert(tasks)
      .values({
        id: newId(),
        title: draft.title.trim(),
        input: draft.input,
        labels: draft.labels,
        status: draft.status,
        position: await edgePosition(tx, draft.status, 'bottom'),
        dedupeKey: draft.dedupeKey ?? null,
        parentId: draft.parentId ?? null,
        createdBy: draft.createdBy ?? 'user',
        proposed,
      })
      .onConflictDoNothing({ target: tasks.dedupeKey })
      .returning();
    if (row) return { row, created: true };
    const [existing] = await tx.select().from(tasks).where(eq(tasks.dedupeKey, draft.dedupeKey ?? ''));
    if (!existing) throw new AppError('CONFLICT', 'the task was created and removed at once; try again');
    return { row: existing, created: false };
  });
}

/** A status change puts the task at the bottom of its new status. */
export async function updateTask(db: Db, id: string, patch: TaskPatch): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const current = await lockTask(tx, id);
    const values: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
    if (patch.input !== undefined) values.input = patch.input;
    if (patch.sessionId !== undefined) values.sessionId = patch.sessionId;
    if (patch.next !== undefined) values.next = patch.next;
    if (patch.status !== undefined && patch.status !== current.status) {
      values.status = patch.status;
      values.position = await edgePosition(tx, patch.status, 'bottom');
    }
    const [row] = await tx.update(tasks).set(values).where(eq(tasks.id, id)).returning();
    return row!;
  });
}

async function lockTask(tx: DbOrTx, id: string): Promise<TaskRow> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
  if (!row) throw new AppError('NOT_FOUND', `no task ${id.slice(0, 64)}`);
  return row;
}

/**
 * Todo to running for `machine`, in one statement: two machines claiming at once cannot both win.
 * A resume is pinned to the machine that holds its session. Undefined when the claim is lost.
 */
export async function claimTask(db: Db, id: string, machine: string): Promise<TaskRow | undefined> {
  const bottom = await edgePosition(db, 'running', 'bottom');
  const [row] = await db
    .update(tasks)
    .set({ status: 'running', machine, position: bottom, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.status, 'todo'),
        eq(tasks.closed, false),
        or(
          eq(tasks.next, 'fresh'),
          sql`${tasks.sessionId} is null`,
          sql`${tasks.machine} is null`,
          eq(tasks.machine, machine),
        ),
      ),
    )
    .returning();
  if (row) return row;
  await getTask(db, id);
  return undefined;
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
    const note = await addNote(tx, taskId, { author: 'agent', kind: 'question', body: '', by, questions });
    await tx
      .update(tasks)
      .set({
        status: 'needs-me',
        openQuestionNoteId: note.id,
        position:
          current.status === 'needs-me' ? current.position : await edgePosition(tx, 'needs-me', 'bottom'),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));
    return note;
  });
}

export async function readNotes(db: DbOrTx, taskId: string): Promise<NoteRow[]> {
  await getTask(db, taskId);
  return db
    .select()
    .from(notes)
    .where(eq(notes.taskId, taskId))
    .orderBy(asc(notes.createdAt), asc(notes.id));
}

/** Creates the labels it does not know yet; with dryRun only names them. */
export async function setupLabels(db: Db, names: string[], dryRun: boolean): Promise<string[]> {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  const known = await db.select({ name: labels.name }).from(labels).where(inArray(labels.name, unique));
  const missing = unique.filter((name) => !known.some((row) => row.name === name));
  if (!dryRun && missing.length > 0) {
    await db
      .insert(labels)
      .values(missing.map((name) => ({ name })))
      .onConflictDoNothing();
  }
  return missing.map((name) => `label ${name}`);
}

function requireNotRunning(task: TaskRow): void {
  if (task.status === 'running')
    throw new AppError('CONFLICT', 'The task is running. Wait until it reports back.');
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
  const [row] = await tx
    .update(tasks)
    .set({
      status: 'todo',
      position: await edgePosition(tx, 'todo', 'top'),
      next: task.sessionId ? 'resume' : 'fresh',
      openQuestionNoteId: null,
      proposed: false,
      closed: false,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id))
    .returning();
  return row!;
}

async function systemEvent(tx: DbOrTx, taskId: string, body: string, by: string): Promise<void> {
  await addNote(tx, taskId, { author: 'system', kind: 'event', body, by });
}

export async function markDone(db: Db, taskId: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireNotRunning(task);
    await systemEvent(tx, taskId, 'Marked done.', by);
    const [row] = await tx
      .update(tasks)
      .set({
        status: 'done',
        position: await edgePosition(tx, 'done', 'top'),
        openQuestionNoteId: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))
      .returning();
    return row!;
  });
}

/** Start over: a new session on whichever machine claims it first. */
export async function rerunFresh(db: Db, taskId: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireNotRunning(task);
    await systemEvent(tx, taskId, 'Queued for a fresh run.', by);
    const [row] = await tx
      .update(tasks)
      .set({
        status: 'todo',
        position: await edgePosition(tx, 'todo', 'bottom'),
        next: 'fresh',
        sessionId: null,
        openQuestionNoteId: null,
        proposed: false,
        closed: false,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))
      .returning();
    return row!;
  });
}

/** Closing takes a task out of the workflow; it stays readable and can be reopened. */
export async function setClosed(db: Db, taskId: string, closed: boolean, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (closed) requireNotRunning(task);
    await systemEvent(tx, taskId, closed ? 'Closed.' : 'Reopened.', by);
    const [row] = await tx
      .update(tasks)
      .set({ closed, proposed: closed ? task.proposed : false, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning();
    return row!;
  });
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
    const neighbour = async (id: string | undefined): Promise<number | undefined> => {
      if (id === undefined) return undefined;
      const [row] = await tx
        .select({ position: tasks.position })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.status, input.status), ne(tasks.id, task.id)));
      return row?.position;
    };
    const above = await neighbour(input.afterId);
    const below = await neighbour(input.beforeId);
    let position: number;
    if (above !== undefined && below !== undefined) position = (above + below) / 2;
    else if (below !== undefined) position = below - 1;
    else if (above !== undefined) position = above + 1;
    else position = await edgePosition(tx, input.status, 'bottom');
    if (task.status !== input.status) {
      await systemEvent(tx, task.id, `Moved from ${task.status} to ${input.status}.`, input.by);
    }
    const values: Partial<typeof tasks.$inferInsert> = {
      status: input.status,
      position,
      updatedAt: new Date(),
    };
    // Dragging a proposal into Todo starts it.
    if (input.status === 'todo') values.proposed = false;
    const [row] = await tx.update(tasks).set(values).where(eq(tasks.id, task.id)).returning();
    return row!;
  });
}
