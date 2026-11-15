import {
  formatServerEvent,
  MAX_WAIT_MS,
  PRIORITIES,
  TAKE_BACK_AFTER_MS,
  type ServerEvent,
  type Heartbeat,
  type Priority,
  type PrState,
  type Status,
  type WireNote,
  type WireNoteInput,
  type WireTask,
  type WireTaskDraft,
  type WireTaskPatch,
  type WireWait,
} from '@agent-board/shared';
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { notes, tasks, type NoteRow, type TaskRow } from '../db/schema';
import { AppError } from './errors';
import { requireSealed } from './sealed';
import { DONE_ARCHIVE_DAYS, daysBefore } from './retention';
import { completeOccurrence } from './schedules';
import { edgePosition, getTask, insertTask, lockTask, newId } from './taskRows';

export { getTask, newId };

export function toTask(row: TaskRow): WireTask {
  return {
    id: row.id,
    title: row.title,
    input: row.input,
    status: row.status,
    priority: row.priority,
    model: row.model,
    closed: row.closed,
    machine: row.machine,
    sessionId: row.sessionId,
    workdir: row.workdir,
    pr: row.pr,
    prState: row.prState,
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
    scheduleId: row.scheduleId,
    wakeAt: row.status === 'waiting' ? row.wakeAt : null,
    waitCheck: row.status === 'waiting' && row.waitCheck,
    woken: row.wokenAt !== null,
    stopRequested: row.status === 'running' && row.stopRequestedAt !== null,
  };
}

export function toNote(row: NoteRow): WireNote {
  const note: WireNote = {
    id: row.id,
    body: row.body,
    preview: row.preview,
    createdAt: row.createdAt,
    author: row.author,
    kind: row.kind,
  };
  if (row.questions) note.questions = row.questions;
  if (row.answers) note.answers = row.answers;
  if (row.suggestion) note.suggestion = row.suggestion;
  if (row.questionNoteId) note.questionNoteId = row.questionNoteId;
  if (row.pending) note.pending = true;
  if (row.queued) note.queued = true;
  if (row.deliveredAt) note.deliveredAt = row.deliveredAt;
  return note;
}

/**
 * Columns by status, then priority (urgent first), then manual order. In Todo, delayed cards (not yet due) come
 * last, by their start; resumes (answered, replied to, paused) come before the rest: that work is already under way.
 * Waiting lists the wait that ends first on top.
 */
const taskOrder = () => [
  asc(tasks.status),
  asc(sql`case when ${tasks.status} = 'waiting' then ${tasks.wakeAt} end`),
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

/**
 * The newest note of a task, as the board card shows it. `preview` is the note's stored sealed preview, or null for a
 * note without text; for a note by the server it is the event's own plain text, which the author tells apart.
 */
export interface LastNote {
  kind: NoteRow['kind'];
  author: NoteRow['author'];
  preview: string | null;
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
      preview: sql<string | null>`case when ${notes.author} = 'server' then ${notes.body} else ${notes.preview} end`.as(
        'preview',
      ),
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
      lastNote: { kind: latest.kind, author: latest.author, preview: latest.preview, createdAt: latest.createdAt },
    })
    .from(tasks)
    .leftJoinLateral(latest, sql`true`)
    .where(options.all ? undefined : eq(tasks.closed, false))
    .orderBy(...taskOrder());
  return rows.map(({ row, lastNote }) => ({ row, lastNote: lastNote?.kind ? lastNote : null }));
}

/** New task at the bottom of its status. A known dedupe key returns the existing task instead. */
export async function addTask(db: DbOrTx, draft: WireTaskDraft): Promise<{ row: TaskRow; created: boolean }> {
  return db.transaction((tx) => insertTask(tx, draft));
}

type TaskValues = Partial<typeof tasks.$inferInsert>;

