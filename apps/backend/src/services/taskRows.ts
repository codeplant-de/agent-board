import { DEFAULT_PRIORITY, isSafeTaskId, type Status, type WireTaskDraft } from '@agent-board/shared';
import { eq, max, min } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { DbOrTx } from '../db/client';
import { tasks, type TaskRow } from '../db/schema';
import { AppError } from './errors';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 8 characters, safe for a systemd unit name; never one of the CLI's own unit names. */
export function newId(length = 8): string {
  for (;;) {
    const bytes = randomBytes(length);
    const id = Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
    if (isSafeTaskId(id)) return id;
  }
}

/** A position below every task of the status (`bottom`) or above all of them (`top`). */
export async function edgePosition(db: DbOrTx, status: Status, edge: 'top' | 'bottom'): Promise<number> {
  const [row] = await db
    .select({ low: min(tasks.position), high: max(tasks.position) })
    .from(tasks)
    .where(eq(tasks.status, status));
  if (edge === 'top') return row?.low == null ? 0 : row.low - 1;
  return row?.high == null ? 0 : row.high + 1;
}

export async function getTask(db: DbOrTx, id: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!row) throw new AppError('NOT_FOUND', `no task ${id.slice(0, 64)}`);
  return row;
}

/**
 * New task at the bottom of its status. A known dedupe key returns the existing task instead. The id is the caller's (a client
 * seals the task's fields against it, the server makes one for a schedule's occurrence); one that is taken, by anyone, is a conflict.
 */
export async function insertTask(
  tx: DbOrTx,
  draft: Omit<WireTaskDraft, 'id'> & { id?: string },
  extra: { scheduleId?: string } = {},
): Promise<{ row: TaskRow; created: boolean }> {
  // A follow-up is as pressing as the task it came from, unless its creator says otherwise.
  const parent = draft.parentId === undefined ? undefined : await getTask(tx, draft.parentId);
  const proposed = draft.createdBy === 'agent';
  // A proposal waits for the user whatever status the agent named.
  const status = proposed ? 'needs-me' : (draft.status ?? 'todo');
  if (draft.notBefore !== undefined && status !== 'todo')
    throw new AppError('BAD_REQUEST', 'Only a task in Todo can have a start time.');
  // A wait needs its end and a run that waits; `wait` is the only way in.
  if (status === 'waiting') throw new AppError('BAD_REQUEST', 'A new task cannot start in Waiting.');
  const [row] = await tx
    .insert(tasks)
    .values({
      id: draft.id ?? newId(),
      title: draft.title,
      input: draft.input,
      machine: draft.machine ?? null,
      workdir: draft.workdir ?? null,
      head: draft.head ?? null,
      notBefore: draft.notBefore ?? null,
      scheduleId: extra.scheduleId ?? null,
      status,
      priority: draft.priority ?? parent?.priority ?? DEFAULT_PRIORITY,
      model: draft.model ?? null,
      position: await edgePosition(tx, status, 'bottom'),
      dedupeKey: draft.dedupeKey ?? null,
      parentId: draft.parentId ?? null,
      createdBy: draft.createdBy ?? 'user',
      proposed,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { row, created: true };
  // Nothing was inserted: the dedupe key is known, or the id is taken. A taken id reads the same whoever holds it.
  const [existing] =
    draft.dedupeKey === undefined ? [] : await tx.select().from(tasks).where(eq(tasks.dedupeKey, draft.dedupeKey));
  if (!existing) throw new AppError('CONFLICT', 'that task id is already taken');
  return { row: existing, created: false };
}

export async function lockTask(tx: DbOrTx, id: string): Promise<TaskRow> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
  if (!row) throw new AppError('NOT_FOUND', `no task ${id.slice(0, 64)}`);
  return row;
}
