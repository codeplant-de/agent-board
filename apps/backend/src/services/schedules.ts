import { MAX_INTERVAL_MS, type WireSchedule, type WireScheduleDraft } from '@agent-board/shared';
import { Cron } from 'croner';
import { asc, count, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { schedules, tasks, transcriptRuns, type ScheduleRow, type TaskRow } from '../db/schema';
import { AppError } from './errors';
import { requireSealed } from './sealed';
import { hasStarted, insertTask, lockTask } from './taskRows';

const MIN_INTERVAL_MS = 60_000;

/** The part of a schedule that says when it runs. */
export type Rule = Pick<ScheduleRow, 'everyMs' | 'cron' | 'timezone' | 'anchorAt' | 'until'>;

function cronOf(rule: Pick<Rule, 'cron' | 'timezone'>): Cron {
  return new Cron(rule.cron ?? '', { timezone: rule.timezone ?? undefined, paused: true, mode: '5-part' });
}

/**
 * The first run after `after` (at or after it with `inclusive`): the next point on the interval's grid, or the next
 * cron match in the rule's time zone. Null when there is none, because `until` or the expression rules it out, or
 * when it lies beyond the dates a Date can hold.
 */
export function nextOccurrence(rule: Rule, after: Date, inclusive: boolean): Date | null {
  const next =
    rule.everyMs === null
      ? nextMatch(rule, after, inclusive)
      : nextOnGrid(rule.anchorAt, rule.everyMs, after, inclusive);
  if (next === null || Number.isNaN(next.getTime())) return null;
  return rule.until !== null && next.getTime() > rule.until.getTime() ? null : next;
}

function nextOnGrid(anchor: Date, everyMs: number, after: Date, inclusive: boolean): Date {
  const steps = (after.getTime() - anchor.getTime()) / everyMs;
  const index = inclusive ? Math.ceil(steps) : Math.floor(steps) + 1;
  return new Date(anchor.getTime() + Math.max(index, 0) * everyMs);
}

function nextMatch(rule: Rule, after: Date, inclusive: boolean): Date | null {
  // croner finds the first match strictly after its argument and works in whole seconds.
  return cronOf(rule).nextRun(inclusive ? new Date(after.getTime() - 1) : after);
}

function validRule(draft: Pick<WireScheduleDraft, 'everyMs' | 'cron' | 'timezone'>): Rule['everyMs'] {
  if (draft.everyMs !== undefined) {
    if (draft.everyMs < MIN_INTERVAL_MS) throw new AppError('BAD_REQUEST', 'An interval must be at least 1 minute.');
    if (draft.everyMs > MAX_INTERVAL_MS) throw new AppError('BAD_REQUEST', 'An interval must be at most 10 years.');
    return draft.everyMs;
  }
  const cron = draft.cron ?? '';
  const timezone = draft.timezone ?? '';
  if (cron.trim().split(/\s+/).length !== 5)
    throw new AppError(
      'BAD_REQUEST',
      `"${cron.slice(0, 80)}" is not a 5-field cron expression (minute hour day month weekday).`,
    );
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new AppError(
      'BAD_REQUEST',
      `"${timezone.slice(0, 60)}" is not a time zone (use a name such as Europe/Berlin).`,
    );
  }
  try {
    cronOf({ cron, timezone });
  } catch (error) {
    throw new AppError(
      'BAD_REQUEST',
      `"${cron.slice(0, 80)}" is not a cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return null;
}

/** A schedule with the start time of its pending occurrence, which only the task knows (a delay changes it). */
export type ScheduleView = ScheduleRow & { pendingNotBefore: Date | null };

export function toSchedule(row: ScheduleView): WireSchedule {
  return {
    id: row.id,
    title: row.title,
    input: row.input,
    priority: row.priority,
    model: row.model,
    autoDone: row.autoDone,
    machine: row.machine,
    workdir: row.workdir,
    ...(row.agent === null ? {} : { agent: row.agent }),
    everyMs: row.everyMs,
    cron: row.cron,
    timezone: row.timezone,
    anchorAt: row.anchorAt,
    nextRunAt: row.occurrenceTaskId === null ? null : row.pendingNotBefore,
    remaining: row.remaining,
    until: row.until,
    paused: row.pausedAt !== null,
    ended: row.endedAt !== null,
    occurrenceTaskId: row.occurrenceTaskId,
    createdAt: row.createdAt,
  };
}

function selectViews(db: DbOrTx) {
  return db
    .select({ schedule: schedules, pendingNotBefore: tasks.notBefore })
    .from(schedules)
    .leftJoin(tasks, eq(tasks.id, schedules.occurrenceTaskId));
}

async function viewOf(tx: DbOrTx, id: string): Promise<ScheduleView> {
  const [found] = await selectViews(tx).where(eq(schedules.id, id));
  return { ...found!.schedule, pendingNotBefore: found!.pendingNotBefore };
}

async function lockSchedule(tx: DbOrTx, id: string): Promise<ScheduleRow> {
  const [row] = await tx.select().from(schedules).where(eq(schedules.id, id)).for('update');
  if (!row) throw new AppError('NOT_FOUND', `no schedule ${id.slice(0, 64)}`);
  return row;
}

/**
 * Creates the schedule's next occurrence, a Todo task that waits for its run time, and ends the schedule when there is
 * none. The run time is the first rule match after the previous occurrence that is not in the past, so runs missed while
 * nothing claimed the card are skipped. `from` starts the search there instead (a resumed schedule). The caller holds the
 * schedule's lock.
 */
async function materializeNext(
  tx: DbOrTx,
  schedule: ScheduleRow,
  now: Date,
  from?: Date,
): Promise<TaskRow | undefined> {
  const stopped = async (values: Partial<ScheduleRow>) => {
    await tx
      .update(schedules)
      .set({ occurrenceTaskId: null, ...values })
      .where(eq(schedules.id, schedule.id));
    return undefined;
  };
  if (schedule.pausedAt !== null) return stopped({});
  if (schedule.remaining === 0) return stopped({ endedAt: now });
  const rule: Rule = schedule;
  let at: Date | null;
  if (from !== undefined) at = nextOccurrence(rule, from, true);
  else if (schedule.lastOccurrenceAt === null) at = nextOccurrence(rule, schedule.anchorAt, true);
  else {
    at = nextOccurrence(rule, schedule.lastOccurrenceAt, false);
    if (at !== null && at.getTime() < now.getTime()) at = nextOccurrence(rule, now, true);
  }
  if (at === null) return stopped({ endedAt: now });
  const pinned = schedule.machine !== null && schedule.workdir !== null;
  const { row } = await insertTask(
    tx,
    {
      title: schedule.title,
      input: schedule.input,
      ...(schedule.agent === null ? {} : { agent: schedule.agent }),
      status: 'todo',
      priority: schedule.priority,
      ...(schedule.model === null ? {} : { model: schedule.model }),
      ...(schedule.autoDone ? { autoDone: true } : {}),
      notBefore: at,
      createdBy: 'user',
      ...(pinned ? { machine: schedule.machine ?? undefined, workdir: schedule.workdir ?? undefined } : {}),
    },
    { scheduleId: schedule.id },
  );
  await tx
    .update(schedules)
    .set({
      occurrenceTaskId: row.id,
      lastOccurrenceAt: at,
      remaining: schedule.remaining === null ? null : schedule.remaining - 1,
    })
    .where(eq(schedules.id, schedule.id));
  return row;
}

/** The pending occurrence `taskId` left Todo (or was closed): creates the next, unless it is no longer the pending one. */
export async function completeOccurrence(tx: DbOrTx, taskId: string, scheduleId: string, now: Date): Promise<void> {
  // A former occurrence must not take the schedule's lock: removeSchedule holds it while it locks the tasks.
  const [current] = await tx
    .select({ occurrenceTaskId: schedules.occurrenceTaskId })
    .from(schedules)
    .where(eq(schedules.id, scheduleId));
  if (current?.occurrenceTaskId !== taskId) return;
  const [schedule] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId)).for('update');
  if (schedule?.occurrenceTaskId === taskId) await materializeNext(tx, schedule, now);
}

/**
 * Creates the schedule and its first occurrence, which waits for the first run. The schedule's id is the client's, because the
 * schedule's sealed fields are bound to it; one that is taken, by anyone, is a conflict.
 */
export async function addSchedule(
  db: DbOrTx,
  draft: WireScheduleDraft,
  now: Date = new Date(),
): Promise<{ schedule: ScheduleView; task: TaskRow }> {
  const everyMs = validRule(draft);
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schedules)
      .values({
        id: draft.id,
        title: draft.title,
        input: draft.input,
        priority: draft.priority ?? 'normal',
        model: draft.model ?? null,
        autoDone: draft.autoDone ?? false,
        machine: draft.machine ?? null,
        workdir: draft.workdir ?? null,
        agent: draft.agent ?? null,
        everyMs,
        cron: draft.cron ?? null,
        timezone: draft.timezone ?? null,
        anchorAt: draft.startAt ?? now,
        remaining: draft.times ?? null,
        until: draft.until ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) throw new AppError('CONFLICT', 'that schedule id is already taken');
    const task = await materializeNext(tx, inserted, now);
    if (!task) throw new AppError('BAD_REQUEST', 'The schedule would never run: nothing matches before its end.');
    return { schedule: await viewOf(tx, inserted.id), task };
  });
}

/** Active schedules first, by when the pending card starts (one that is due now leads); paused and ended after. */
export async function listSchedules(db: DbOrTx): Promise<ScheduleView[]> {
  const rows = await selectViews(db).orderBy(
    sql`${schedules.endedAt} is not null`,
    sql`${schedules.pausedAt} is not null`,
    sql`${tasks.notBefore} asc nulls first`,
    asc(schedules.lastOccurrenceAt),
    asc(schedules.createdAt),
  );
  return rows.map(({ schedule, pendingNotBefore }) => ({ ...schedule, pendingNotBefore }));
}

/** Locks the pending occurrence, then the schedule: the order a claim takes them in. */
async function lockWithOccurrence(
  tx: DbOrTx,
  id: string,
): Promise<{ schedule: ScheduleRow; pending: TaskRow | undefined }> {
  const [unlocked] = await tx.select().from(schedules).where(eq(schedules.id, id));
  if (!unlocked) throw new AppError('NOT_FOUND', `no schedule ${id.slice(0, 64)}`);
  const pending =
    unlocked.occurrenceTaskId === null
      ? undefined
      : // Deleted since the read above: the check below turns that into a conflict.
        await lockTask(tx, unlocked.occurrenceTaskId).catch((error: unknown) => {
          if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
          throw error;
        });
  const schedule = await lockSchedule(tx, id);
  if (schedule.occurrenceTaskId !== unlocked.occurrenceTaskId)
    throw new AppError('CONFLICT', 'The schedule changed while it was being edited; try again.');
  return { schedule, pending };
}

/** Deletes the pending occurrence when it never ran: waiting in Todo, no session, no run. True when it is gone. */
async function removePending(tx: DbOrTx, pending: TaskRow | undefined): Promise<boolean> {
  if (pending === undefined || pending.status !== 'todo' || pending.sessionId !== null) return false;
  const [runs] = await tx.select({ n: count() }).from(transcriptRuns).where(eq(transcriptRuns.taskId, pending.id));
  if ((runs?.n ?? 0) > 0) return false;
  await tx.delete(tasks).where(eq(tasks.id, pending.id));
  return true;
}

/** Pausing takes the pending occurrence off the board if it never ran; resuming creates the next one, from now. */
export async function setPaused(
  db: DbOrTx,
  id: string,
  paused: boolean,
  now: Date = new Date(),
): Promise<ScheduleView> {
  return db.transaction(async (tx) => {
    const { schedule, pending } = await lockWithOccurrence(tx, id);
    if (schedule.endedAt !== null) throw new AppError('CONFLICT', 'The schedule has ended.');
    if (paused === (schedule.pausedAt !== null)) return viewOf(tx, id);
    if (paused) {
      const removed = await removePending(tx, pending);
      await tx
        .update(schedules)
        .set({
          pausedAt: now,
          ...(removed
            ? { occurrenceTaskId: null, remaining: schedule.remaining === null ? null : schedule.remaining + 1 }
            : {}),
        })
        .where(eq(schedules.id, id));
    } else {
      const resumed = { ...schedule, pausedAt: null };
      await tx.update(schedules).set({ pausedAt: null }).where(eq(schedules.id, id));
      // Never before the start time: the cron path does not clamp to the anchor as the interval grid does.
      const from = schedule.anchorAt.getTime() > now.getTime() ? schedule.anchorAt : now;
      if (resumed.occurrenceTaskId === null) await materializeNext(tx, resumed, now, from);
    }
    return viewOf(tx, id);
  });
}

/** Deletes the schedule and its never-run pending occurrence. Tasks that ran stay, still naming it: their sealed fields are bound to its id. */
export async function removeSchedule(db: DbOrTx, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const { pending } = await lockWithOccurrence(tx, id);
    await removePending(tx, pending);
    await tx.delete(schedules).where(eq(schedules.id, id));
  });
}

/**
 * A new title and prompt for the schedule, sealed in the browser under its binding; the next occurrences copy them. The
 * pending card takes them too while it waits in Todo and has not started, so the next run uses them.
 */
export async function editSchedule(
  db: DbOrTx,
  input: { id: string; title: string; input: string },
): Promise<{ schedule: ScheduleView; pending: 'updated' | 'started' | 'none' }> {
  requireSealed(input.title, 'the title');
  requireSealed(input.input, 'the prompt');
  return db.transaction(async (tx) => {
    const { schedule, pending } = await lockWithOccurrence(tx, input.id);
    if (schedule.endedAt !== null) throw new AppError('CONFLICT', 'The schedule has ended.');
    const now = new Date();
    await tx.update(schedules).set({ title: input.title, input: input.input }).where(eq(schedules.id, schedule.id));
    if (pending === undefined) return { schedule: await viewOf(tx, schedule.id), pending: 'none' };
    const editable = pending.status === 'todo' && !pending.closed && !hasStarted(pending);
    if (editable)
      await tx
        .update(tasks)
        .set({ title: input.title, input: input.input, updatedAt: now })
        .where(eq(tasks.id, pending.id));
    return { schedule: await viewOf(tx, schedule.id), pending: editable ? 'updated' : 'started' };
  });
}
