import {
  dedupeKeyIndex,
  deriveKeys,
  generateDataKey,
  sealInput,
  sealNote,
  sealTitle,
  seal,
  type Keys,
} from '@agent-board/shared';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSealedBackend } from '../../../cli/src/sealing.mts';
import { planIntake, runIntake } from '../../../cli/src/intake.mts';
import { CONFIG } from '../../../cli/test/helpers.mts';
import { createDb, migrationsFolder, type Db } from '../db/client';
import { buildServer } from '../server';
import { caller, testConfig } from '../test/helpers';
import { plainUi } from '../test/client';
import { keysFor, sealerFor, useDataKey } from '../test/sealed';
import { migrationsBefore, removeFolder, scratchDatabase } from '../test/scratch';
import { plaintextCounts, reencryptOwner, ReencryptError, type ReencryptSummary } from './reencryptOwner';

const scratch = scratchDatabase('reencrypt');
const OWNER = 'alice';
const PR = 'https://github.com/cosuno/cosuno/pull/17';
const SHA = 'abcdef1234';
// About 720 kB of UTF-8, close to what the board takes for a prompt.
const LONG = 'lorem ipsum ünï '.repeat(40_000);
const BIG_OUTPUT = 'o'.repeat(300_000);
const QUESTIONS = [
  {
    header: 'Scope',
    question: 'Review the migration too?',
    multiSelect: false,
    options: [
      { label: 'Yes', description: 'Include it', recommended: true },
      { label: 'No', description: '' },
    ],
  },
];

let beforeFolder: string;
let admin: ReturnType<typeof createDb>;
let app: ReturnType<typeof createDb>;
let keys: Keys;
const dataKey = generateDataKey();
let client: pg.Client;

const run = (overrides: { keys?: Keys; owner?: string; dryRun?: boolean; batchSize?: number } = {}) =>
  reencryptOwner({ client, owner: OWNER, keys, dryRun: false, batchSize: 3, ...overrides });

/** Every row of every table with its transaction id, so that a row that was rewritten (even to the same values) shows. */
async function snapshot(db: Db = admin.db): Promise<string> {
  const tables = ['app_user', 'task', 'schedule', 'note', 'transcript_run', 'transcript_event'];
  const parts: unknown[] = [];
  for (const table of tables) {
    const { rows } = await db.execute(sql.raw(`select xmin::text as xmin, * from ${table} order by 2, 3, 4`));
    parts.push(rows);
  }
  return JSON.stringify(parts);
}

