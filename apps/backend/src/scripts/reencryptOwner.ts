// The one-off re-encryption of an existing board: seals the legacy plain text of one user with that user's data key, under the
// bindings of `@agent-board/shared`. The caller connects as the admin role (which bypasses row-level security) and hands over
// the open client; everything below runs in one transaction that completes or changes nothing.
import {
  ContractError,
  dedupeKeyIndex,
  formatAnswers,
  headIndex,
  inputBinding,
  isBlindIndex,
  isEnvelope,
  isSafeLane,
  isSafeMachineName,
  isSafeNoteId,
  isSafeTaskId,
  isServerEventText,
  isSessionId,
  noteBinding,
  notePreview,
  open,
  parseAnswers,
  parseQuestions,
  QuestionError,
  seal,
  sealAnswers,
  SEALED_LIMITS,
  titleBinding,
  transcriptBinding,
  workdirBinding,
  workdirOpenBindings,
} from '@agent-board/shared';
import type {
  Answer,
  Binding,
  Keys,
  NoteKind,
  Question,
  RowRef,
  TaskCreator,
  WireNoteAuthor,
} from '@agent-board/shared';
import type pg from 'pg';
import { patternOf, PLAIN_NOTE_BODY, SEALED_COLUMNS } from '../db/sealedColumns';

/** The run cannot go on, or must not: nothing has been changed. */
export class ReencryptError extends Error {}

export interface ColumnCounts {
  /** Plain text that was sealed (or hashed) now. */
  converted: number;
  /** Values that were already sealed and open under their binding, left as they are. */
  alreadySealed: number;
  /** Left plain on purpose: the events the server writes itself. */
  leftPlain: number;
}

export interface ReencryptSummary {
  columns: Record<string, ColumnCounts>;
  /** Rows changed, per table, and the seconds spent on it. */
  tables: Record<string, { rows: number; changed: number; seconds: number }>;
  /** How many rows got special treatment, by what happened to them. */
  notices: Record<string, number>;
  /** Things the operator should read; none of them stopped the run. */
  warnings: string[];
  dryRun: boolean;
}

export interface ReencryptOptions {
  client: pg.Client;
  owner: string;
  keys: Keys;
  dryRun: boolean;
  log?: (line: string) => void;
  /** Rows per read and write. */
  batchSize?: number;
}

const DEFAULT_BATCH = 200;
// The tables whose writes a running backend would interleave with.
const LOCKED_TABLES = ['app_user', 'task', 'schedule', 'note', 'transcript_run', 'transcript_event'];
const MAX_PROBLEMS = 20;

interface Context {
  client: pg.Client;
  owner: string;
  keys: Keys;
  log: (line: string) => void;
  batchSize: number;
  columns: Map<string, ColumnCounts>;
  tables: ReencryptSummary['tables'];
  notices: Map<string, number>;
  warnings: string[];
  // Legacy values the wire parsers at HEAD refuse; any of them aborts the run, because one such row fails every listing.
  problems: string[];
  warnedOversize: Set<string>;
}

const counts = (ctx: Context, column: string): ColumnCounts => {
  let found = ctx.columns.get(column);
  if (found === undefined) {
    found = { converted: 0, alreadySealed: 0, leftPlain: 0 };
    ctx.columns.set(column, found);
  }
  return found;
};

const notice = (ctx: Context, what: string): void => {
  ctx.notices.set(what, (ctx.notices.get(what) ?? 0) + 1);
};

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

async function opens(keys: Keys, binding: Binding, value: string): Promise<string | undefined> {
  try {
    return await open(keys, binding.field, binding.context, value);
  } catch {
    return undefined;
  }
}

/**
 * The text of a stored value: itself when it is plain, what it opens to when it is an envelope under one of `bindings`. A value
 * that looks like an envelope and opens under none of them is an error, never plain text: sealing it again would hide the loss.
 */
