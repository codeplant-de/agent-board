import {
  ContractError,
  isModelName,
  isSafeMachineName,
  isSafeTaskId,
  parseKeyId,
  parseKeySlots,
  parseSealed,
  PRIORITIES,
  STATUSES,
  type Field,
  type WireNote,
  type WireTask,
  MAX_INT32,
  MAX_INTERVAL_MS,
} from '@agent-board/shared';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { tasks, type NoteRow, type TaskRow } from '../db/schema';
import { getKeys, replaceSlots, setupKeys } from '../services/keys';
import { getLink, listInbox, peekLinkCode, redeemLinkCode, removeInboxItem, removeLink } from '../services/slack';
import { issueToken, listMachines, revokeMachine } from '../services/machines';
import { addSchedule, listSchedules, removeSchedule, setPaused, toSchedule } from '../services/schedules';
import { eventOutput, listEvents, listRuns } from '../services/transcripts';
import {
  addTask,
  answer,
  applyPolish,
  configureTask,
  getTask,
  listTasksWithLastNote,
  type LastNote,
  markDone,
  moveTask,
  readNotes,
  rerunFresh,
  reply,
  send,
  setClosed,
  setNotBefore,
  setPriority,
  stop,
  takeBack,
  toNote,
  listTaskPrs,
  toTask,
  wakeNow,
} from '../services/tasks';
import { AppError } from '../services/errors';
import { procedure, router } from './trpc';

const id = z.string().refine(isSafeTaskId, 'not a task id');
const status = z.enum(STATUSES);
const priority = z.enum(PRIORITIES);
const model = z.string().refine(isModelName, 'not a model name');
const repeatEnd = {
  at: z.coerce.date().optional(),
  times: z.number().int().positive().max(MAX_INT32).optional(),
  until: z.coerce.date().optional(),
};
/** A repeat: an interval in ms, or a cron expression with its time zone; `at` is the first run. */
const repeat = z
  .union([
    z.object({ every: z.number().int().min(60_000).max(MAX_INTERVAL_MS), ...repeatEnd }),
    z.object({ cron: z.string().trim().min(1), timezone: z.string().trim().min(1), ...repeatEnd }),
  ])
  .refine(
    (when) => when.times === undefined || when.until === undefined,
    'Give a number of runs or an end time, not both',
  );
/** Runs a shared parser as a zod check, so a bad value is a BAD_REQUEST with the parser's reason. */
const parsedBy = <S extends z.ZodType, T>(source: S, parse: (value: z.output<S>) => T) =>
  source.transform((value, ctx) => {
    try {
      return parse(value);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      ctx.addIssue({ code: 'custom', message: error.message });
      return z.NEVER;
    }
  });
const keyId = parsedBy(z.unknown(), parseKeyId);
const keySlots = parsedBy(z.unknown(), parseKeySlots);
/** A sealed value (an envelope within the field's size limit): the server checks nothing else about it. */
const sealed = (field: Field, what: string) => parsedBy(z.string(), (value) => parseSealed(value, field, what));
/** A note's sealed text and, optionally, the sealed start of it for the board card. */
const noteInput = z.object({
  body: sealed('note.body', 'message'),
  preview: sealed('note.preview', 'preview').nullish(),
});
/** A machine name as the worker checks it: it reaches argv and unit names there, so the board takes no other shape. */
const machineName = z.string().refine(isSafeMachineName, 'not a safe machine name');
const createStatus = { now: 'todo', backlog: 'backlog', hold: 'needs-me' } as const;

