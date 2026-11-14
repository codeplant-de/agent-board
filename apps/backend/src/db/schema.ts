import type { Answer, Question } from '@agent-board/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  primaryKey,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const taskStatus = pgEnum('task_status', ['backlog', 'todo', 'running', 'needs-me', 'done']);
/** Declared highest first, so ordering by the enum puts urgent on top. */
export const taskPriority = pgEnum('task_priority', ['urgent', 'high', 'normal', 'low']);
export const nextRun = pgEnum('next_run', ['fresh', 'resume']);
export const taskCreator = pgEnum('task_creator', ['intake', 'user', 'agent']);
export const noteAuthor = pgEnum('note_author', ['agent', 'user', 'system']);
export const noteKind = pgEnum('note_kind', ['comment', 'question', 'answer', 'event']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tasks = pgTable(
  'task',
  {
    id: text('id').primaryKey(),
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
    dedupeKey: text('dedupe_key').unique(),
    parentId: text('parent_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
    createdBy: taskCreator('created_by').notNull().default('user'),
    /** The schedule this task is an occurrence of. */
    scheduleId: text('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    /** Proposed by an agent and not started by the user yet. */
    proposed: boolean('proposed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('task_status_priority_position_idx').on(t.status, t.priority, t.position)],
);

/** A rule that keeps exactly one pending occurrence, a Todo task with a start time; see services/schedules.ts. */
export const schedules = pgTable('schedule', {
  id: text('id').primaryKey(),
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
  occurrenceTaskId: text('occurrence_task_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const notes = pgTable(
  'note',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
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
  (t) => [index('note_task_created_idx').on(t.taskId, t.createdAt)],
);

export const machines = pgTable('machine', {
  name: text('name').primaryKey(),
  /** sha256 of the token, hex. */
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export type TaskRow = typeof tasks.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;

/** One worker run of a task: a fresh start, a resume or a re-run. */
export const transcriptRuns = pgTable(
  'transcript_run',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    machine: text('machine').notNull(),
    sessionId: text('session_id'),
    resumed: boolean('resumed').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
    eventCount: integer('event_count').notNull().default(0),
  },
  (t) => [index('transcript_run_task_idx').on(t.taskId, t.startedAt)],
);

/** A condensed stream-json event. A tool result's output lives in its own column and is loaded only on demand. */
export const transcriptEvents = pgTable(
  'transcript_event',
  {
    runId: text('run_id')
      .notNull()
      .references(() => transcriptRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    parent: text('parent'),
    /** The event without `output`. */
    data: jsonb('data').notNull(),
    output: text('output'),
    outputSize: integer('output_size'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);