async function openValue(
  keys: Keys,
  column: string,
  rowName: string,
  value: string,
  bindings: Binding[],
): Promise<{ plain: string; sealed: boolean }> {
  if (!isEnvelope(value)) return { plain: value, sealed: false };
  for (const binding of bindings) {
    const plain = await opens(keys, binding, value);
    if (plain !== undefined) return { plain, sealed: true };
  }
  throw new ReencryptError(
    `${column} of ${rowName} is an envelope that does not open with this key under its expected binding (another key, ` +
      'another row, or damage). Nothing was changed.',
  );
}

async function readValue(
  ctx: Context,
  column: string,
  rowName: string,
  value: string,
  bindings: Binding[],
): Promise<{ plain: string; sealed: boolean }> {
  const read = await openValue(ctx.keys, column, rowName, value, bindings);
  if (read.sealed) counts(ctx, column).alreadySealed += 1;
  return read;
}

/** Seals plain text under `binding` and checks that it opens to the same text. A value over the board's limit is still sealed, with a warning. */
async function sealValue(
  ctx: Context,
  column: string,
  rowName: string,
  binding: Binding,
  plain: string,
): Promise<string> {
  const sealed = await seal(ctx.keys, binding.field, binding.context, plain);
  if ((await opens(ctx.keys, binding, sealed)) !== plain)
    throw new ReencryptError(`${column} of ${rowName} does not open to what was sealed. Nothing was changed.`);
  const size = utf8Bytes(plain);
  const limit = SEALED_LIMITS[binding.field];
  if (size > limit && !ctx.warnedOversize.has(column)) {
    ctx.warnedOversize.add(column);
    ctx.warnings.push(
      `${column} of ${rowName} is ${size} bytes, over the ${limit} the board takes for ${binding.field}: sealed anyway, but the board will not accept it again as a write.`,
    );
  }
  counts(ctx, column).converted += 1;
  return sealed;
}

/** One sealed column of one row: what to store, whether it was sealed already. */
async function sealColumn(
  ctx: Context,
  column: string,
  rowName: string,
  value: string,
  binding: Binding,
  opensAs: Binding[] = [binding],
): Promise<string> {
  const read = await readValue(ctx, column, rowName, value, opensAs);
  return read.sealed ? value : sealValue(ctx, column, rowName, binding, read.plain);
}

/** A blind index of a plain value, or the value itself when it already is one (it cannot be checked without the plain text). */
async function indexColumn(
  ctx: Context,
  column: string,
  value: string,
  index: (plain: string) => Promise<string>,
): Promise<string> {
  if (isBlindIndex(value)) {
    counts(ctx, column).alreadySealed += 1;
    return value;
  }
  counts(ctx, column).converted += 1;
  return index(value);
}

const problem = (ctx: Context, message: string): void => {
  if (ctx.problems.length < MAX_PROBLEMS) ctx.problems.push(message);
};

type Value = string | null;
const same = (left: readonly Value[], right: readonly Value[]): boolean => left.every((value, i) => value === right[i]);

interface ChangedRow {
  key: readonly string[];
  values: Value[];
}

/** Reads rows in keyset pages (so memory stays at one page), converts them and writes the changed ones back. */
async function convertTable<Row>(
  ctx: Context,
  table: string,
  page: (after: Row | undefined) => Promise<Row[]>,
  convert: (row: Row) => Promise<ChangedRow | undefined>,
  write: (rows: ChangedRow[]) => Promise<Value[][]>,
): Promise<void> {
  const started = performance.now();
  let after: Row | undefined;
  let total = 0;
  let changed = 0;
  let pages = 0;
  for (;;) {
    const rows = await page(after);
    if (rows.length === 0) break;
    // The page's rows are independent, so their crypto runs side by side.
    const updates = (await Promise.all(rows.map(convert))).filter((update) => update !== undefined);
    if (updates.length > 0) {
      const stored = await write(updates);
      // What the database now holds must be exactly what was sealed.
      const byKey = new Map(stored.map((values) => [values.slice(0, updates[0]!.key.length).join('\0'), values]));
      for (const update of updates) {
        const found = byKey.get(update.key.join('\0'));
        if (found === undefined || !same(found.slice(update.key.length), update.values))
          throw new ReencryptError(`${table} ${update.key.join(' ')} reads back differently from what was written.`);
      }
    }
    total += rows.length;
    changed += updates.length;
    after = rows[rows.length - 1];
    pages += 1;
    if (pages % 100 === 0) ctx.log(`  ${table}: ${total} rows`);
  }
  ctx.tables[table] = { rows: total, changed, seconds: (performance.now() - started) / 1000 };
}

