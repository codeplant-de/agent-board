import type { Answer, Question } from '@agent-board/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  primaryKey,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  type AnyPgColumn,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

export const taskStatus = pgEnum('task_status', ['backlog', 'todo', 'running', 'needs-me', 'done']);
/** Declared highest first, so ordering by the enum puts urgent on top. */
export const taskPriority = pgEnum('task_priority', ['urgent', 'high', 'normal', 'low']);
export const nextRun = pgEnum('next_run', ['fresh', 'resume']);
export const taskCreator = pgEnum('task_creator', ['intake', 'user', 'agent']);
export const noteAuthor = pgEnum('note_author', ['agent', 'user', 'system']);
export const noteKind = pgEnum('note_kind', ['comment', 'question', 'answer', 'event']);

/** A signed-in user; every row below belongs to one, and a request sees only its own (`app.owner`, see db/scope.ts). */
export const appUsers = pgTable(
  'app_user',
  {
    username: text('username').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('app_user_username_not_empty', sql`${t.username} <> ''`),
    pgPolicy('tenant', {
      for: 'all',
      to: 'board_app',
      using: sql`username = (select current_setting('app.owner', true))`,
      withCheck: sql`username = (select current_setting('app.owner', true))`,
    }),
  ],
).enableRLS();

/** Defaults to the request's owner, so inserts do not name it. */
const owner = () =>
  text('owner')
    .notNull()
    .references(() => appUsers.username, { onDelete: 'cascade' })
    .default(sql`current_setting('app.owner', true)`);

/** Row-level security for a table with an `owner` column. */
const tenant = () =>
  pgPolicy('tenant', {
    for: 'all',
    to: 'board_app',
    using: sql`owner = (select current_setting('app.owner', true))`,
    withCheck: sql`owner = (select current_setting('app.owner', true))`,
  });

/**
 * A reference that includes the owner, so a row can only point at a row of its own board. Foreign-key checks bypass
 * row-level security, so a plain id reference would accept (and reveal the existence of) another user's row.
 *
 * The `set null` ones are `ON DELETE SET NULL (<the id column>)` in migration 0011: Drizzle cannot write the column
 * list, and a plain SET NULL would also try to null `owner`. drizzle-kit compares schema.ts with its snapshot, not
 * with the database, so the snapshot records `set null` for them and `generate` stays quiet.
 */
const ownerFk = (
  name: string,
  columns: [AnyPgColumn, AnyPgColumn],
  foreignColumns: [AnyPgColumn, AnyPgColumn],
  onDelete: 'set null' | 'cascade',
) => foreignKey({ name, columns, foreignColumns }).onDelete(onDelete);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tasks = pgTable(
  'task',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    title: text('title').notNull(),
    input: text('input').notNull().default(''),
    labels: text('labels')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: taskStatus('status').notNull().default('todo'),
    priority: taskPriority('priority').notNull().default('normal'),
    /** Order within a status and priority: lower is higher up. */
    position: doublePrecision('position').notNull(),
    closed: boolean('closed').notNull().default(false),
    /** When it was closed; its transcripts go 14 days later. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** The machine that claimed the task last. */
    machine: text('machine'),
    sessionId: text('session_id'),
    /** Where the session was when it last stopped, on `machine`. */
    workdir: text('workdir'),
    next: nextRun('next').notNull().default('fresh'),
    /** Reported by the worker while the task runs; stale once it stops running. */
    lane: text('lane'),
    borrowed: boolean('borrowed').notNull().default(false),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    /** When the current run was claimed; null unless running. */
    runStartedAt: timestamp('run_started_at', { withTimezone: true }),
    /** When a worker gave up the task's slot; kept through the claim until the run's first update or its end. */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** Todo only: no worker claims the task before this time. Cleared when the task leaves Todo. */
    notBefore: timestamp('not_before', { withTimezone: true }),
    /** The PR head sha an intake review was made for. */
    head: text('head'),
    /** The question note waiting for an answer, if any. */
    openQuestionNoteId: text('open_question_note_id'),
    dedupeKey: text('dedupe_key'),
    parentId: text('parent_id'),
    createdBy: taskCreator('created_by').notNull().default('user'),
    /** The schedule this task is an occurrence of. */
    scheduleId: text('schedule_id'),
    /** Proposed by an agent and not started by the user yet. */
    proposed: boolean('proposed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('task_owner_dedupe_key_unique').on(t.owner, t.dedupeKey),
    index('task_status_priority_position_idx').on(t.owner, t.status, t.priority, t.position),
    unique('task_owner_id_unique').on(t.owner, t.id),
    ownerFk('task_parent_fk', [t.owner, t.parentId], [t.owner, t.id], 'set null'),
    ownerFk('task_schedule_fk', [t.owner, t.scheduleId], [schedules.owner, schedules.id], 'set null'),
    tenant(),
  ],
).enableRLS();