interface Transition {
  /** Default: the task's own status. */
  to?: Status;
  /** Default: where it is when the status stays, else the bottom. A number is a position between neighbours. */
  place?: 'top' | 'bottom' | number;
  /** Only a user starts a proposal. */
  by: 'worker' | 'user';
  /** The user's start of an agent's proposal: its prompt, sealed again for the creator "user". Nothing else takes a proposal into Todo. */
  start?: { input: string };
  /** Columns on top of what the invariants set; they win. */
  set?: TaskValues;
  /** The user ended the run: pending messages become replies, but the task goes where the user sent it. */
  userStop?: boolean;
}

/** A pause survives the wait in Todo and the claim; the worker clears it, or the task leaving Running another way does. */
function keepsPause(from: Status, to: Status): boolean {
  return (from === 'todo' && (to === 'todo' || to === 'running')) || (from === 'running' && to === 'running');
}

/** Only `wait` takes a task into Waiting: a wait needs its end, and only a running agent knows what it waits for. */
function requireNotIntoWaiting(task: TaskRow, to: Status): void {
  if (to === 'waiting' && task.status !== 'waiting')
    throw new AppError('BAD_REQUEST', 'Only a running agent puts a task in Waiting (board wait).');
}

/**
 * Every status change goes through here, in a transaction that holds the task's lock, so the columns that depend
 * on the status cannot drift apart: the open question (only while it waits in Needs me), the run's start, a proposal
 * (only a user starts it, with its prompt sealed again as theirs), a pause, a start time (only while it waits in Todo), the
 * position.
 */
async function transition(tx: DbOrTx, task: TaskRow, change: Transition): Promise<TaskRow> {
  const leavingRunning = task.status === 'running' && (change.to ?? task.status) !== 'running';
  const handedBack = leavingRunning
    ? await handBackPendingMessages(tx, task, change.to, change.userStop === true)
    : undefined;
  const to = handedBack ? 'todo' : (change.to ?? task.status);
  const moved = to !== task.status;
  if (change.by === 'worker' && moved && task.proposed)
    throw new AppError('FORBIDDEN', 'An agent proposed this task; only you start it.');
  if (task.proposed && to === 'todo' && change.start === undefined)
    throw new AppError('FORBIDDEN', 'An agent proposed this task; start it first.');
  const now = new Date();
  const values: TaskValues = { status: to, updatedAt: now };
  if (to !== 'needs-me') values.openQuestionNoteId = null;
  if (!keepsPause(task.status, to)) values.pausedAt = null;
  // A wait that ends into Todo resumes the session (it is still under way) and tells the agent why; a wake survives the
  // claim like a pause does. A task that leaves Waiting any other way just drops the wait.
  if (task.status === 'waiting' && to === 'todo') {
    values.wokenAt = now;
    values.next = task.sessionId ? 'resume' : 'fresh';
  } else if (!keepsPause(task.status, to)) values.wokenAt = null;
  if (to !== 'waiting') {
    values.wakeAt = null;
    values.waitCheck = false;
  }
  if (change.start !== undefined) {
    values.input = change.start.input;
    values.createdBy = 'user';
    values.proposed = false;
  }
  if (to === 'running' && task.status !== 'running') {
    values.runStartedAt = now;
    values.lastActiveAt = now;
    values.lane = null;
    values.borrowed = false;
  }
  if (to !== 'running') values.runStartedAt = null;
  if (to !== 'todo') values.notBefore = null;
  if (to !== 'running') {
    values.stopRequestedAt = null;
    values.stopMessageId = null;
    values.inboxRead = false;
  }
  const place = handedBack ? 'top' : (change.place ?? (moved ? 'bottom' : undefined));
  if (typeof place === 'number') values.position = place;
  else if (place !== undefined) values.position = await edgePosition(tx, to, place);
  const [row] = await tx
    .update(tasks)
    .set({ ...values, ...change.set, ...handedBack })
    .where(eq(tasks.id, task.id))
    .returning();
  // A schedule's pending occurrence that leaves Todo, or is closed there, makes room for the next one.
  const leftTodo = task.status === 'todo' && (to !== 'todo' || (row!.closed && !task.closed));
  if (leftTodo && task.scheduleId !== null) await completeOccurrence(tx, task.id, task.scheduleId, now);
  return row!;
}