async function query<Row extends Record<string, unknown>>(
  ctx: Context,
  text: string,
  params: unknown[],
): Promise<Row[]> {
  return (await ctx.client.query<Row>(text, params)).rows;
}

// Tasks and schedules.

interface TaskRecord extends Record<string, unknown> {
  id: string;
  title: string;
  input: string;
  workdir: string | null;
  dedupe_key: string | null;
  head: string | null;
  created_by: TaskCreator;
  schedule_id: string | null;
  machine: string | null;
  lane: string | null;
  session_id: string | null;
}

async function convertTasks(ctx: Context, scheduleIds: Set<string>): Promise<void> {
  await convertTable<TaskRecord>(
    ctx,
    'task',
    (after) =>
      query(
        ctx,
        `select id, title, input, workdir, dedupe_key, head, created_by, schedule_id, machine, lane, session_id
         from task where owner = $1 and ($2::text is null or id > $2) order by id limit $3`,
        [ctx.owner, after?.id ?? null, ctx.batchSize],
      ),
    async (task) => {
      const name = `task ${task.id}`;
      if (!isSafeTaskId(task.id)) problem(ctx, `${name}: the id is not one a client accepts`);
      if (task.schedule_id !== null && !isSafeTaskId(task.schedule_id))
        problem(
          ctx,
          `${name}: the schedule id ${JSON.stringify(task.schedule_id.slice(0, 40))} is not one a client accepts`,
        );
      if (task.machine !== null && !isSafeMachineName(task.machine))
        problem(ctx, `${name}: the machine name is not safe`);
      if (task.lane !== null && !isSafeLane(task.lane)) problem(ctx, `${name}: the lane name is not safe`);
      if (task.session_id !== null && !isSessionId(task.session_id))
        problem(ctx, `${name}: the session id is not a UUID`);
      if (task.schedule_id !== null && !scheduleIds.has(task.schedule_id))
        notice(
          ctx,
          'tasks that are occurrences of a schedule that no longer exists (sealed for the schedule id they name)',
        );

      // An occurrence is bound to its schedule's id, whether or not that schedule still exists: the clients decide from the
      // row alone, and `schedule_id` is a plain reference that stays when the schedule goes.
      const row: RowRef = { kind: 'task', id: task.id, createdBy: task.created_by, scheduleId: task.schedule_id };
      const title = await sealColumn(ctx, 'task.title', name, task.title, titleBinding(row));
      const input = await sealColumn(ctx, 'task.input', name, task.input, inputBinding(row));
      const workdir =
        task.workdir === null
          ? null
          : await sealColumn(ctx, 'task.workdir', name, task.workdir, workdirBinding(row), workdirOpenBindings(row));
      const dedupeKey =
        task.dedupe_key === null
          ? null
          : await indexColumn(ctx, 'task.dedupe_key', task.dedupe_key, (plain) => dedupeKeyIndex(ctx.keys, plain));
      const head =
        task.head === null
          ? null
          : await indexColumn(ctx, 'task.head', task.head, (plain) => headIndex(ctx.keys, plain));
      const values = [title, input, workdir, dedupeKey, head];
      if (same(values, [task.title, task.input, task.workdir, task.dedupe_key, task.head])) return undefined;
      return { key: [task.id], values };
    },
    async (rows) => {
      const { rows: stored } = await ctx.client.query<{ id: string; v: Value[] }>(
        `update task t set title = v.title, input = v.input, workdir = v.workdir, dedupe_key = v.dedupe_key, head = v.head
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
           as v(id, title, input, workdir, dedupe_key, head)
         where t.owner = $1 and t.id = v.id
         returning t.id, array[t.title, t.input, t.workdir, t.dedupe_key, t.head] as v`,
        [ctx.owner, ...columnsOf(rows, 6)],
      );
      return stored.map(({ id, v }) => [id, ...v]);
    },
  );
}

