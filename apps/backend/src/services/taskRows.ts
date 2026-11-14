import { DEFAULT_PRIORITY, isSafeTaskId, promptSkill, type Status, type TaskDraft } from '@agent-board/shared';
import { eq, max, min } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { DbOrTx } from '../db/client';
import { tasks, type TaskRow } from '../db/schema';
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

/** New task at the bottom of its status. A known dedupe key returns the existing task instead. */
export async function insertTask(
  tx: DbOrTx,
  draft: TaskDraft,
  extra: { scheduleId?: string } = {},
): Promise<{ row: TaskRow; created: boolean }> {
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
      scheduleId: extra.scheduleId ?? null,
      status,
      priority: draft.priority ?? parent?.priority ?? DEFAULT_PRIORITY,
      position: await edgePosition(tx, status, 'bottom'),
      dedupeKey: draft.dedupeKey ?? null,
      parentId: draft.parentId ?? null,
      createdBy: draft.createdBy ?? 'user',
      proposed,
    })
    .onConflictDoNothing({ target: [tasks.owner, tasks.dedupeKey] })
    .returning();
  if (row) return { row, created: true };
  const [existing] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.dedupeKey, draft.dedupeKey ?? ''));
  if (!existing) throw new AppError('CONFLICT', 'the task was created and removed at once; try again');
  return { row: existing, created: false };
}

export async function lockTask(tx: DbOrTx, id: string): Promise<TaskRow> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
  if (!row) throw new AppError('NOT_FOUND', `no task ${id.slice(0, 64)}`);
  return row;
}