/**
 * A run that ends while messages the user sent it were never handed over must not lose them, whichever way it ends: the
 * messages stop being pending (they are replies now, which the next resume prompt carries), and a task that would have waited
 * for the user (Needs me, Done) or for something outside (Waiting) goes to the top of Todo to resume with them instead.
 * Returns the columns that override the move, or undefined when it is none of that.
 */
async function handBackPendingMessages(
  tx: DbOrTx,
  task: TaskRow,
  to: Status | undefined,
  userStop: boolean,
): Promise<TaskValues | undefined> {
  const handedOver = await tx
    .update(notes)
    .set({ pending: false })
    .where(and(eq(notes.taskId, task.id), eq(notes.pending, true)))
    .returning({ id: notes.id });
  // A run whose worker never read the inbox (a CLI before 0.9) would not find the message in the resume prompt.
  if (
    userStop ||
    !task.inboxRead ||
    handedOver.length === 0 ||
    (to !== 'needs-me' && to !== 'done' && to !== 'waiting')
  )
    return undefined;
  await systemEvent(tx, task.id, { type: 'late-message' }, null);
  return {
    next: task.sessionId ? 'resume' : 'fresh',
    openQuestionNoteId: null,
    wakeAt: null,
    waitCheck: false,
  };
}

/** A status or priority change puts the task at the bottom of its new place. */
export async function updateTask(db: DbOrTx, id: string, patch: WireTaskPatch): Promise<TaskRow> {
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
    if (patch.status !== undefined) requireNotIntoWaiting(current, patch.status);
    // The worker has read the pause and the wake by now; its first update of the run consumes them.
    if (current.status === 'running') {
      set.pausedAt = null;
      set.wokenAt = null;
    }
    return transition(tx, current, {
      to: patch.status,
      place: set.priority !== undefined ? 'bottom' : undefined,
      by: 'worker',
      set,
    });
  });
}

/** The task a machine may attach to: its session lives on that machine and no run owns it. */
export async function attachSession(db: DbOrTx, id: string, machine: string): Promise<TaskRow> {
  const task = await getTask(db, id);
  if (task.status === 'running')
    throw new AppError(
      'CONFLICT',
      'the task is running: its headless run owns the session; watch its Transcript on the task page',
    );
  if (task.sessionId === null) throw new AppError('CONFLICT', 'the task has no session');
  if (task.machine !== machine)
    throw new AppError('FORBIDDEN', `the session lives on ${task.machine ?? 'no machine'}, not on ${machine}`);
  return task;
}

/**
 * Todo to running for `machine`; the lock lets two machines claim at once and only one win.
 * A resume is pinned to the machine that holds its session, a proposal (a task that still names an agent as its creator) is
 * not for a worker to start, and a delayed task is not due before its start time.
 * Undefined when the claim is lost.
 */
export async function claimTask(db: DbOrTx, id: string, machine: string): Promise<TaskRow | undefined> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, id);
    const free =
      task.status === 'todo' &&
      !task.closed &&
      !task.proposed &&
      task.createdBy !== 'agent' &&
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
    preview?: string | null;
    suggestion?: string;
    by: string | null;
    questions?: string;
    answers?: string;
    questionNoteId?: string;
    /** A message to a running agent, waiting for its worker to hand it over. */
    pending?: boolean;
  },
): Promise<NoteRow> {
  // Only the server's own events are plain text; whatever a client wrote must arrive sealed.
  if (note.author !== 'server') requireSealed(note.body, 'the note body');
  requireSealed(note.preview, 'the note preview');
  requireSealed(note.suggestion, 'the suggestion');
  if (note.suggestion !== undefined && (note.author !== 'agent' || (note.kind ?? 'comment') !== 'comment'))
    throw new AppError('BAD_REQUEST', 'Only a comment by the agent can carry a suggestion.');
  requireSealed(note.questions, 'the questions');
  requireSealed(note.answers, 'the answers');
  await getTask(db, taskId);
  const [row] = await db
    .insert(notes)
    .values({
      id: newId(12),
      taskId,
      author: note.author,
      kind: note.kind ?? 'comment',
      body: note.body,
      preview: note.preview ?? null,
      suggestion: note.suggestion ?? null,
      by: note.by,
      questions: note.questions ?? null,
      answers: note.answers ?? null,
      questionNoteId: note.questionNoteId ?? null,
      pending: note.pending ?? false,
      queued: note.pending ?? false,
    })
    .returning();
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
  return row!;
}