async function legacySeed(db: Db): Promise<void> {
  const exec = (query: ReturnType<typeof sql>) => db.execute(query);
  await exec(sql`insert into app_user (username, key_id, key_slots) values (${OWNER}, ${keys.keyId}, '[]'::jsonb)`);
  await exec(sql`
    insert into schedule (id, owner, title, input, workdir, machine, every_ms, anchor_at)
    values ('s1sched1', ${OWNER}, 'Nightly sweep', '/sweep', '/w/sched', 'laptop', 3600000, now())`);

  const mixedRow = { kind: 'task', id: 't7mixed', createdBy: 'user', scheduleId: null } as const;
  const sealer = sealerFor(OWNER).seal;
  const halfSealedTitle = await sealTitle(sealer, mixedRow, 'Half sealed');
  const task = (t: {
    id: string;
    title: string;
    input: string;
    workdir?: string | null;
    createdBy?: string;
    scheduleId?: string | null;
    dedupeKey?: string | null;
    head?: string | null;
    status?: string;
    parentId?: string | null;
    proposed?: boolean;
    sessionId?: string | null;
  }) =>
    exec(sql`
    insert into task (id, owner, title, input, workdir, created_by, schedule_id, dedupe_key, head, status, parent_id, proposed, session_id, position)
    values (${t.id}, ${OWNER}, ${t.title}, ${t.input}, ${t.workdir ?? null}, ${t.createdBy ?? 'user'}::task_creator, ${t.scheduleId ?? null},
      ${t.dedupeKey ?? null}, ${t.head ?? null}, ${t.status ?? 'todo'}::task_status, ${t.parentId ?? null}, ${t.proposed ?? false}, ${t.sessionId ?? null}, 0)`);
  await task({ id: 't1plain1', title: 'Fix ünïcode ✓ 修正', input: LONG, workdir: '/home/a/work' });
  await task({
    id: 't2intake',
    title: '#17 Add thing (dev)',
    input: `/review-pr ${PR} --auto`,
    createdBy: 'intake',
    dedupeKey: PR,
    head: SHA,
    status: 'needs-me',
  });
  await task({
    id: 't3occur1',
    title: 'Sweep (edited)',
    input: '/sweep --other',
    workdir: '/w/occ',
    scheduleId: 's1sched1',
  });
  await task({ id: 't4orphan', title: 'Sweep of a deleted schedule', input: '/sweep', scheduleId: 'gone0001' });
  await task({ id: 't5empty', title: '', input: '' });
  await task({
    id: 't6agent',
    title: 'Proposed',
    input: 'do it',
    createdBy: 'agent',
    status: 'needs-me',
    parentId: 't1plain1',
    proposed: true,
  });
  // Proposals whose `proposed` was cleared before this change: by a start (its creator stayed "agent", and the task went to
  // Todo, or ran, or was answered), or by reopening a discarded one, which cleared it too without anyone starting anything.
  const legacyProposal = { createdBy: 'agent', proposed: false } as const;
  await task({ id: 't8start1', title: 'Started proposal', input: 'do it now', ...legacyProposal });
  await task({
    id: 't9reopen',
    title: 'Discarded then reopened',
    input: 'never started',
    status: 'needs-me',
    ...legacyProposal,
  });
  await task({
    id: 't10sess',
    title: 'Has a session',
    input: 'ran',
    status: 'needs-me',
    sessionId: '33333333-3333-4333-8333-333333333333',
    ...legacyProposal,
  });
  await task({ id: 't11run1', title: 'Has a run', input: 'ran too', status: 'done', ...legacyProposal });
  await task({ id: 't12move', title: 'Was dragged', input: 'dragged', status: 'backlog', ...legacyProposal });
  await task({
    id: 't13done1',
    title: 'Marked done',
    input: 'never started either',
    status: 'done',
    ...legacyProposal,
  });
  await task({ id: 't7mixed', title: halfSealedTitle, input: 'The prompt is still plain' });

  const note = (n: {
    id: string;
    author: string;
    kind: string;
    body: string;
    questions?: string | null;
    answers?: string | null;
    questionNoteId?: string | null;
    taskId?: string;
  }) =>
    exec(sql`
    insert into note (id, owner, task_id, author, kind, body, questions, answers, question_note_id)
    values (${n.id}, ${OWNER}, ${n.taskId ?? 't1plain1'}, ${n.author}::note_author, ${n.kind}::note_kind, ${n.body},
      ${n.questions ?? null}, ${n.answers ?? null}, ${n.questionNoteId ?? null})`);
  const notes: Parameters<typeof note>[0][] = [
    { id: 'n01', author: 'agent', kind: 'comment', body: 'Looked at ünï ✓ 🙂' },
    { id: 'n02', author: 'user', kind: 'comment', body: 'thanks' },
    {
      id: 'n03',
      author: 'system',
      kind: 'event',
      body: 'agent-board: started 2026-11-13T11:19:25.256Z (selftest, laptop)',
    },
    { id: 'n04', author: 'system', kind: 'event', body: 'Marked done.' },
    { id: 'n05', author: 'system', kind: 'event', body: 'Moved from todo to running.' },
    { id: 'n06', author: 'system', kind: 'event', body: 'Taken back from laptop: no sign of life for 20 minutes.' },
    { id: 'n07', author: 'system', kind: 'event', body: 'Taken back from my laptop: no sign of life for 20 minutes.' },
    { id: 'n08', author: 'system', kind: 'event', body: 'Closed after 14 days in Done.' },
    { id: 'n09', author: 'agent', kind: 'question', body: '', questions: JSON.stringify(QUESTIONS, null, 1) },
    {
      id: 'n10',
      author: 'user',
      kind: 'answer',
      body: 'go ahead',
      answers: '[{"selected": ["Yes"], "other": "é"}]',
      questionNoteId: 'n09',
    },
    { id: 'n11', author: 'user', kind: 'answer', body: 'no question', answers: '[{"selected": ["A"]}]' },
    {
      id: 'n12',
      author: 'user',
      kind: 'answer',
      body: '',
      answers: '[{"selected": ["A"]}]',
      questionNoteId: 'nosuchnote',
    },
    {
      id: 'n13',
      author: 'user',
      kind: 'answer',
      body: 'odd',
      answers: '[{"selected": ["Maybe"]}]',
      questionNoteId: 'n09',
    },
    { id: 'n14', author: 'agent', kind: 'comment', body: '' },
    { id: 'n15', author: 'agent', kind: 'comment', body: 'long note ünï '.repeat(7_000) },
    { id: 'n16', author: 'system', kind: 'event', body: 'Priority normal → high.' },
    { id: 'n17', author: 'system', kind: 'event', body: 'Start time set to 2026-01-01T00:00:00.000Z.' },
    { id: 'n18', author: 'system', kind: 'event', body: 'Reopened.' },
    { id: 'n19', author: 'system', kind: 'event', body: 'Possibly a duplicate of EqYgVKEt ("/x"): Open it.' },
    { id: 'n20', author: 'server', kind: 'event', body: 'Closed.' },
    { id: 'n21', author: 'user', kind: 'comment', body: 'on the intake task', taskId: 't2intake' },
    { id: 'n22', author: 'system', kind: 'event', body: 'Moved from needs-me to todo.', taskId: 't12move' },
    { id: 'n23', author: 'system', kind: 'event', body: 'Reopened.', taskId: 't9reopen' },
    { id: 'n24', author: 'system', kind: 'event', body: 'Moved from needs-me to done.', taskId: 't13done1' },
  ];
  for (const n of notes) await note(n);

  const runId = '11111111-aaaa-4aaa-8aaa-111111111111';
  await exec(sql`
    insert into transcript_run (id, owner, task_id, machine, session_id, started_at, last_event_at, event_count)
    values (${runId}, ${OWNER}, 't1plain1', 'laptop', '11111111-1111-4111-8111-111111111111', now(), now(), 25),
           ('22222222-aaaa-4aaa-8aaa-222222222222', ${OWNER}, 't2intake', 'laptop', null, now(), now(), 0),
           ('44444444-aaaa-4aaa-8aaa-444444444444', ${OWNER}, 't11run1', 'laptop', null, now(), now(), 0)`);
  for (let seq = 0; seq < 25; seq += 1) {
    const toolResult = seq % 5 === 2;
    const output = !toolResult
      ? null
      : seq === 2
        ? ''
        : seq === 7
          ? BIG_OUTPUT
          : seq === 12
            ? null
            : `output of ${seq}: ünï ✓ 🙂`;
    const event = toolResult
      ? {
          at: '2026-11-13T22:25:00.000Z',
          seq,
          kind: 'tool_result',
          parent: null,
          isError: false,
          toolUseId: `toolu_${seq}`,
        }
      : { at: '2026-11-13T22:25:00.000Z', seq, kind: 'note', text: `note ${seq} ünï ✓` };
    // jsonb's text form, with its spaces, as the legacy migration left it.
    const data = JSON.stringify(event).replaceAll('":', '": ').replaceAll(',"', ', "');
    await exec(sql`
      insert into transcript_event (run_id, owner, seq, at, kind, data, output, output_size)
      values (${runId}, ${OWNER}, ${seq}, now(), ${event.kind}, ${data}, ${output}, ${seq === 17 ? null : (output?.length ?? null)})`);
  }
}

