import type { TranscriptBatch, TranscriptEvent, TranscriptEventView } from '@agent-board/shared';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { tasks, transcriptEvents, transcriptRuns } from '../db/schema';
import { AppError } from './errors';
import { getTask } from './tasks';

/** Closed tasks keep their transcripts this long. */
export const TRANSCRIPT_RETENTION_DAYS = 14;

/** Stores a batch; a retried batch (same run and seq) changes nothing. */
export async function appendTranscript(db: Db, taskId: string, machine: string, batch: TranscriptBatch): Promise<void> {
  await getTask(db, taskId);
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(transcriptRuns).where(eq(transcriptRuns.id, batch.runId));
    if (existing && existing.taskId !== taskId) throw new AppError('BAD_REQUEST', 'the run belongs to another task');
    const last = batch.events.at(-1)?.at;
    await tx
      .insert(transcriptRuns)
      .values({
        id: batch.runId,
        taskId,
        machine,
        sessionId: batch.sessionId,
        resumed: batch.resumed,
        startedAt: new Date(batch.startedAt),
        lastEventAt: last ? new Date(last) : new Date(batch.startedAt),
      })
      .onConflictDoNothing();
    if (batch.events.length === 0) return;
    const inserted = await tx
      .insert(transcriptEvents)
      .values(
        batch.events.map((event) => {
          const { output, ...data } = event as TranscriptEvent & { output?: string };
          return {
            runId: batch.runId,
            seq: event.seq,
            at: new Date(event.at),
            kind: event.kind,
            parent: event.parent,
            data,
            output: event.kind === 'tool_result' ? (output ?? '') : null,
            outputSize: event.kind === 'tool_result' ? (output ?? '').length : null,
          };
        }),
      )
      .onConflictDoNothing()
      .returning({ seq: transcriptEvents.seq });
    await tx
      .update(transcriptRuns)
      .set({
        eventCount: sql`${transcriptRuns.eventCount} + ${inserted.length}`,
        ...(last ? { lastEventAt: sql`greatest(${transcriptRuns.lastEventAt}, ${new Date(last).toISOString()}::timestamptz)` } : {}),
      })
      .where(eq(transcriptRuns.id, batch.runId));
  });
}

export async function listRuns(db: Db, taskId: string) {
  return db
    .select()
    .from(transcriptRuns)
    .where(eq(transcriptRuns.taskId, taskId))
    .orderBy(desc(transcriptRuns.startedAt));
}

/** Events after `afterSeq`, without tool output: a result says how long its output is instead. */
export async function listEvents(db: Db, runId: string, afterSeq: number, limit = 2000) {
  const rows = await db
    .select({ seq: transcriptEvents.seq, data: transcriptEvents.data, outputSize: transcriptEvents.outputSize })
    .from(transcriptEvents)
    .where(and(eq(transcriptEvents.runId, runId), gt(transcriptEvents.seq, afterSeq)))
    .orderBy(asc(transcriptEvents.seq))
    .limit(limit);
  return rows.map((row) => ({ ...(row.data as object), outputSize: row.outputSize }) as TranscriptEventView);
}

export async function eventOutput(db: Db, runId: string, seq: number): Promise<string> {
  const [row] = await db
    .select({ output: transcriptEvents.output })
    .from(transcriptEvents)
    .where(and(eq(transcriptEvents.runId, runId), eq(transcriptEvents.seq, seq)));
  if (!row) throw new AppError('NOT_FOUND', 'no such event');
  return row.output ?? '';
}

/** Deletes the transcripts of tasks closed more than the retention ago. Returns how many runs went. */
export async function deleteOldTranscripts(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60_000);
  // A task closed before closedAt existed counts from its last change.
  const old = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.closed, true), lt(sql`coalesce(${tasks.closedAt}, ${tasks.updatedAt})`, cutoff)));
  const gone = await db.delete(transcriptRuns).where(inArray(transcriptRuns.taskId, old)).returning({ id: transcriptRuns.id });
  return gone.length;
}