/** The agent's question: a question note, and the task waits in needs-me for the answer. */
export async function ask(
  db: DbOrTx,
  taskId: string,
  asked: { body: string; questions: string },
  by: string,
): Promise<NoteRow> {
  return db.transaction(async (tx) => {
    const current = await lockTask(tx, taskId);
    // Answering a question starts the task as the user, so a proposal cannot ask one.
    if (current.proposed) throw new AppError('FORBIDDEN', 'An agent proposed this task; only you start it.');
    const note = await addNote(tx, taskId, {
      author: 'agent',
      kind: 'question',
      body: asked.body,
      by,
      questions: asked.questions,
    });
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
 * The user's answer to the open question. The server cannot read questions or answers, so it only checks that the
 * question note is the task's open one; the client checked the answers against the questions. The task goes to the top of
 * Todo and the next run resumes the agent's session with the answers.
 */
export async function answer(
  db: DbOrTx,
  input: { taskId: string; questionNoteId: string; answers: string; message: WireNoteInput; by: string },
): Promise<TaskRow> {
  requireSealed(input.answers, 'the answers');
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    requireNotRunning(task);
    if (task.openQuestionNoteId !== input.questionNoteId)
      throw new AppError('CONFLICT', 'This question was already answered or replaced.');
    const [question] = await tx
      .select({ id: notes.id, questions: notes.questions })
      .from(notes)
      .where(and(eq(notes.id, input.questionNoteId), eq(notes.taskId, task.id), eq(notes.kind, 'question')));
    if (!question?.questions) throw new AppError('NOT_FOUND', 'The question is gone.');
    await addNote(tx, task.id, {
      author: 'user',
      kind: 'answer',
      body: input.message.body,
      preview: input.message.preview ?? null,
      by: input.by,
      answers: input.answers,
      questionNoteId: question.id,
    });
    return continueTask(tx, task);
  });
}

/** A user comment; with `resume` it also sends the task back to the agent. */
export async function reply(
  db: DbOrTx,
  input: { taskId: string; message: WireNoteInput; resume: boolean; by: string },
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (input.resume) requireNotRunning(task);
    await addNote(tx, task.id, {
      author: 'user',
      kind: 'comment',
      body: input.message.body,
      preview: input.message.preview ?? null,
      by: input.by,
    });
    return input.resume ? continueTask(tx, task) : lockTask(tx, task.id);
  });
}

/**
 * The user's message. A running agent gets it without being interrupted: it waits as a pending note until the worker hands
 * it over (`runInbox`). In any other status it is "Send & continue": a reply that sends the task back to the agent.
 */
export async function send(
  db: DbOrTx,
  input: { taskId: string; message: WireNoteInput; by: string },
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.status !== 'running') return reply(tx, { ...input, resume: true });
    await addNote(tx, task.id, {
      author: 'user',
      kind: 'comment',
      body: input.message.body,
      preview: input.message.preview ?? null,
      by: input.by,
      pending: true,
    });
    return task;
  });
}

/**
 * The user's stop. A running task is asked to end its run, with an optional message that follows the interruption; the
 * worker acts on it. A resume that no worker has picked up yet, or a wait, is simply taken off the agent's hands.
 */