interface ScheduleRecord extends Record<string, unknown> {
  id: string;
  title: string;
  input: string;
  workdir: string | null;
  machine: string | null;
  occurrence_task_id: string | null;
}

async function convertSchedules(ctx: Context): Promise<void> {
  await convertTable<ScheduleRecord>(
    ctx,
    'schedule',
    (after) =>
      query(
        ctx,
        `select id, title, input, workdir, machine, occurrence_task_id
         from schedule where owner = $1 and ($2::text is null or id > $2) order by id limit $3`,
        [ctx.owner, after?.id ?? null, ctx.batchSize],
      ),
    async (schedule) => {
      const name = `schedule ${schedule.id}`;
      if (!isSafeTaskId(schedule.id)) problem(ctx, `${name}: the id is not one a client accepts`);
      if (schedule.machine !== null && !isSafeMachineName(schedule.machine))
        problem(ctx, `${name}: the machine name is not safe`);
      if (schedule.occurrence_task_id !== null && !isSafeTaskId(schedule.occurrence_task_id))
        problem(ctx, `${name}: the occurrence task id is not one a client accepts`);
      const row: RowRef = { kind: 'schedule', id: schedule.id };
      const title = await sealColumn(ctx, 'schedule.title', name, schedule.title, titleBinding(row));
      const input = await sealColumn(ctx, 'schedule.input', name, schedule.input, inputBinding(row));
      const workdir =
        schedule.workdir === null
          ? null
          : await sealColumn(ctx, 'schedule.workdir', name, schedule.workdir, workdirBinding(row));
      const values = [title, input, workdir];
      if (same(values, [schedule.title, schedule.input, schedule.workdir])) return undefined;
      return { key: [schedule.id], values };
    },
    async (rows) => {
      const { rows: stored } = await ctx.client.query<{ id: string; v: Value[] }>(
        `update schedule s set title = v.title, input = v.input, workdir = v.workdir
         from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as v(id, title, input, workdir)
         where s.owner = $1 and s.id = v.id
         returning s.id, array[s.title, s.input, s.workdir] as v`,
        [ctx.owner, ...columnsOf(rows, 4)],
      );
      return stored.map(({ id, v }) => [id, ...v]);
    },
  );
}

/** The rows as parallel arrays, one per column (keys first), for `unnest`. */
function columnsOf(rows: ChangedRow[], width: number): Value[][] {
  return Array.from({ length: width }, (_, column) =>
    rows.map((row) =>
      column < row.key.length ? (row.key[column] ?? null) : (row.values[column - row.key.length] ?? null),
    ),
  );
}

// Notes.

interface NoteRecord extends Record<string, unknown> {
  id: string;
  task_id: string;
  author: WireNoteAuthor;
  kind: NoteKind;
  body: string;
  preview: string | null;
  questions: string | null;
  answers: string | null;
  question_note_id: string | null;
  created_at: Date;
}