/** A rule that keeps exactly one pending occurrence, a Todo task with a start time; see services/schedules.ts. */
export const schedules = pgTable(
  'schedule',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    title: text('title').notNull(),
    input: text('input').notNull(),
    priority: taskPriority('priority').notNull().default('normal'),
    machine: text('machine'),
    workdir: text('workdir'),
    /** An interval on the grid `anchor_at + k * every_ms`, or a 5-field cron expression in `timezone`. */
    everyMs: bigint('every_ms', { mode: 'number' }),
    cron: text('cron'),
    timezone: text('timezone'),
    anchorAt: timestamp('anchor_at', { withTimezone: true }).notNull(),
    /** The start time of the newest occurrence; the next one lies after it. */
    lastOccurrenceAt: timestamp('last_occurrence_at', { withTimezone: true }),
    /** Occurrences still to create; null: forever. */
    remaining: integer('remaining'),
    until: timestamp('until', { withTimezone: true }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** The pending occurrence. */
    occurrenceTaskId: text('occurrence_task_id'),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('schedule_owner_id_unique').on(t.owner, t.id),
    ownerFk('schedule_occurrence_task_fk', [t.owner, t.occurrenceTaskId], [tasks.owner, tasks.id], 'set null'),
    tenant(),
  ],
).enableRLS();

export const notes = pgTable(
  'note',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    taskId: text('task_id').notNull(),
    author: noteAuthor('author').notNull(),
    kind: noteKind('kind').notNull(),
    body: text('body').notNull().default(''),
    questions: jsonb('questions').$type<Question[]>(),
    answers: jsonb('answers').$type<Answer[]>(),
    questionNoteId: text('question_note_id'),
    /** The signed-in user for author "user", the machine for agent and system notes. */
    by: text('by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('note_task_created_idx').on(t.taskId, t.createdAt),
    ownerFk('note_task_fk', [t.owner, t.taskId], [tasks.owner, tasks.id], 'cascade'),
    tenant(),
  ],
).enableRLS();

export const machines = pgTable(
  'machine',
  {
    owner: owner(),
    name: text('name').notNull(),
    /** sha256 of the token, hex. */
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.owner, t.name] }), tenant()],
).enableRLS();

export type TaskRow = typeof tasks.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;

/** One worker run of a task: a fresh start, a resume or a re-run. */
export const transcriptRuns = pgTable(
  'transcript_run',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    taskId: text('task_id').notNull(),
    machine: text('machine').notNull(),
    sessionId: text('session_id'),
    resumed: boolean('resumed').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
    eventCount: integer('event_count').notNull().default(0),
  },
  (t) => [
    index('transcript_run_task_idx').on(t.taskId, t.startedAt),
    unique('transcript_run_owner_id_unique').on(t.owner, t.id),
    ownerFk('transcript_run_task_fk', [t.owner, t.taskId], [tasks.owner, tasks.id], 'cascade'),
    tenant(),
  ],
).enableRLS();

/** A condensed stream-json event. A tool result's output lives in its own column and is loaded only on demand. */
export const transcriptEvents = pgTable(
  'transcript_event',
  {
    owner: owner(),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    parent: text('parent'),
    /** The event without `output`. */
    data: jsonb('data').notNull(),
    output: text('output'),
    outputSize: integer('output_size'),
  },
  (t) => [
    // With the owner, so a colliding (run, seq) of another user is not visible as a duplicate-key error.
    primaryKey({ columns: [t.owner, t.runId, t.seq] }),
    ownerFk('transcript_event_run_fk', [t.owner, t.runId], [transcriptRuns.owner, transcriptRuns.id], 'cascade'),
    tenant(),
  ],
).enableRLS();