export async function stop(
  db: DbOrTx,
  input: { taskId: string; message?: WireNoteInput | undefined; by: string },
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.status === 'running') {
      const message =
        input.message === undefined
          ? undefined
          : await addNote(tx, task.id, {
              author: 'user',
              kind: 'comment',
              body: input.message.body,
              preview: input.message.preview ?? null,
              by: input.by,
              pending: true,
            });
      const [row] = await tx
        .update(tasks)
        .set({ stopRequestedAt: new Date(), stopMessageId: message?.id ?? null, updatedAt: new Date() })
        .where(eq(tasks.id, task.id))
        .returning();
      return row!;
    }
    if (task.status === 'todo' && task.next === 'resume' && !task.closed) {
      await systemEvent(tx, task.id, { type: 'moved', from: 'todo', to: 'needs-me' }, input.by);
      return transition(tx, task, { to: 'needs-me', by: 'user' });
    }
    if (task.status === 'waiting') {
      await systemEvent(tx, task.id, { type: 'moved', from: 'waiting', to: 'backlog' }, input.by);
      return transition(tx, task, { to: 'backlog', by: 'user' });
    }
    throw new AppError(
      'CONFLICT',
      `The task is ${task.status}; only a running, waiting or answered task can be stopped.`,
    );
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

/** An event the server writes itself, in plain text: it must never repeat anything the client sealed. */
async function systemEvent(tx: DbOrTx, taskId: string, event: ServerEvent, by: string | null): Promise<void> {
  await addNote(tx, taskId, { author: 'server', kind: 'event', body: formatServerEvent(event), by });
}

/** A system event the client wrote, sealed like any other client text. */
async function clientEvent(tx: DbOrTx, taskId: string, note: WireNoteInput, by: string): Promise<void> {
  await addNote(tx, taskId, { author: 'system', kind: 'event', body: note.body, preview: note.preview ?? null, by });
}

export async function markDone(db: DbOrTx, taskId: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireNotRunning(task);
    await systemEvent(tx, taskId, { type: 'done' }, by);
    return transition(tx, task, { to: 'done', place: 'top', by: 'user' });
  });
}

/** Start over: a new session on whichever machine claims it first. */
export async function rerunFresh(db: DbOrTx, taskId: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireNotRunning(task);
    await systemEvent(tx, taskId, { type: 'rerun' }, by);
    return transition(tx, task, {
      to: 'todo',
      place: 'bottom',
      by: 'user',
      // A fresh run is not a resume after a wait, even when it comes out of Waiting.
      set: { next: 'fresh', sessionId: null, workdir: null, closed: false, closedAt: null, wokenAt: null },
    });
  });
}

/** Closing takes a task out of the workflow; it stays readable and can be reopened. */
export async function setClosed(db: DbOrTx, taskId: string, closed: boolean, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (closed) requireNotRunning(task);
    await systemEvent(tx, taskId, { type: closed ? 'closed' : 'reopened' }, by);
    return closeOrReopen(tx, task, closed);
  });
}

function closeOrReopen(tx: DbOrTx, task: TaskRow, closed: boolean): Promise<TaskRow> {
  return transition(tx, task, {
    by: 'user',
    set: { closed, closedAt: closed ? new Date() : null },
  });
}

/**
 * Closes what has sat untouched in Done for the archive period. Returns how many tasks it closed.
 * Intake's tasks stay open: intake reads a closed task as "never again", which would block a re-requested review.
 */
export async function archiveStaleDone(db: DbOrTx, now: Date = new Date()): Promise<number> {
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
      await systemEvent(tx, id, { type: 'archived', days: DONE_ARCHIVE_DAYS }, null);
      await closeOrReopen(tx, task, true);
      closed += 1;
    });
  }
  return closed;
}

