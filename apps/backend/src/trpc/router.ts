import { isSafeTaskId, STATUSES, type Note, type Task } from '@agent-board/shared';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { labels, notes, tasks, type NoteRow, type TaskRow } from '../db/schema';
import { AppError } from '../services/errors';
import { issueToken, listMachines, revokeMachine } from '../services/machines';
import {
  addTask,
  answer,
  getTask,
  listTasks,
  markDone,
  moveTask,
  readNotes,
  rerunFresh,
  reply,
  setClosed,
  toNote,
  toTask,
} from '../services/tasks';
import { procedure, router } from './trpc';

const id = z.string().refine(isSafeTaskId, 'not a task id');
const status = z.enum(STATUSES);

/** What the board needs of a task beyond the contract's fields. */
export interface BoardTask extends Task {
  proposed: boolean;
  createdBy: TaskRow['createdBy'];
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ThreadNote extends Note {
  by: string | null;
}

function boardTask(row: TaskRow, publicUrl: string): BoardTask {
  return {
    ...toTask(row, publicUrl),
    proposed: row.proposed,
    createdBy: row.createdBy,
    parentId: row.parentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const threadNote = (row: NoteRow): ThreadNote => ({ ...toNote(row), by: row.by });

const tasksRouter = router({
  list: procedure.input(z.object({ closed: z.boolean().default(false) }).default({ closed: false })).query(
    async ({ ctx, input }) => {
      const rows = await listTasks(ctx.db, { all: input.closed });
      return rows.filter((row) => row.closed === input.closed).map((row) => boardTask(row, ctx.config.publicUrl));
    },
  ),

  get: procedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const row = await getTask(ctx.db, input.id);
    const thread = (await readNotes(ctx.db, input.id)).map(threadNote);
    const related = await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.parentId, input.id))
      .orderBy(asc(tasks.createdAt));
    const parent = row.parentId ? await getTask(ctx.db, row.parentId).catch(() => null) : null;
    return {
      task: boardTask(row, ctx.config.publicUrl),
      thread,
      followUps: related.map((r) => boardTask(r, ctx.config.publicUrl)),
      parent: parent ? boardTask(parent, ctx.config.publicUrl) : null,
    };
  }),

  create: procedure
    .input(
      z.object({
        title: z.string().trim().min(1).max(300),
        input: z.string().max(200_000),
        label: z.string().min(1),
        start: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { row } = await addTask(ctx.db, {
        title: input.title,
        input: input.input,
        labels: [input.label],
        status: input.start ? 'todo' : 'needs-me',
        createdBy: 'user',
      });
      return boardTask(row, ctx.config.publicUrl);
    }),

  answer: procedure
    .input(
      z.object({
        id,
        questionNoteId: z.string().min(1),
        answers: z.array(z.object({ selected: z.array(z.string()), other: z.string().optional() })),
        message: z.string().max(100_000).default(''),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      boardTask(
        await answer(ctx.db, { taskId: input.id, questionNoteId: input.questionNoteId, answers: input.answers, message: input.message, by: ctx.username }),
        ctx.config.publicUrl,
      ),
    ),

  reply: procedure
    .input(z.object({ id, message: z.string().max(100_000), resume: z.boolean() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(
        await reply(ctx.db, { taskId: input.id, message: input.message, resume: input.resume, by: ctx.username }),
        ctx.config.publicUrl,
      ),
    ),

  done: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => boardTask(await markDone(ctx.db, input.id, ctx.username), ctx.config.publicUrl)),

  rerun: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => boardTask(await rerunFresh(ctx.db, input.id, ctx.username), ctx.config.publicUrl)),

  setClosed: procedure
    .input(z.object({ id, closed: z.boolean() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(await setClosed(ctx.db, input.id, input.closed, ctx.username), ctx.config.publicUrl),
    ),

  move: procedure
    .input(z.object({ id, status, beforeId: id.optional(), afterId: id.optional() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(
        await moveTask(ctx.db, {
          taskId: input.id,
          status: input.status,
          beforeId: input.beforeId,
          afterId: input.afterId,
          by: ctx.username,
        }),
        ctx.config.publicUrl,
      ),
    ),

  /** For the board cards: the newest note of each task and whether the agent is waiting on a question. */
  activity: procedure.input(z.object({ ids: z.array(id).max(500) })).query(async ({ ctx, input }) => {
    if (input.ids.length === 0) return {};
    const rows = await ctx.db
      .selectDistinctOn([notes.taskId], { taskId: notes.taskId, kind: notes.kind, author: notes.author, body: notes.body, createdAt: notes.createdAt })
      .from(notes)
      .where(inArray(notes.taskId, input.ids))
      .orderBy(notes.taskId, desc(notes.createdAt));
    return Object.fromEntries(rows.map((row) => [row.taskId, row]));
  }),
});

const labelsRouter = router({
  list: procedure.query(({ ctx }) => ctx.db.select().from(labels).orderBy(asc(labels.name))),
  update: procedure
    .input(z.object({ name: z.string().min(1), description: z.string().max(500) }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(labels)
        .set({ description: input.description })
        .where(eq(labels.name, input.name))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', `no label ${input.name}`);
      return row;
    }),
});

const machinesRouter = router({
  list: procedure.query(({ ctx }) => listMachines(ctx.db)),
  /** Returns the token once; only its hash is stored. */
  issue: procedure
    .input(z.object({ name: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => ({ token: await issueToken(ctx.db, input.name) })),
  revoke: procedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => revokeMachine(ctx.db, input.name)),
});

export const appRouter = router({
  me: procedure.query(({ ctx }) => ({ username: ctx.username })),
  tasks: tasksRouter,
  labels: labelsRouter,
  machines: machinesRouter,
});

export type AppRouter = typeof appRouter;