const rows = async <T extends Record<string, unknown>>(text: string): Promise<T[]> =>
  (await admin.db.execute(sql.raw(text))).rows as T[];

beforeAll(async () => {
  await scratch.recreate();
  beforeFolder = migrationsBefore('_sealed_content_constraints');
  admin = createDb(scratch.adminUrl);
  app = createDb(scratch.appUrl);
  await migrate(admin.db, { migrationsFolder: beforeFolder });
  useDataKey(OWNER, dataKey);
  keys = await keysFor(OWNER);
  await legacySeed(admin.db);
  client = new pg.Client({ connectionString: scratch.adminUrl });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await app?.pool.end();
  await admin?.pool.end();
  await scratch.drop();
  removeFolder(beforeFolder);
});

const refuses = async (attempt: () => Promise<unknown>, message: RegExp): Promise<void> => {
  const before = await snapshot();
  await expect(attempt()).rejects.toThrow(message);
  expect(await snapshot()).toBe(before);
};

describe('the cutover re-encryption, in the order of the runbook', () => {
  it('refuses another key, a missing owner, a missing key and changes nothing', async () => {
    const other = await deriveKeys(generateDataKey(), OWNER, { index: true });
    await refuses(() => run({ keys: other }), /another key/);
    await refuses(
      async () => run({ owner: 'nobody', keys: await deriveKeys(dataKey, 'nobody', { index: true }) }),
      /no user "nobody"/,
    );
    await admin.db.execute(sql`insert into app_user (username) values ('carol')`);
    await refuses(
      async () => run({ owner: 'carol', keys: await deriveKeys(dataKey, 'carol', { index: true }) }),
      /not set up encryption/,
    );
    await admin.db.execute(sql`delete from app_user where username = 'carol'`);
    const withoutIndex = await deriveKeys(dataKey, OWNER);
    await expect(run({ keys: withoutIndex })).rejects.toThrow(ReencryptError);
  });

  it('refuses while another user still holds plain text, and accepts one whose rows are sealed', async () => {
    await admin.db.execute(sql`insert into app_user (username) values ('bob')`);
    await admin.db.execute(
      sql`insert into task (id, owner, title, input, position) values ('b1plain1', 'bob', 'plain', 'plain', 0)`,
    );
    await refuses(() => run(), /another user still hold plain text \(task\.title \(1\), task\.input \(1\)\)/);
    await admin.db.execute(sql`delete from task where owner = 'bob'`);
    const bob = sealerFor('bob').seal;
    const row = { kind: 'task', id: 'b2sealed', createdBy: 'user', scheduleId: null } as const;
    await admin.db.execute(sql`
      insert into task (id, owner, title, input, position)
      values ('b2sealed', 'bob', ${await sealTitle(bob, row, 'sealed')}, ${await sealInput(bob, row, 'sealed')}, 0)`);
  });

  it('refuses a value that looks sealed but does not open, and a row a client would refuse', async () => {
    const stranger = await deriveKeys(generateDataKey(), OWNER, { index: true });
    const forged = await sealNote(
      (binding, text) => seal(stranger, binding.field, binding.context, text),
      { taskId: 't1plain1', author: 'user', kind: 'comment' },
      'thanks',
    );
    await admin.db.execute(sql`update note set body = ${forged.body} where id = 'n02'`);
    await refuses(() => run(), /note\.body of note n02 is an envelope that does not open/);
    await admin.db.execute(sql`update note set body = 'thanks' where id = 'n02'`);

    await admin.db.execute(
      sql`insert into task (id, owner, title, input, position) values ('dispatch', ${OWNER}, 'x', 'y', 0)`,
    );
    await refuses(() => run(), /task dispatch: the id is not one a client accepts/);
    await admin.db.execute(sql`delete from task where id = 'dispatch'`);
  });

  it('stops, naming both tasks, when intake made a second task for a pull request that a legacy task holds', async () => {
    const index = await dedupeKeyIndex(keys, PR);
    await admin.db.execute(sql`
      insert into task (id, owner, title, input, created_by, dedupe_key, position)
      values ('t0newint', ${OWNER}, 'sealed later', 'sealed later', 'intake', ${index}, 0)`);
    try {
      const before = await snapshot();
      const attempt = run({ dryRun: true });
      await expect(attempt).rejects.toThrow(ReencryptError);
      await expect(attempt).rejects.toThrow(
        /task t2intake \(legacy, created .*\) and task t0newint \(created by intake .*\)/,
      );
      await expect(attempt).rejects.toThrow(/delete it .*dedupe_key = null.*Nothing was changed/s);
      expect(await snapshot()).toBe(before);
    } finally {
      await admin.db.execute(sql`delete from task where id = 't0newint'`);
    }
  });

  it('refuses, naming the cause, while another session is writing', async () => {
    const writer = new pg.Client({ connectionString: scratch.adminUrl });
    await writer.connect();
    try {
      await writer.query(`begin`);
      await writer.query(`update task set position = 1 where id = 't1plain1'`);
      await refuses(() => run(), /being written to right now/);
    } finally {
      await writer.query('rollback');
      await writer.end();
    }
    await admin.db.execute(sql`update task set position = 0 where id = 't1plain1'`);
  });

  let summary: ReencryptSummary;

  it('a dry run does everything, prints the same summary as the real run and changes nothing', async () => {
    const before = await snapshot();
    summary = await run({ dryRun: true });
    expect(await snapshot()).toBe(before);
    expect(summary.dryRun).toBe(true);
    expect(summary.columns['task.title']).toEqual({ converted: 12, alreadySealed: 1, leftPlain: 0 });
    // Every task and a count per table, for the operator to compare with the dump from before the cutover.
    expect(summary.inventory.counts).toEqual({
      task: 13,
      schedule: 1,
      note: 24,
      transcript_run: 3,
      transcript_event: 25,
    });
    expect(summary.inventory.tasks).toHaveLength(13);
    expect(summary.inventory.tasks.map(({ id }) => id).sort()).toEqual(
      [
        't10sess',
        't11run1',
        't12move',
        't13done1',
        't1plain1',
        't2intake',
        't3occur1',
        't4orphan',
        't5empty',
        't6agent',
        't7mixed',
        't8start1',
        't9reopen',
      ].sort(),
    );
    expect(summary.inventory.tasks[0]).toMatchObject({ createdBy: expect.any(String), status: expect.any(String) });
    expect(summary.inventory.tasks[0]?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(summary.columns['transcript_event.output']?.converted).toBe(4);
  });

  it('decides each legacy proposal with proposed = false by evidence of a start, and says so for both outcomes', () => {
    const byId = Object.fromEntries(summary.proposals.map((proposal) => [proposal.id, proposal]));
    expect(Object.keys(byId).sort()).toEqual(['t10sess', 't11run1', 't12move', 't13done1', 't8start1', 't9reopen']);
    expect(byId['t8start1']).toMatchObject({ outcome: 'started', createdBy: 'agent', status: 'todo' });
    expect(byId['t8start1']?.evidence).toEqual(['status todo']);
    expect(byId['t10sess']).toMatchObject({ outcome: 'started', status: 'needs-me', evidence: ['a session id'] });
    expect(byId['t11run1']).toMatchObject({ outcome: 'started', status: 'done', evidence: ['a transcript run'] });
    expect(byId['t12move']).toMatchObject({
      outcome: 'started',
      status: 'backlog',
      evidence: ['an answer of the user or the move into Todo'],
    });
    // Reopened after a discard, or marked done: nobody started them, whatever `proposed` says.
    expect(byId['t9reopen']).toMatchObject({ outcome: 'kept', createdBy: 'agent', status: 'needs-me', evidence: [] });
    expect(byId['t13done1']).toMatchObject({ outcome: 'kept', createdBy: 'agent', status: 'done', evidence: [] });
    expect(byId['t9reopen']?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // A proposal that is still waiting (proposed = true) is not decided.
    expect(byId['t6agent']).toBeUndefined();
  });

  it('seals every legacy value and reports what it did', async () => {
    const real = await run();
    expect(real.columns).toEqual(summary.columns);
    expect(real.columns).toMatchObject({
      'task.title': { converted: 12, alreadySealed: 1 },
      'task.input': { converted: 13, alreadySealed: 0 },
      'task.workdir': { converted: 2 },
      'task.dedupe_key': { converted: 1 },
      'task.head': { converted: 1 },
      'schedule.title': { converted: 1 },
      'schedule.workdir': { converted: 1 },
      'note.questions': { converted: 1 },
      'note.answers': { converted: 1 },
      'transcript_event.data': { converted: 25 },
    });
    // Server events by the allow-list: Marked done, Moved, Taken back from laptop, Closed after, Priority, Start time, Reopened.
    expect(real.columns['note.body']?.leftPlain).toBe(11);
    expect(real.notices).toMatchObject({
      'tasks that are occurrences of a schedule that no longer exists (sealed for the schedule id they name)': 1,
      'answer notes without usable questions, made comments of the user': 3,
      'proposals the user had started (now created by the user, as a started proposal is)': 4,
      'proposals with no sign of a start (kept as the agent’s, waiting for you to start them)': 2,
    });
    expect(real.proposals).toEqual(summary.proposals);
    const stored = await rows<{ id: string; created_by: string; proposed: boolean }>(
      `select id, created_by::text, proposed from task where created_by = 'agent' or id in ('t8start1', 't10sess') order by id`,
    );
    expect(stored).toEqual([
      { id: 't10sess', created_by: 'user', proposed: false },
      { id: 't13done1', created_by: 'agent', proposed: true },
      { id: 't6agent', created_by: 'agent', proposed: true },
      { id: 't8start1', created_by: 'user', proposed: false },
      { id: 't9reopen', created_by: 'agent', proposed: true },
    ]);
    expect(await plaintextCounts(client, 'all')).toEqual({});
    expect(real.tables['transcript_event']?.rows).toBe(25);
  });

  it('left the old wordings and foreign wording sealed as system events, and the server events plain', async () => {
    const authors = await rows<{ id: string; author: string; body: string }>(
      'select id, author::text, body from note order by id',
    );
    const byId = Object.fromEntries(authors.map((note) => [note.id, note]));
    for (const id of ['n04', 'n05', 'n06', 'n08', 'n16', 'n17', 'n18', 'n20'])
      expect(byId[id], id).toMatchObject({ author: 'server' });
    for (const id of ['n03', 'n07', 'n19']) {
      expect(byId[id]?.author, id).toBe('system');
      expect(byId[id]?.body, id).toMatch(/^abe1\./);
    }
    expect(byId['n04']?.body).toBe('Marked done.');
  });

  it('keeps output_size correct, and gave the missing one its length', async () => {
    const sizes = await rows<{ seq: number; output: string | null; output_size: number | null }>(
      `select seq, output, output_size from transcript_event where kind = 'tool_result' order by seq`,
    );
    expect(sizes.map((row) => [row.seq, row.output_size])).toEqual([
      [2, 0],
      [7, 300_000],
      [12, null],
      [17, 'output of 17: ünï ✓ 🙂'.length],
      [22, 'output of 22: ünï ✓ 🙂'.length],
    ]);
  });

  it('lets the later migrations pass afterwards, and the constraints are validated (the clients read the board at its latest schema)', async () => {
    await migrate(admin.db, { migrationsFolder: migrationsFolder() });
    const constraints = await rows<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated from pg_constraint where conname like '%\\_sealed' or conname like '%\\_blind'`,
    );
    expect(constraints).toHaveLength(15);
    expect(constraints.every((constraint) => constraint.convalidated)).toBe(true);
  });

  it('is read by the CLI sealed backend: every task, note and schedule, nothing unreadable', async () => {
    const server = await buildServer({ ...testConfig, appDatabaseUrl: scratch.appUrl }, app.db);
    const { token } = await caller(app.db, OWNER).machines.issue({ name: 'laptop' });
    const backend = createSealedBackend({
      loadConfig: () => ({ url: 'http://board.test', token, dataKey }),
      fetch: async (url, init) => {
        const answer = await server.inject({
          method: 'POST',
          url: new URL(url).pathname,
          headers: init.headers as Record<string, string>,
          payload: init.body as string,
        });
        return new Response(answer.body, { status: answer.statusCode });
      },
    });
    const tasks = await backend.listTasks({ all: true });
    expect(tasks.map((task) => task.id).sort()).toEqual(
      [
        't10sess',
        't11run1',
        't12move',
        't13done1',
        't1plain1',
        't2intake',
        't3occur1',
        't4orphan',
        't5empty',
        't6agent',
        't7mixed',
        't8start1',
        't9reopen',
      ].sort(),
    );
    expect(tasks.filter((task) => task.unreadable.length > 0)).toEqual([]);
    const byId = Object.fromEntries(tasks.map((task) => [task.id, task]));
    expect(byId['t1plain1']).toMatchObject({ title: 'Fix ünïcode ✓ 修正', input: LONG, workdir: '/home/a/work' });
    expect(byId['t3occur1']).toMatchObject({
      title: 'Sweep (edited)',
      input: '/sweep --other',
      workdir: '/w/occ',
      scheduleId: 's1sched1',
    });
    expect(byId['t4orphan']).toMatchObject({ title: 'Sweep of a deleted schedule', scheduleId: 'gone0001' });
    expect(byId['t5empty']).toMatchObject({ title: '', input: '', workdir: null });
    expect(byId['t7mixed']).toMatchObject({ title: 'Half sealed', input: 'The prompt is still plain' });
    // A proposal still waiting stays the agent's, and no worker runs it; one the user had started is the user's now.
    expect(byId['t6agent']).toMatchObject({ createdBy: 'agent', input: 'do it' });
    expect(byId['t8start1']).toMatchObject({ createdBy: 'user', input: 'do it now', unreadable: [] });
    for (const id of ['t10sess', 't11run1', 't12move']) expect(byId[id], id).toMatchObject({ createdBy: 'user' });
    // Reopened after a discard, or marked done, without a start: still the agent's, still waiting for the user to start it.
    for (const id of ['t9reopen', 't13done1'])
      expect(byId[id], id).toMatchObject({ createdBy: 'agent', unreadable: [] });
    expect(byId['t2intake']?.head).toBe(await backend.indexHead(SHA));

    const schedules = await backend.listSchedules();
    expect(schedules).toMatchObject([{ id: 's1sched1', title: 'Nightly sweep', input: '/sweep', workdir: '/w/sched' }]);
    expect(schedules[0]?.unreadable).toEqual([]);

    const thread = await backend.readNotes('t1plain1');
    expect(thread.filter((note) => note.unreadable)).toEqual([]);
    const note = (id: string) => thread.find((candidate) => candidate.id === id);
    expect(note('n01')).toMatchObject({ author: 'agent', kind: 'comment', text: 'Looked at ünï ✓ 🙂' });
    expect(note('n04')).toMatchObject({ author: 'server', kind: 'event', text: 'Marked done.' });
    expect(note('n03')).toMatchObject({ author: 'system', kind: 'event' });
    expect(note('n07')).toMatchObject({
      author: 'system',
      text: 'Taken back from my laptop: no sign of life for 20 minutes.',
    });
    expect(note('n09')).toMatchObject({ kind: 'question', questions: QUESTIONS });
    expect(note('n10')).toMatchObject({
      kind: 'answer',
      text: 'go ahead',
      questions: QUESTIONS,
      answers: [{ selected: ['Yes'], other: 'é' }],
    });
    expect(note('n14')).toMatchObject({ text: '' });
    expect(note('n15')?.text).toBe('long note ünï '.repeat(7_000));
    for (const id of ['n11', 'n12', 'n13']) expect(note(id), id).toMatchObject({ author: 'user', kind: 'comment' });
    expect(note('n11')?.text).toMatch(/^no question\n\n- Question 1 → A$/);
    expect(note('n12')?.text).toBe('- Question 1 → A');

    // Intake finds the migrated task of its PR again: neither a second task nor a requeue.
    const lines: string[] = [];
    const listing = {
      prs: [
        {
          url: PR,
          title: 'Add thing',
          author: 'dev',
          number: 17,
          headSha: SHA,
          headCommittedAt: new Date(Date.now() - 3_600_000),
          isDraft: false,
        },
      ],
      unreadable: [],
    };
    await runIntake({
      backend,
      config: CONFIG,
      dryRun: false,
      print: (line) => lines.push(line),
      github: { listReviewRequested: async () => listing },
      now: () => new Date(),
    });
    expect(lines).toContain('SKIP #17 task exists');
    expect(lines.at(-1)).toBe('INTAKE prs=1 created=0 requeued=0 done=0');
    const movedHead = planIntake({
      prs: listing.prs.map((pr) => ({ ...pr, headSha: 'ffffff9' })),
      tasks,
      repos: Object.keys(CONFIG.repos),
      now: new Date(),
      headIndex: (sha) => (sha === 'ffffff9' ? 'abh1.moved' : sha),
    });
    expect(movedHead.map((action) => action.kind)).toEqual(['requeue']);
    await server.close();
  });

  it('is read by the browser code: lists, threads, previews, transcripts, nothing unreadable', async () => {
    const ui = plainUi(app.db, OWNER);
    const list = await ui.tasks.list();
    expect(list).toHaveLength(13);
    const previews = Object.fromEntries(list.map((task) => [task.id, task.lastNote]));
    expect(previews['t1plain1']).toBeTruthy();
    for (const { id } of list) {
      const { task, thread } = await ui.tasks.get({ id });
      expect(task.id).toBe(id);
      expect(thread.every((note) => note.text !== undefined)).toBe(true);
    }
    const runs = await ui.transcript.runs({ id: 't1plain1' });
    expect(runs).toHaveLength(1);
    const events = await ui.transcript.events({ taskId: 't1plain1', runId: runs[0]!.id });
    expect(events).toHaveLength(25);
    expect(events[3]).toMatchObject({ kind: 'note', text: 'note 3 ünï ✓' });
    expect(await ui.transcript.output({ taskId: 't1plain1', runId: runs[0]!.id, seq: 7 })).toBe(BIG_OUTPUT);
    expect(await ui.transcript.output({ taskId: 't1plain1', runId: runs[0]!.id, seq: 2 })).toBe('');
    expect(await ui.transcript.output({ taskId: 't1plain1', runId: runs[0]!.id, seq: 12 })).toBeNull();
    expect(await ui.schedules.list()).toMatchObject([{ id: 's1sched1', title: 'Nightly sweep', workdir: '/w/sched' }]);
  });

  it('a second run changes nothing and touches no row', async () => {
    const before = await snapshot();
    const again = await run();
    expect(await snapshot()).toBe(before);
    for (const [column, { converted }] of Object.entries(again.columns)) expect(converted, column).toBe(0);
    expect(again.columns['task.title']?.alreadySealed).toBe(13);
    expect(Object.values(again.tables).every((table) => table.changed === 0)).toBe(true);
    expect(Object.keys(again.notices)).toEqual([expect.stringMatching(/schedule that no longer exists/)]);
  });

  it('leaves the rows of the other user as they were', async () => {
    const [bob] = await rows<{ title: string }>(`select title from task where owner = 'bob'`);
    expect(bob?.title).toMatch(/^abe1\./);
  });

  it('leaves a sealed suggestion as it is, and refuses one that does not open', async () => {
    const context = 'note:t1plain1:agent:comment';
    const suggestion = await seal(keys, 'note.suggestion', context, 'Yes, open the PR.');
    await admin.db.execute(sql`update note set suggestion = ${suggestion} where id = 'n01'`);
    const before = await snapshot();
    const again = await run();
    expect(again.columns['note.suggestion']).toMatchObject({ converted: 0, alreadySealed: 1 });
    expect(await snapshot()).toBe(before);
    const elsewhere = await seal(keys, 'note.suggestion', 'note:other:agent:comment', 'Yes');
    await admin.db.execute(sql`update note set suggestion = ${elsewhere} where id = 'n01'`);
    await refuses(() => run(), /note\.suggestion of note n01/);
  });
});