/**
 * Drag and drop: into `status`, between `afterId` (above) and `beforeId` (below), or at the bottom.
 * Nobody but a worker moves a task into or out of Running. An agent's proposal enters Todo only with `startInput`, its prompt
 * sealed again as the user's: the board stores it and takes the proposal's creator to be the user's from then on.
 */
export async function moveTask(
  db: DbOrTx,
  input: { taskId: string; status: Status; beforeId?: string; afterId?: string; startInput?: string; by: string },
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.status === 'running' && input.status !== 'running')
      throw new AppError('CONFLICT', 'The task is running. Wait until it reports back.');
    if (task.status !== 'running' && input.status === 'running')
      throw new AppError('BAD_REQUEST', 'Only a worker moves a task to Running.');
    requireNotIntoWaiting(task, input.status);
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
      await systemEvent(tx, task.id, { type: 'moved', from: task.status, to: input.status }, input.by);
    }
    if (task.priority !== priority) {
      await systemEvent(tx, task.id, { type: 'priority', from: task.priority, to: priority }, input.by);
    }
    // Into Todo it behaves like "Send & continue" without a reply: it drops the open question, and a task with a session keeps
    // its `next` (a resume with nothing to say starts fresh).
    let start: { input: string } | undefined;
    if (task.proposed && input.status === 'todo') {
      if (input.startInput === undefined)
        throw new AppError('BAD_REQUEST', 'Starting an agent’s proposal needs its prompt sealed again as yours.');
      requireSealed(input.startInput, 'the prompt');
      start = { input: input.startInput };
    }
    return transition(tx, task, {
      to: input.status,
      place: position,
      by: 'user',
      set: { priority },
      ...(start && { start }),
    });
  });
}

/**
 * The user's apply of an agent's polished title and prompt to one of their own tasks that waits (Backlog or Needs me): the new
 * title and prompt sealed as theirs, and a note of theirs holding the old text, in one transaction. `polishId` is the task that
 * made the polish note, a child of this one; it is marked done unless it is still running (its run reports back on its own).
 * A schedule's occurrence is refused: its prompt is bound to the schedule.
 */
export async function applyPolish(
  db: DbOrTx,
  input: { taskId: string; polishId: string; title: string; input: string; previous: WireNoteInput; by: string },
): Promise<TaskRow> {
  requireSealed(input.title, 'the title');
  requireSealed(input.input, 'the prompt');
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.createdBy !== 'user' || task.proposed)
      throw new AppError('FORBIDDEN', 'Only a task you created takes a polished prompt.');
    if (task.scheduleId !== null)
      throw new AppError('CONFLICT', 'A scheduled occurrence takes its prompt from its schedule.');
    if (task.closed || (task.status !== 'backlog' && task.status !== 'needs-me'))
      throw new AppError('CONFLICT', 'A polished prompt can only be applied to a task in Backlog or Needs me.');
    const polish = await lockTask(tx, input.polishId);
    if (polish.parentId !== task.id)
      throw new AppError('BAD_REQUEST', 'The polished prompt was not made for this task.');
    await addNote(tx, task.id, {
      author: 'user',
      kind: 'event',
      body: input.previous.body,
      preview: input.previous.preview ?? null,
      by: input.by,
    });
    if (polish.status !== 'running' && polish.status !== 'done') await markDone(tx, polish.id, input.by);
    const [row] = await tx
      .update(tasks)
      .set({ title: input.title, input: input.input, updatedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .returning();
    return row!;
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
export async function setPriority(db: DbOrTx, taskId: string, priority: Priority, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.priority === priority) return task;
    await systemEvent(tx, taskId, { type: 'priority', from: task.priority, to: priority }, by);
    return transition(tx, task, { place: 'bottom', by: 'user', set: { priority } });
  });
}

/** Sets or clears (null) the start time of a Todo task. */
export async function setNotBefore(db: DbOrTx, taskId: string, notBefore: Date | null, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'todo') throw new AppError('CONFLICT', `The task is ${task.status}, not in Todo.`);
    await systemEvent(
      tx,
      taskId,
      notBefore === null ? { type: 'start-cleared' } : { type: 'start-set', at: notBefore },
      by,
    );
    return transition(tx, task, { by: 'user', set: { notBefore } });
  });
}