/** The questions an answer note answered: from its `question_note_id`, which is trusted now, while the data is still legacy. */
async function questionsOfAnswer(ctx: Context, note: NoteRecord): Promise<Question[] | undefined> {
  if (note.question_note_id === null) return undefined;
  const [asked] = await query<{ questions: string | null; author: WireNoteAuthor; kind: NoteKind }>(
    ctx,
    'select questions, author, kind from note where owner = $1 and id = $2 and task_id = $3',
    [ctx.owner, note.question_note_id, note.task_id],
  );
  if (asked === undefined || asked.kind !== 'question' || asked.questions === null) return undefined;
  const name = `note ${note.question_note_id}`;
  const questionBinding = noteBinding('note.questions', note.task_id, asked.author, asked.kind);
  const { plain } = await openValue(ctx.keys, 'note.questions', name, asked.questions, [questionBinding]);
  try {
    return parseQuestions(JSON.parse(plain));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof QuestionError) return undefined;
    throw error;
  }
}

/** The answers of a legacy answer note, with the questions they answered; undefined when they do not fit each other. */
function legacyAnswers(questions: Question[], plain: string): Answer[] | undefined {
  try {
    return parseAnswers(questions, JSON.parse(plain));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof QuestionError) return undefined;
    throw error;
  }
}

function rawAnswerLines(plain: string): string {
  try {
    return formatAnswers(undefined, parseAnswers(undefined, JSON.parse(plain)));
  } catch {
    return plain;
  }
}

/** The envelope of an answer note, checked to open; undefined when it exceeds what the board takes. */
async function sealEnvelope(
  ctx: Context,
  rowName: string,
  taskId: string,
  questions: Question[],
  answers: Answer[],
): Promise<string | undefined> {
  const binding = noteBinding('note.answers', taskId, 'user', 'answer');
  try {
    const sealed = await sealAnswers(
      (b, plain) => seal(ctx.keys, b.field, b.context, plain),
      taskId,
      questions,
      answers,
    );
    await openValue(ctx.keys, 'note.answers', rowName, sealed, [binding]);
    return sealed;
  } catch (error) {
    if (error instanceof ContractError) return undefined;
    throw error;
  }
}