/** What the board needs of a task beyond the contract's fields. `title`, `input` and `workdir` are still sealed. */
export interface WireBoardTask extends WireTask {
  proposed: boolean;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A note of a thread; `body`, `preview`, `questions` and `answers` are sealed, except the body of a note by the server. */
export interface WireThreadNote extends WireNote {
  by: string | null;
}

export type { LastNote };

function toBoardTask(row: TaskRow, prs: Parameters<typeof toTask>[1]): WireBoardTask {
  return {
    ...toTask(row, prs),
    proposed: row.proposed,
    parentId: row.parentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function boardTasks(db: DbOrTx, rows: TaskRow[]): Promise<WireBoardTask[]> {
  const prs = await listTaskPrs(
    db,
    rows.map(({ id }) => id),
  );
  return rows.map((row) => toBoardTask(row, prs.get(row.id)));
}

async function boardTask(db: DbOrTx, row: TaskRow): Promise<WireBoardTask> {
  return toBoardTask(row, (await listTaskPrs(db, [row.id])).get(row.id));
}

const threadNote = (row: NoteRow): WireThreadNote => ({ ...toNote(row), by: row.by });

const tasksRouter = router({
  /** Each task with its newest note, for the board cards. */
  list: procedure
    .input(z.object({ closed: z.boolean().default(false) }).default({ closed: false }))
    .query(async ({ ctx, input }) => {
      const rows = await listTasksWithLastNote(ctx.db, { closed: input.closed });
      const prs = await listTaskPrs(
        ctx.db,
        rows.map(({ row }) => row.id),
      );
      return rows.map(({ row, lastNote }) => ({ ...toBoardTask(row, prs.get(row.id)), lastNote }));
    }),

  get: procedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const row = await getTask(ctx.db, input.id);
    const thread = (await readNotes(ctx.db, input.id)).map(threadNote);
    const related = await ctx.db.select().from(tasks).where(eq(tasks.parentId, input.id)).orderBy(asc(tasks.createdAt));
    const parent = row.parentId ? await getTask(ctx.db, row.parentId) : null;
    return {
      task: await boardTask(ctx.db, row),
      thread,
      followUps: await boardTasks(ctx.db, related),
      parent: parent ? await boardTask(ctx.db, parent) : null,
    };
  }),

  /**
   * A sealed prompt with its sealed title; it runs in the default directory of whichever machine takes it, or, with `place`,
   * only on that machine and in that sealed directory (a polish task runs where its Backlog task would; a repeating task's
   * occurrences all do). `id` is the task's, or the schedule's when `when` repeats (its occurrences get ids of the server's):
   * the fields are sealed against it.
   */
  create: procedure
    .input(
      z.object({
        id,
        title: sealed('title', 'title'),
        input: sealed('input', 'input'),
        priority: priority.default('normal'),
        /** The Claude model of its runs; absent is claude's default. */
        model: model.optional(),
        /** The task this one follows from, which must be on the board. */
        parentId: id.optional(),
        when: z.union([repeat, z.enum(['now', 'backlog', 'hold']), z.object({ at: z.coerce.date() })]).default('now'),
        /** The machine and the sealed directory the task runs in, or its schedule's occurrences (sealed for the schedule). */
        place: z.object({ machine: machineName, workdir: sealed('workdir', 'directory') }).optional(),
        /** The sealed name of the agent the task, or each occurrence of its schedule, runs as; the prompt is sealed under it too. */
        agent: sealed('agent', 'agent').optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { title, when, place, agent } = input;
      if (typeof when === 'object' && ('every' in when || 'cron' in when)) {
        const { task } = await addSchedule(ctx.db, {
          id: input.id,
          title,
          input: input.input,
          priority: input.priority,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(place === undefined ? {} : { machine: place.machine, workdir: place.workdir }),
          ...(agent === undefined ? {} : { agent }),
          ...('every' in when ? { everyMs: when.every } : { cron: when.cron, timezone: when.timezone }),
          ...(when.at ? { startAt: when.at } : {}),
          ...(when.times ? { times: when.times } : {}),
          ...(when.until ? { until: when.until } : {}),
        });
        return boardTask(ctx.db, task);
      }
      const { row } = await addTask(ctx.db, {
        id: input.id,
        title,
        input: input.input,
        priority: input.priority,
        ...(input.model === undefined ? {} : { model: input.model }),
        status: typeof when === 'string' ? createStatus[when] : 'todo',
        notBefore: typeof when === 'string' ? undefined : when.at,
        createdBy: 'user',
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        ...(place === undefined ? {} : { machine: place.machine, workdir: place.workdir }),
        ...(agent === undefined ? {} : { agent }),
      });
      return boardTask(ctx.db, row);
    }),

  answer: procedure
    .input(
      z.object({
        id,
        questionNoteId: z.string().min(1),
        answers: sealed('note.answers', 'answers'),
        message: noteInput,
      }),
    )
    .mutation(async ({ ctx, input }) =>
      boardTask(
        ctx.db,
        await answer(ctx.db, {
          taskId: input.id,
          questionNoteId: input.questionNoteId,
          answers: input.answers,
          message: input.message,
          by: ctx.username,
        }),
      ),
    ),

  reply: procedure
    .input(z.object({ id, message: noteInput, resume: z.boolean() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(
        ctx.db,
        await reply(ctx.db, { taskId: input.id, message: input.message, resume: input.resume, by: ctx.username }),
      ),
    ),

  /**
   * "Send": a sealed message to the agent. On a running task it reaches the agent without interrupting it; in any other
   * status it is "Send & continue".
   */
  send: procedure
    .input(z.object({ id, message: noteInput }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await send(ctx.db, { taskId: input.id, message: input.message, by: ctx.username })),
    ),

  /**
   * "Stop" (and "Stop & send" with `message`, a sealed message that follows the interruption): a running task's run is
   * interrupted; an answered task that has not started again goes to Needs me, and a waiting one to Backlog.
   */
  stop: procedure
    .input(z.object({ id, message: noteInput.optional() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await stop(ctx.db, { taskId: input.id, message: input.message, by: ctx.username })),
    ),

  /**
   * Applies an agent's polished title and prompt (sealed again as the user's) to the task `id`, keeps the old text in a note
   * of the user's (`previous`), and marks the polishing task `polishId` done.
   */
  applyPolish: procedure
    .input(
      z.object({
        id,
        polishId: id,
        title: sealed('title', 'title'),
        input: sealed('input', 'prompt'),
        previous: noteInput,
      }),
    )
    .mutation(async ({ ctx, input }) =>
      boardTask(
        ctx.db,
        await applyPolish(ctx.db, {
          taskId: input.id,
          polishId: input.polishId,
          title: input.title,
          input: input.input,
          previous: input.previous,
          by: ctx.username,
        }),
      ),
    ),

  done: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => boardTask(ctx.db, await markDone(ctx.db, input.id, ctx.username))),

  rerun: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => boardTask(ctx.db, await rerunFresh(ctx.db, input.id, ctx.username))),

  setPriority: procedure
    .input(z.object({ id, priority }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await setPriority(ctx.db, input.id, input.priority, ctx.username)),
    ),

  /**
   * Changes a task's settings after creation. A `place` pins it to the machine and the sealed directory (null: none) and drops
   * its session, so the next run starts fresh there; a running or waiting task is refused with CONFLICT. A model applies from the next run on.
   */
  configure: procedure
    .input(
      z
        .object({
          id,
          priority: priority.optional(),
          model: model.nullable().optional(),
          place: z
            .object({ machine: machineName, workdir: sealed('workdir', 'directory') })
            .nullable()
            .optional(),
        })
        .refine(
          ({ priority: p, model: m, place }) => p !== undefined || m !== undefined || place !== undefined,
          'change at least one of priority, model and place',
        ),
    )
    .mutation(async ({ ctx, input: { id: taskId, ...config } }) =>
      boardTask(ctx.db, await configureTask(ctx.db, taskId, config, ctx.username)),
    ),

  /** Delays a Todo task until `notBefore`; null makes it claimable now. */
  setNotBefore: procedure
    .input(z.object({ id, notBefore: z.coerce.date().nullable() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await setNotBefore(ctx.db, input.id, input.notBefore, ctx.username)),
    ),

  /** Ends a wait early: the task resumes next in its session. */
  wakeNow: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => boardTask(ctx.db, await wakeNow(ctx.db, input.id, ctx.username))),

  /** A running task whose agent has been quiet too long: its worker is gone, so the task goes to Needs me. */
  takeBack: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => boardTask(ctx.db, await takeBack(ctx.db, input.id, ctx.username))),

  setClosed: procedure
    .input(z.object({ id, closed: z.boolean() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await setClosed(ctx.db, input.id, input.closed, ctx.username)),
    ),

  move: procedure
    .input(
      z.object({
        id,
        status,
        beforeId: id.optional(),
        afterId: id.optional(),
        /** Into Todo, an agent's proposal needs its prompt sealed again as the user's. */
        startInput: sealed('input', 'prompt').optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      boardTask(
        ctx.db,
        await moveTask(ctx.db, {
          taskId: input.id,
          status: input.status,
          beforeId: input.beforeId,
          afterId: input.afterId,
          startInput: input.startInput,
          by: ctx.username,
        }),
      ),
    ),
});

const schedulesRouter = router({
  list: procedure.query(async ({ ctx }) => (await listSchedules(ctx.db)).map(toSchedule)),
  setPaused: procedure
    .input(z.object({ id, paused: z.boolean() }))
    .mutation(async ({ ctx, input }) => toSchedule(await setPaused(ctx.db, input.id, input.paused))),
  remove: procedure.input(z.object({ id })).mutation(({ ctx, input }) => removeSchedule(ctx.db, input.id)),
});

const machinesRouter = router({
  list: procedure.query(({ ctx }) => listMachines(ctx.db, ctx.config.cliVersion)),
  /** The newest CLI release this server knows of, x.y.z, or null. */
  advertisedCli: procedure.query(({ ctx }) => ctx.config.cliVersion),
  /** Returns the token once; only its hash is stored. */
  issue: procedure
    .input(z.object({ name: z.string().min(1).max(256) }))
    .mutation(async ({ ctx, input }) => ({ token: await issueToken(ctx.db, input.name) })),
  // Any name: a token issued before names were restricted must stay revocable, whatever its name.
  revoke: procedure
    .input(z.object({ name: z.string().min(1).max(256) }))
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

const keysRouter = router({
  /** The key id and the wrapped copies of the data key, or null before setup. The server cannot open them. */
  get: procedure.query(({ ctx }) => getKeys(ctx.db)),
  setup: procedure.input(z.object({ keyId, slots: keySlots })).mutation(({ ctx, input }) => setupKeys(ctx.db, input)),
  replaceSlots: procedure
    .input(z.object({ keyId, slots: keySlots }))
    .mutation(({ ctx, input }) => replaceSlots(ctx.db, input)),
});

const slackCode = z.string().min(1).max(256);

const slackRouter = router({
  /** Whether the Slack intake API is on, and the Slack account this board user is linked to. */
  status: procedure.query(async ({ ctx }) => {
    const link = await getLink(ctx.db);
    return {
      enabled: ctx.config.intake !== null,
      link: link && { slackUserId: link.slackUserId, displayName: link.displayName, createdAt: link.createdAt },
    };
  }),
  /** Whom a code from `/board link` was issued to, for the confirmation page. */
  peekLink: procedure.input(z.object({ code: slackCode })).query(async ({ ctx, input }) => {
    const who = await peekLinkCode(ctx.db, input.code);
    if (!who) throw new AppError('NOT_FOUND', 'This link has expired or was already used. Send /board link again.');
    return who;
  }),
  confirmLink: procedure
    .input(z.object({ code: slackCode }))
    .mutation(({ ctx, input }) => redeemLinkCode(ctx.db, input.code)),
  unlink: procedure.mutation(({ ctx }) => removeLink(ctx.db)),
  inbox: router({
    /** Proposals from Slack, in clear text by design. */
    list: procedure.query(async ({ ctx }) =>
      (await listInbox(ctx.db)).map(({ id, text, createdAt }) => ({ id, text, createdAt })),
    ),
    remove: procedure
      .input(z.object({ id: z.string().min(1).max(64) }))
      .mutation(({ ctx, input }) => removeInboxItem(ctx.db, input.id)),
  }),
});

export const appRouter = router({
  transcript: transcriptRouter,
  me: procedure.query(async ({ ctx }) => ({ username: ctx.username, keyId: (await getKeys(ctx.db))?.keyId ?? null })),
  keys: keysRouter,
  tasks: tasksRouter,
  schedules: schedulesRouter,
  machines: machinesRouter,
  slack: slackRouter,
});

export type AppRouter = typeof appRouter;