/** The agent of a running task made a tool call. A task that stopped running in between is left alone. */
export async function heartbeat(db: DbOrTx, taskId: string, beat: Heartbeat): Promise<void> {
  await getTask(db, taskId);
  await db
    .update(tasks)
    .set({ lane: beat.lane, borrowed: beat.borrowed, lastActiveAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')));
}

/** The pull request the task's agent reported, sealed; the last one wins. */
export async function setPr(db: DbOrTx, taskId: string, pr: string): Promise<void> {
  requireSealed(pr, 'the pull request');
  await getTask(db, taskId);
  // The new PR's state is unknown; the server cannot tell whether the sealed URL is another one, so it always resets.
  await db.update(tasks).set({ pr, prState: null, updatedAt: new Date() }).where(eq(tasks.id, taskId));
}

/** GitHub's state of the task's PR, from a worker's intake. */
export async function setPrState(db: DbOrTx, taskId: string, prState: PrState): Promise<void> {
  await getTask(db, taskId);
  await db.update(tasks).set({ prState }).where(eq(tasks.id, taskId));
}

/**
 * A worker gave up the task's slot for its own lane's work. Back to Todo, ahead of new work (resumes come first),
 * and resumed in its session on the same machine.
 */
export async function pause(db: DbOrTx, taskId: string, note: WireNoteInput, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'running') throw new AppError('CONFLICT', `the task is ${task.status}, not running`);
    await clientEvent(tx, taskId, note, by);
    return transition(tx, task, {
      to: 'todo',
      place: 'top',
      by: 'worker',
      set: { next: task.sessionId ? 'resume' : 'fresh', pausedAt: new Date() },
    });
  });
}

/**
 * The agent waits for something outside (CI, a deploy): its comment goes into the thread, and the task leaves Running for
 * Waiting, freeing its slot, until `wakeAt` or until a check on its machine passes. Either way it then resumes in its session.
 */
export async function wait(
  db: DbOrTx,
  taskId: string,
  request: WireWait,
  by: string,
  now: Date = new Date(),
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'running' || task.closed)
      throw new AppError('CONFLICT', `the task is ${task.closed ? 'closed' : task.status}, not running`);
    const ahead = request.wakeAt.getTime() - now.getTime();
    if (ahead <= 0) throw new AppError('BAD_REQUEST', 'the end of the wait must lie in the future');
    if (ahead > MAX_WAIT_MS)
      throw new AppError('BAD_REQUEST', `a wait may last at most ${MAX_WAIT_MS / (24 * 60 * 60_000)} days`);
    await addNote(tx, taskId, {
      author: 'agent',
      kind: 'comment',
      body: request.body,
      preview: request.preview ?? null,
      by,
    });
    return transition(tx, task, {
      to: 'waiting',
      by: 'worker',
      set: { wakeAt: request.wakeAt, waitCheck: request.check, next: task.sessionId ? 'resume' : 'fresh' },
    });
  });
}

/** A wait ended (its time ran out, its check passed): while the task still waits, the reason goes into its thread and it resumes next. */
export async function wake(
  db: DbOrTx,
  taskId: string,
  note: WireNoteInput,
  by: string,
): Promise<{ applied: boolean; row: TaskRow }> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'waiting' || task.closed) return { applied: false, row: task };
    await clientEvent(tx, taskId, note, by);
    return { applied: true, row: await transition(tx, task, { to: 'todo', place: 'top', by: 'worker' }) };
  });
}

/** The user ends a wait early: the task resumes next, as if its wait had run out. */
export async function wakeNow(db: DbOrTx, taskId: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'waiting') throw new AppError('CONFLICT', `The task is ${task.status}, not waiting.`);
    await systemEvent(tx, taskId, { type: 'woken' }, by);
    return transition(tx, task, { to: 'todo', place: 'top', by: 'user' });
  });
}