async function convertNote(ctx: Context, note: NoteRecord): Promise<ChangedRow | undefined> {
  const name = `note ${note.id}`;
  if (!isSafeNoteId(note.id)) problem(ctx, `${name}: the id is not one a client accepts`);
  if (note.question_note_id !== null && !isSafeNoteId(note.question_note_id))
    problem(ctx, `${name}: the question note id is not one a client accepts`);
  const unchanged = [note.author, note.kind, note.body, note.preview, note.questions, note.answers];

  if (note.author === 'server') {
    counts(ctx, 'note.body').leftPlain += 1;
    if (!isEnvelope(note.body) && !isServerEventText(note.body))
      ctx.warnings.push(
        `${name} is a server event whose text is none of the fixed ones: clients will show it as unreadable.`,
      );
    return undefined;
  }
  // The server wrote its events as plain "system" notes, so only the fixed texts become "server" notes. A client's own system
  // note that happens to read the same is harmless as one; any other text, a client's or an older wording of the server's, is sealed.
  if (note.author === 'system' && note.kind === 'event' && !isEnvelope(note.body) && isServerEventText(note.body)) {
    counts(ctx, 'note.body').leftPlain += 1;
    return { key: [note.id], values: ['server', note.kind, note.body, note.preview, note.questions, note.answers] };
  }

  let { kind } = note;
  const { author } = note;
  const bodyRead = await readValue(ctx, 'note.body', name, note.body, [
    noteBinding('note.body', note.task_id, author, kind),
  ]);
  let text = bodyRead.plain;
  let questions = note.questions;
  let answers = note.answers;

  if (answers !== null && !isEnvelope(answers) && kind === 'answer') {
    const asked = await questionsOfAnswer(ctx, note);
    const checked = asked === undefined ? undefined : legacyAnswers(asked, answers);
    const envelope =
      asked === undefined || checked === undefined
        ? undefined
        : await sealEnvelope(ctx, name, note.task_id, asked, checked);
    if (envelope !== undefined) {
      answers = envelope;
      counts(ctx, 'note.answers').converted += 1;
    } else {
      // Without its questions the answers cannot be sealed in the envelope the clients require, and such a note would read
      // as unreadable with the user's message lost. The user wrote it, so it becomes their comment, with the answers in words.
      kind = 'comment';
      text = [text, rawAnswerLines(answers)].filter((part) => part.trim() !== '').join('\n\n');
      answers = null;
      notice(ctx, 'answer notes without usable questions, made comments of the user');
      ctx.warnings.push(
        `${name} answered a question that is missing or does not fit: it is now a comment of the user's.`,
      );
    }
  } else if (answers !== null) {
    answers = await sealColumn(
      ctx,
      'note.answers',
      name,
      answers,
      noteBinding('note.answers', note.task_id, author, kind),
    );
  }

  if (questions !== null && !isEnvelope(questions)) {
    let json = questions;
    try {
      json = JSON.stringify(parseQuestions(JSON.parse(questions)));
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof QuestionError)) throw error;
      ctx.warnings.push(
        `${name} holds questions that do not parse: sealed as they are, clients will show the note as unreadable.`,
      );
    }
    questions = await sealValue(
      ctx,
      'note.questions',
      name,
      noteBinding('note.questions', note.task_id, author, kind),
      json,
    );
  } else if (questions !== null) {
    questions = await sealColumn(
      ctx,
      'note.questions',
      name,
      questions,
      noteBinding('note.questions', note.task_id, author, kind),
    );
  }

  const body =
    bodyRead.sealed && kind === note.kind
      ? note.body
      : await sealValue(ctx, 'note.body', name, noteBinding('note.body', note.task_id, author, kind), text);
  const previewBinding = noteBinding('note.preview', note.task_id, author, kind);
  const wanted = notePreview(text);
  let preview = note.preview;
  if (preview !== null && isEnvelope(preview) && kind === note.kind) {
    preview = await sealColumn(ctx, 'note.preview', name, preview, previewBinding);
  } else {
    preview = wanted === null ? null : await sealValue(ctx, 'note.preview', name, previewBinding, wanted);
  }

  const values = [author, kind, body, preview, questions, answers];
  return same(values, unchanged) ? undefined : { key: [note.id], values };
}

async function convertNotes(ctx: Context): Promise<void> {
  await convertTable<NoteRecord>(
    ctx,
    'note',
    (after) =>
      query(
        ctx,
        `select id, task_id, author::text as author, kind::text as kind, body, preview, questions, answers, question_note_id, created_at
         from note where owner = $1 and ($2::text is null or id > $2) order by id limit $3`,
        [ctx.owner, after?.id ?? null, ctx.batchSize],
      ),
    (note) => convertNote(ctx, note),
    async (rows) => {
      const { rows: stored } = await ctx.client.query<{ id: string; v: Value[] }>(
        `update note n set author = v.author::note_author, kind = v.kind::note_kind, body = v.body, preview = v.preview,
           questions = v.questions, answers = v.answers
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
           as v(id, author, kind, body, preview, questions, answers)
         where n.owner = $1 and n.id = v.id
         returning n.id, array[n.author::text, n.kind::text, n.body, n.preview, n.questions, n.answers] as v`,
        [ctx.owner, ...columnsOf(rows, 7)],
      );
      return stored.map(({ id, v }) => [id, ...v]);
    },
  );
}

// Transcript events.

interface EventRecord extends Record<string, unknown> {
  task_id: string;
  run_id: string;
  seq: number;
  data: string;
  output: string | null;
  output_size: number | null;
}

