import type { Answer, Question } from '@agent-board/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const taskStatus = pgEnum('task_status', ['todo', 'running', 'needs-me', 'done']);
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
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    status: taskStatus('status').notNull().default('todo'),
    /** Order within a status: lower is higher up. */
    position: doublePrecision('position').notNull(),
    closed: boolean('closed').notNull().default(false),
    /** The machine that claimed the task last. */
    machine: text('machine'),
    sessionId: text('session_id'),
    next: nextRun('next').notNull().default('fresh'),
    /** The question note waiting for an answer, if any. */
    openQuestionNoteId: text('open_question_note_id'),
    dedupeKey: text('dedupe_key').unique(),
    parentId: text('parent_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
    createdBy: taskCreator('created_by').notNull().default('user'),
    /** Proposed by an agent and not started by the user yet. */
    proposed: boolean('proposed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('task_status_position_idx').on(t.status, t.position)],
);

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

export const labels = pgTable('label', {
  name: text('name').primaryKey(),
  description: text('description').notNull().default(''),
  createdAt: createdAt(),
});

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