/** A run failed: while the task still runs, the reason goes into its thread and it waits in Needs me. Otherwise nothing changes. */
export async function failTask(
  db: DbOrTx,
  taskId: string,
  note: WireNoteInput,
  by: string,
): Promise<{ applied: boolean; row: TaskRow }> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'running' || task.closed) return { applied: false, row: task };
    await clientEvent(tx, taskId, note, by);
    return { applied: true, row: await transition(tx, task, { to: 'needs-me', by: 'worker' }) };
  });
}

/**
 * A running task whose agent has been quiet for the limit has lost its worker (the machine is off, the process
 * died): only that machine could end the run, so the user may take the task back, into Needs me.
 */
export async function takeBack(db: DbOrTx, taskId: string, by: string, now: Date = new Date()): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'running') throw new AppError('CONFLICT', 'The task is not running.');
    const quietMs = task.lastActiveAt === null ? Infinity : now.getTime() - task.lastActiveAt.getTime();
    if (quietMs < TAKE_BACK_AFTER_MS)
      throw new AppError(
        'CONFLICT',
        `The agent was active ${Math.floor(quietMs / 60_000)} min ago. A task can be taken back after ${TAKE_BACK_AFTER_MS / 60_000} quiet minutes.`,
      );
    await systemEvent(tx, taskId, { type: 'taken-back', machine: task.machine }, by);
    return transition(tx, task, { to: 'needs-me', by: 'user', userStop: true });
  });
}

/** A running task's worker is `machine`; no other machine reads or acknowledges for it. */
function requireRunOf(task: TaskRow, machine: string): void {
  if (task.status !== 'running') throw new AppError('CONFLICT', `the task is ${task.status}, not running`);
  if (task.machine !== machine)
    throw new AppError('FORBIDDEN', `the task runs on ${task.machine ?? 'no machine'}, not on ${machine}`);
}

/** What the user sent to the running task: whether to stop, and the messages not yet handed to the agent, oldest first. */
export async function runInbox(
  db: DbOrTx,
  taskId: string,
  machine: string,
): Promise<{ stop: boolean; stopMessage?: string; messages: NoteRow[] }> {
  // Under the task's lock, so a Stop & send is never seen half written; reading it also marks the run as one that hands messages over.
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireRunOf(task, machine);
    if (!task.inboxRead) await tx.update(tasks).set({ inboxRead: true }).where(eq(tasks.id, taskId));
    const messages = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.taskId, taskId), eq(notes.pending, true)))
      .orderBy(asc(notes.createdAt), asc(notes.id));
    return {
      stop: task.stopRequestedAt !== null,
      ...(task.stopRequestedAt !== null && task.stopMessageId !== null ? { stopMessage: task.stopMessageId } : {}),
      messages,
    };
  });
}

/** The worker handed these messages to the agent and, with `stop`, acted on the stop request. */
export async function ackMessages(
  db: DbOrTx,
  taskId: string,
  ack: { ids: string[]; stop: boolean },
  machine: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireRunOf(task, machine);
    if (ack.ids.length > 0)
      await tx
        .update(notes)
        .set({ pending: false, deliveredAt: new Date() })
        .where(and(eq(notes.taskId, taskId), eq(notes.pending, true), inArray(notes.id, ack.ids)));
    if (ack.stop)
      await tx.update(tasks).set({ stopRequestedAt: null, stopMessageId: null }).where(eq(tasks.id, taskId));
  });
}

/**
 * The worker ended the run on the user's request: while the task still runs, the note goes into its thread and the task
 * waits in Needs me, or, with messages that were never handed over, resumes with them.
 */
export async function stopped(db: DbOrTx, taskId: string, note: WireNoteInput, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireRunOf(task, by);
    await clientEvent(tx, taskId, note, by);
    return transition(tx, task, { to: 'needs-me', by: 'worker', userStop: true });
  });
}