async function convertEvents(ctx: Context): Promise<void> {
  await convertTable<EventRecord>(
    ctx,
    'transcript_event',
    (after) =>
      query(
        ctx,
        `select r.task_id, e.run_id, e.seq, e.data, e.output, e.output_size
         from transcript_event e join transcript_run r on r.owner = e.owner and r.id = e.run_id
         where e.owner = $1 and ($2::text is null or (e.run_id, e.seq) > ($2, $3::int)) order by e.run_id, e.seq limit $4`,
        [ctx.owner, after?.run_id ?? null, after?.seq ?? null, ctx.batchSize],
      ),
    async (event) => {
      const name = `transcript event ${event.run_id}:${event.seq}`;
      const data = await sealColumn(
        ctx,
        'transcript_event.data',
        name,
        event.data,
        transcriptBinding('tr.data', event.task_id, event.run_id, event.seq),
      );
      let output = event.output;
      let outputSize = event.output_size;
      if (output !== null) {
        const read = await readValue(ctx, 'transcript_event.output', name, output, [
          transcriptBinding('tr.output', event.task_id, event.run_id, event.seq),
        ]);
        if (!read.sealed) {
          output = await sealValue(
            ctx,
            'transcript_event.output',
            name,
            transcriptBinding('tr.output', event.task_id, event.run_id, event.seq),
            read.plain,
          );
          // The length in UTF-16 units, as the CLI reports it.
          outputSize = read.plain.length;
        }
      }
      const values = [data, output, outputSize === null ? null : String(outputSize)];
      if (same(values, [event.data, event.output, event.output_size === null ? null : String(event.output_size)]))
        return undefined;
      return { key: [event.run_id, String(event.seq)], values };
    },
    async (rows) => {
      const { rows: stored } = await ctx.client.query<{ run_id: string; seq: number; v: Value[] }>(
        `update transcript_event t set data = v.data, output = v.output, output_size = v.output_size::int
         from unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[]) as v(run_id, seq, data, output, output_size)
         where t.owner = $1 and t.run_id = v.run_id and t.seq = v.seq
         returning t.run_id, t.seq, array[t.data, t.output, t.output_size::text] as v`,
        [ctx.owner, ...columnsOf(rows, 5)],
      );
      return stored.map(({ run_id, seq, v }) => [run_id, String(seq), ...v]);
    },
  );
}

// The checks around the conversion.

/** How many values of each sealed column are not of the shape the constraints of migration 0014 require. */
export async function plaintextCounts(
  client: pg.Client,
  scope: { exceptOwner: string } | 'all',
): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const sealed of SEALED_COLUMNS) {
    const column = `"${sealed.column}"`;
    const shape = `${column} ~ $1`;
    const bad =
      sealed.table === 'note' && sealed.column === 'body' ? `not (${PLAIN_NOTE_BODY} or ${shape})` : `${column} !~ $1`;
    const owner = scope === 'all' ? '' : ' and owner <> $2';
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from "${sealed.table}" where ${bad}${owner}`,
      scope === 'all' ? [patternOf(sealed)] : [patternOf(sealed), scope.exceptOwner],
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0) found[`${sealed.table}.${sealed.column}`] = n;
  }
  return found;
}

const describeCounts = (found: Record<string, number>): string =>
  Object.entries(found)
    .map(([column, n]) => `${column} (${n})`)
    .join(', ');

async function checkOwner(ctx: Context): Promise<void> {
  const [user] = await query<{ key_id: string | null }>(ctx, 'select key_id from app_user where username = $1', [
    ctx.owner,
  ]);
  if (user === undefined) throw new ReencryptError(`There is no user "${ctx.owner}" on this board.`);
  if (user.key_id === null)
    throw new ReencryptError(`"${ctx.owner}" has not set up encryption yet: do that in the browser first.`);
  if (user.key_id !== ctx.keys.keyId)
    throw new ReencryptError(
      `The data key has id ${ctx.keys.keyId}, but the board expects id ${user.key_id} for "${ctx.owner}": this is another key, or another user's.`,
    );
  const [role] = await query<{ name: string; bypass: boolean }>(
    ctx,
    `select r.rolname as name,
       r.rolsuper or r.rolbypassrls or pg_has_role(r.oid, (select relowner from pg_class where oid = 'public.task'::regclass), 'MEMBER') as bypass
     from pg_roles r where r.rolname = current_user`,
    [],
  );
  if (role === undefined || !role.bypass)
    throw new ReencryptError(
      `The database role "${role?.name ?? '?'}" does not bypass row-level security: connect as the admin role (DATABASE_URL), not as board_app.`,
    );
}

