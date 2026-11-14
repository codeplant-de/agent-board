import { defaultTitle, isSafeTaskId, PRIORITIES, STATUSES, type Note, type Task } from '@agent-board/shared';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { tasks, type NoteRow, type TaskRow } from '../db/schema';
import { issueToken, listMachines, revokeMachine } from '../services/machines';
import { eventOutput, listEvents, listRuns } from '../services/transcripts';
import {
  addTask,
  answer,
  getTask,
  listTasksWithLastNote,
  markDone,
  moveTask,
  readNotes,
  rerunFresh,
  reply,
  setClosed,
  setPriority,
  takeBack,
  toNote,
  toTask,
} from '../services/tasks';
import { procedure, router } from './trpc';

const id = z.string().refine(isSafeTaskId, 'not a task id');
const status = z.enum(STATUSES);
const priority = z.enum(PRIORITIES);
const createStatus = { now: 'todo', backlog: 'backlog', hold: 'needs-me' } as const;

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
  /** Each task with its newest note, for the board cards. */
  list: procedure
    .input(z.object({ closed: z.boolean().default(false) }).default({ closed: false }))
    .query(async ({ ctx, input }) => {
      const rows = await listTasksWithLastNote(ctx.db, { all: input.closed });
      return rows
        .filter(({ row }) => row.closed === input.closed)
        .map(({ row, lastNote }) => ({ ...boardTask(row, ctx.config.publicUrl), lastNote }));
    }),

  get: procedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const row = await getTask(ctx.db, input.id);
    const thread = (await readNotes(ctx.db, input.id)).map(threadNote);
    const related = await ctx.db.select().from(tasks).where(eq(tasks.parentId, input.id)).orderBy(asc(tasks.createdAt));
    const parent = row.parentId ? await getTask(ctx.db, row.parentId).catch(() => null) : null;
    return {
      task: boardTask(row, ctx.config.publicUrl),
      thread,
      followUps: related.map((r) => boardTask(r, ctx.config.publicUrl)),
      parent: parent ? boardTask(parent, ctx.config.publicUrl) : null,
    };
  }),

  /** A prompt; it runs in the default directory of whichever machine takes it. */
  create: procedure
    .input(
      z.object({
        title: z.string().trim().max(300).default(''),
        input: z.string().trim().min(1, 'Write a prompt first').max(200_000),
        priority: priority.default('normal'),
        when: z.enum(['now', 'backlog', 'hold']).default('now'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { row } = await addTask(ctx.db, {
        title: input.title || defaultTitle(input.input),
        input: input.input,
        labels: [],
        priority: input.priority,
        status: createStatus[input.when],
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
        await answer(ctx.db, {
          taskId: input.id,
          questionNoteId: input.questionNoteId,
          answers: input.answers,
          message: input.message,
          by: ctx.username,
        }),
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
    .mutation(async ({ ctx, input }) =>
      boardTask(await markDone(ctx.db, input.id, ctx.username), ctx.config.publicUrl),
    ),

  rerun: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) =>
      boardTask(await rerunFresh(ctx.db, input.id, ctx.username), ctx.config.publicUrl),
    ),

  setPriority: procedure
    .input(z.object({ id, priority }))
    .mutation(async ({ ctx, input }) =>
      boardTask(await setPriority(ctx.db, input.id, input.priority, ctx.username), ctx.config.publicUrl),
    ),

  /** A running task whose agent has been quiet too long: its worker is gone, so the task goes to Needs me. */
  takeBack: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) =>
      boardTask(await takeBack(ctx.db, input.id, ctx.username), ctx.config.publicUrl),
    ),

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

const transcriptRouter = router({
  /** A task's runs, newest first. */
  runs: procedure.input(z.object({ id })).query(({ ctx, input }) => listRuns(ctx.db, input.id)),
  /** A run's events after `afterSeq`, without tool output; poll with the last seq seen. */
  events: procedure
    .input(z.object({ runId: z.string().min(1), afterSeq: z.number().int().default(-1) }))
    .query(({ ctx, input }) => listEvents(ctx.db, input.runId, input.afterSeq)),
  /** One tool result's output, when someone opens it. */
  output: procedure
    .input(z.object({ runId: z.string().min(1), seq: z.number().int() }))
    .query(({ ctx, input }) => eventOutput(ctx.db, input.runId, input.seq)),
});

export const appRouter = router({
  transcript: transcriptRouter,
  me: procedure.query(({ ctx }) => ({ username: ctx.username })),
  tasks: tasksRouter,
  machines: machinesRouter,
});

export type AppRouter = typeof appRouter;
