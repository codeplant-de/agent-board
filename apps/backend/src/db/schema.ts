import { INBOX_TEXT_MAX, type KeySlot } from '@agent-board/shared';
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
import { BLIND_INDEX_PATTERN, ENVELOPE_PATTERN } from './sealedColumns';

export const taskStatus = pgEnum('task_status', ['backlog', 'todo', 'running', 'waiting', 'needs-me', 'done']);
/** Declared highest first, so ordering by the enum puts urgent on top. */
export const taskPriority = pgEnum('task_priority', ['urgent', 'high', 'normal', 'low']);
export const nextRun = pgEnum('next_run', ['fresh', 'resume']);
export const prState = pgEnum('pr_state', ['open', 'merged', 'closed']);
export const taskCreator = pgEnum('task_creator', ['intake', 'user', 'agent']);
/** "server" is the only author whose body is plain text: the events the server writes itself. Every other note body is sealed. */
export const noteAuthor = pgEnum('note_author', ['agent', 'user', 'system', 'server']);
export const noteKind = pgEnum('note_kind', ['comment', 'question', 'answer', 'event', 'polish']);

/** A signed-in user; every row below belongs to one, and a request sees only its own (`app.owner`, see db/scope.ts). */
export const appUsers = pgTable(
  'app_user',
  {
    username: text('username').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Fingerprint of the user's data key and its wrapped copies; both stay null until encryption is set up. */
    keyId: text('key_id'),
    keySlots: jsonb('key_slots').$type<KeySlot[]>(),
  },
  (t) => [
    check('app_user_username_not_empty', sql`${t.username} <> ''`),
    check('app_user_key_all_or_nothing', sql`(${t.keyId} is null) = (${t.keySlots} is null)`),
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

const isEnvelope = (column: AnyPgColumn) => sql`${column} ~ ${sql.raw(`'${ENVELOPE_PATTERN}'`)}`;
const isBlindIndex = (column: AnyPgColumn) => sql`${column} ~ ${sql.raw(`'${BLIND_INDEX_PATTERN}'`)}`;

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
/**
 * `now()` is the start of the transaction, so the notes one request writes (a move and its priority change, the hourly
 * cleanup of a board) would share a timestamp and fall back to the random id for their order. The wall clock keeps
 * them in write order.
 */
const writtenAt = () =>
  timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`);

export const tasks = pgTable(
  'task',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    /** `title`, `input` and `workdir` hold sealed envelopes (abe1.…); the server never reads them. */
    title: text('title').notNull(),
    input: text('input').notNull(),
    status: taskStatus('status').notNull().default('todo'),
    priority: taskPriority('priority').notNull().default('normal'),
    /** The Claude model of its runs (a clear choice, not content); null is claude's default. */
    model: text('model'),
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
    /** The sealed `workdir` the task was created with, as the same envelope; nothing updates it, and Re-run fresh restores it into `workdir`. */
    homeWorkdir: text('home_workdir'),
    /** The sealed name of the agent the task runs as; null runs as the user's config says. Written once, at creation. */
    agent: text('agent'),
    /** No longer read or written: the PRs are in `task_pr`. Kept so the previous backend image still runs on this database; a later migration drops it. */
    pr: text('pr'),
    /** GitHub's state of the PR the prompt names, as a worker's dispatcher last saw it. Clear on purpose: it says only that some PR of the task merged. */
    prState: prState('pr_state'),
    next: nextRun('next').notNull().default('fresh'),
    /** Reported by the worker while the task runs; stale once it stops running. */
    lane: text('lane'),
    borrowed: boolean('borrowed').notNull().default(false),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    /** When the current run was claimed; null unless running. */
    runStartedAt: timestamp('run_started_at', { withTimezone: true }),
    /** The current run's id, new with every claim; null unless running. A call that names a run is refused for another one. */
    runId: text('run_id'),
    /** When a worker gave up the task's slot; kept through the claim until the run's first update or its end. */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** Todo only: no worker claims the task before this time. Cleared when the task leaves Todo. */
    notBefore: timestamp('not_before', { withTimezone: true }),
    /** Waiting only: the wait ends at this time at the latest. Cleared when the task leaves Waiting. */
    wakeAt: timestamp('wake_at', { withTimezone: true }),
    /** Waiting only: a check on `machine` may end the wait early. */
    waitCheck: boolean('wait_check').notNull().default(false),
    /** When the task's wait ended into Todo; kept through the claim until the run's first update, like `paused_at`. */
    wokenAt: timestamp('woken_at', { withTimezone: true }),
    /** Running only: when the user asked for the run to be interrupted; the worker clears it when it acts on it, and any move out of Running does. */
    stopRequestedAt: timestamp('stop_requested_at', { withTimezone: true }),
    /** Running only: this run's worker has read the run inbox, so it hands messages over; a CLI that never does leaves them to the resume. Cleared when the task leaves Running. */
    inboxRead: boolean('inbox_read').notNull().default(false),
    /** With a stop request: the pending note that goes with it (Stop & send); null for a plain stop. */
    stopMessageId: text('stop_message_id'),
    /** The blind index (abh1.…) of the PR head sha a review task was made for. */
    head: text('head'),
    /** The question note waiting for an answer, if any. */
    openQuestionNoteId: text('open_question_note_id'),
    /** The blind index (abh1.…) of the PR URL; unique per owner. */
    dedupeKey: text('dedupe_key'),
    parentId: text('parent_id'),
    createdBy: taskCreator('created_by').notNull().default('user'),
    /**
     * The schedule this task is an occurrence of. Not a foreign key: the task's sealed fields are bound to this id, so it
     * stays when the schedule is deleted.
     */
    scheduleId: text('schedule_id'),
    /** Proposed by an agent and not started by the user yet; starting it takes this off and makes `created_by` the user, with the prompt sealed again for that creator. */
    proposed: boolean('proposed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    check('task_title_sealed', isEnvelope(t.title)),
    check('task_input_sealed', isEnvelope(t.input)),
    check('task_workdir_sealed', isEnvelope(t.workdir)),
    check('task_home_workdir_sealed', isEnvelope(t.homeWorkdir)),
    check('task_agent_sealed', isEnvelope(t.agent)),
    check('task_pr_sealed', isEnvelope(t.pr)),
    check('task_dedupe_key_blind', isBlindIndex(t.dedupeKey)),
    check('task_head_blind', isBlindIndex(t.head)),
    unique('task_owner_dedupe_key_unique').on(t.owner, t.dedupeKey),
    index('task_status_priority_position_idx').on(t.owner, t.status, t.priority, t.position),
    unique('task_owner_id_unique').on(t.owner, t.id),
    ownerFk('task_parent_fk', [t.owner, t.parentId], [t.owner, t.id], 'set null'),
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
    /** The model of every occurrence; null is claude's default. */
    model: text('model'),
    machine: text('machine'),
    workdir: text('workdir'),
    /** The sealed name of the agent every occurrence runs as; null for none. */
    agent: text('agent'),
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
    check('schedule_title_sealed', isEnvelope(t.title)),
    check('schedule_input_sealed', isEnvelope(t.input)),
    check('schedule_workdir_sealed', isEnvelope(t.workdir)),
    check('schedule_agent_sealed', isEnvelope(t.agent)),
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
    /** Sealed, except on a note by author "server", whose body is plain text. */
    body: text('body').notNull(),
    /** A sealed start of the text, for the board cards; null for a note without text. */
    preview: text('preview'),
    /** A sealed reply the agent drafted for the user; only on a comment by the agent. */
    suggestion: text('suggestion'),
    /** Sealed JSON. */
    questions: text('questions'),
    answers: text('answers'),
    questionNoteId: text('question_note_id'),
    /** The signed-in user for author "user", the machine for agent and system notes. */
    by: text('by'),
    /** A message the user sent to a running agent that no worker has handed over yet; cleared when the worker acknowledges it or the run ends. */
    pending: boolean('pending').notNull().default(false),
    /** Written to a running agent (Send, Stop & send); never cleared, so a resume can find messages that were never handed over. */
    queued: boolean('queued').notNull().default(false),
    /** When a worker handed the message to the running agent. The resume prompt does not repeat it. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: writtenAt(),
  },
  (t) => [
    check('note_body_sealed', sql`(${t.author}::text = 'server' and ${t.kind} = 'event') or ${isEnvelope(t.body)}`),
    check('note_preview_sealed', isEnvelope(t.preview)),
    check('note_suggestion_sealed', isEnvelope(t.suggestion)),
    check(
      'note_suggestion_agent_comment',
      sql`${t.suggestion} is null or (${t.author}::text = 'agent' and ${t.kind} = 'comment')`,
    ),
    check('note_questions_sealed', isEnvelope(t.questions)),
    check('note_answers_sealed', isEnvelope(t.answers)),
    index('note_task_created_idx').on(t.taskId, t.createdAt),
    ownerFk('note_task_fk', [t.owner, t.taskId], [tasks.owner, tasks.id], 'cascade'),
    tenant(),
  ],
).enableRLS();

/** A pull request the task's agent reported with `board pr`; a task holds several. The state is GitHub's, as a worker's dispatcher last saw it. */
export const taskPrs = pgTable(
  'task_pr',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    taskId: text('task_id').notNull(),
    /** The sealed URL. */
    pr: text('pr').notNull(),
    state: prState('state'),
    createdAt: writtenAt(),
  },
  (t) => [
    check('task_pr_pr_sealed', isEnvelope(t.pr)),
    index('task_pr_task_created_idx').on(t.taskId, t.createdAt),
    ownerFk('task_pr_task_fk', [t.owner, t.taskId], [tasks.owner, tasks.id], 'cascade'),
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
    /** The CLI version and API level of the machine's last request, from its request headers; null before it sent them. */
    clientVersion: text('client_version'),
    clientApi: integer('client_api'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** The sealed directory list the machine's CLI sent (`machine.dirs`), advice for the New task form; null until it sends one. */
    dirs: text('dirs'),
    /** The blind index of that list, which the machine compares with its own to know whether to send again. */
    dirsIndex: text('dirs_index'),
    dirsUpdatedAt: timestamp('dirs_updated_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.name] }),
    check('machine_dirs_sealed', isEnvelope(t.dirs)),
    check('machine_dirs_index_blind', isBlindIndex(t.dirsIndex)),
    tenant(),
  ],
).enableRLS();

export type TaskRow = typeof tasks.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type TaskPrRow = typeof taskPrs.$inferSelect;
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
    /** Sealed JSON of the event without `output`. */
    data: text('data').notNull(),
    output: text('output'),
    outputSize: integer('output_size'),
  },
  (t) => [
    check('transcript_event_data_sealed', isEnvelope(t.data)),
    check('transcript_event_output_sealed', isEnvelope(t.output)),
    // With the owner, so a colliding (run, seq) of another user is not visible as a duplicate-key error.
    primaryKey({ columns: [t.owner, t.runId, t.seq] }),
    ownerFk('transcript_event_run_fk', [t.owner, t.runId], [transcriptRuns.owner, transcriptRuns.id], 'cascade'),
    tenant(),
  ],
).enableRLS();

/** The Slack user a board user speaks as; one each way. `/board link` and the link page create it. */
export const slackLinks = pgTable(
  'slack_link',
  {
    owner: owner().primaryKey(),
    teamId: text('team_id').notNull(),
    slackUserId: text('slack_user_id').notNull(),
    /** The Slack name at link time, for the settings page; null when Slack did not give one. */
    displayName: text('display_name'),
    createdAt: createdAt(),
  },
  (t) => [unique('slack_link_slack_user_unique').on(t.teamId, t.slackUserId), tenant()],
).enableRLS();

/**
 * A one-time code `/board link` hands out, before anyone knows whose board it is for, so it has no owner and no policy:
 * only the security definer functions of the slack migration read it.
 */
export const slackLinkCodes = pgTable('slack_link_code', {
  /** sha256 of the code, hex. */
  codeHash: text('code_hash').primaryKey(),
  teamId: text('team_id').notNull(),
  slackUserId: text('slack_user_id').notNull(),
  displayName: text('display_name'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}).enableRLS();

/**
 * A task a user proposed from Slack. The text is in clear: the server cannot seal it, and a task row accepts only sealed
 * text, so the browser turns an item into a task and deletes it. Workers never see this table.
 */
export const slackInbox = pgTable(
  'slack_inbox',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    text: text('text').notNull(),
    slackUserId: text('slack_user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('slack_inbox_text_length', sql`char_length(${t.text}) between 1 and ${sql.raw(String(INBOX_TEXT_MAX))}`),
    index('slack_inbox_owner_created_idx').on(t.owner, t.createdAt),
    tenant(),
  ],
).enableRLS();