async function lockBoard(ctx: Context): Promise<void> {
  try {
    await ctx.client.query(`lock table ${LOCKED_TABLES.join(', ')} in share row exclusive mode nowait`);
  } catch (error) {
    if ((error as { code?: string }).code === '55P03')
      throw new ReencryptError(
        'The board is being written to right now (a backend, a worker or a timer holds a write on it). Scale the backend to zero, stop the timers on every machine, and run again. Nothing was changed.',
      );
    throw error;
  }
}

async function checkForeignOwners(ctx: Context): Promise<void> {
  const foreign = await plaintextCounts(ctx.client, { exceptOwner: ctx.owner });
  if (Object.keys(foreign).length > 0)
    throw new ReencryptError(
      `Rows of another user still hold plain text (${describeCounts(foreign)}). This script is only valid while all legacy rows belong to "${ctx.owner}". Nothing was changed.`,
    );
}

async function verifyNothingPlain(ctx: Context): Promise<void> {
  const left = await plaintextCounts(ctx.client, 'all');
  if (Object.keys(left).length > 0)
    throw new ReencryptError(
      `Plain text is left in sealed columns after the conversion (${describeCounts(left)}). Nothing was changed.`,
    );
  const [server] = await query<{ n: number }>(
    ctx,
    `select count(*)::int as n from note where owner = $1 and author = 'server' and kind <> 'event'`,
    [ctx.owner],
  );
  if ((server?.n ?? 0) > 0) throw new ReencryptError('A server note is not an event. Nothing was changed.');
}

export async function reencryptOwner(options: ReencryptOptions): Promise<ReencryptSummary> {
  const { client, owner, keys, dryRun } = options;
  const ctx: Context = {
    client,
    owner,
    keys,
    log: options.log ?? (() => undefined),
    batchSize: options.batchSize ?? DEFAULT_BATCH,
    columns: new Map(),
    tables: {},
    notices: new Map(),
    warnings: [],
    problems: [],
    warnedOversize: new Set(),
  };
  if (!keys.index) throw new ReencryptError('The keys need the blind-index key: derive them with { index: true }.');
  await client.query('begin');
  try {
    await client.query('set local statement_timeout = 0');
    await client.query('set local idle_in_transaction_session_timeout = 0');
    await checkOwner(ctx);
    await lockBoard(ctx);
    await checkForeignOwners(ctx);
    const scheduleIds = new Set(
      (await query<{ id: string }>(ctx, 'select id from schedule where owner = $1', [owner])).map(({ id }) => id),
    );
    ctx.log('tasks');
    await convertTasks(ctx, scheduleIds);
    ctx.log('schedules');
    await convertSchedules(ctx);
    ctx.log('notes');
    await convertNotes(ctx);
    ctx.log('transcript events');
    await convertEvents(ctx);
    if (ctx.problems.length > 0)
      throw new ReencryptError(
        `Some rows hold values that the clients at this version refuse, which would make every listing fail:\n  ${ctx.problems.join('\n  ')}\nNothing was changed.`,
      );
    await verifyNothingPlain(ctx);
    await client.query(dryRun ? 'rollback' : 'commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
  return {
    columns: Object.fromEntries(ctx.columns),
    tables: ctx.tables,
    notices: Object.fromEntries(ctx.notices),
    warnings: ctx.warnings,
    dryRun,
  };
}
