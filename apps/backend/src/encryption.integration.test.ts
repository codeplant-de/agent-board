import { isBlindIndex, isEnvelope } from '@agent-board/shared';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { notes, schedules, tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { caller, question, testConfig, useTestDb } from './test/helpers';
import { MARKERS, sealed } from './test/sealed';

const { db, admin } = useTestDb();

const PLAIN = 'plain text, not an envelope';
const [TITLE, PROMPT, WORKDIR, COMMENT, QUESTION, ANSWER, MESSAGE, PAUSE, FAIL, TOOL_USE, OUTPUT, PR] = MARKERS as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

async function setup() {
  const app = await buildServer(testConfig, db);
  const token = (await caller(db).machines.issue({ name: 'laptop' })).token;
  const raw = async (command: string, body: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    return { status: res.statusCode, json: res.json() as MachineAnswer['json'] };
  };
  return { raw, call: plainMachine(raw), ui: plainUi(db), rawUi: caller(db) };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 12, 0, s)).toISOString();

describe('the machine API refuses plaintext in every sealed field', () => {
  async function fixtures() {
    const { id } = (await ctx.call('add-task', { body: { title: 't', input: 'i' } })).json.result.task;
    const [title, input, workdir, note, questions] = await Promise.all([
      sealed.title('t'),
      sealed.input('i'),
      sealed.workdir('/w'),
      sealed.note(id, 'n'),
      sealed.questions(id, [question]),
    ]);
    return { id, title, input, workdir, note, questions };
  }

  it('on add-task and add-schedule, including the dedupe key', async () => {
    const f = await fixtures();
    const draft = { title: f.title, input: f.input, machine: 'laptop', workdir: f.workdir };
    expect((await ctx.raw('add-task', { body: draft })).status).toBe(200);
    for (const key of ['title', 'input', 'workdir']) {
      const answer = await ctx.raw('add-task', { body: { ...draft, [key]: PLAIN } });
      expect(answer, key).toMatchObject({ status: 400 });
      expect(answer.json.error, key).toMatch(/must be encrypted/);
    }
    expect((await ctx.raw('add-task', { body: { ...draft, dedupeKey: PR } })).status).toBe(400);
    expect((await ctx.raw('add-task', { body: { ...draft, dedupeKey: f.input } })).status).toBe(400);
    expect((await ctx.raw('add-task', { body: { ...draft, labels: ['x'] } })).status).toBe(400);
    const schedule = { ...draft, everyMs: 3_600_000 };
    expect((await ctx.raw('add-schedule', { body: schedule })).status).toBe(200);
    for (const key of ['title', 'input', 'workdir'])
      expect(await ctx.raw('add-schedule', { body: { ...schedule, [key]: PLAIN } }), key).toMatchObject({
        status: 400,
      });
  });

  it('on update-task, notes, questions, pause and fail', async () => {
    const f = await fixtures();
    await ctx.call('claim-task', { id: f.id, machine: 'laptop' });
    expect((await ctx.raw('update-task', { id: f.id, body: { input: f.input, workdir: f.workdir } })).status).toBe(200);
    for (const key of ['input', 'workdir'])
      expect(await ctx.raw('update-task', { id: f.id, body: { [key]: PLAIN } }), key).toMatchObject({ status: 400 });
    for (const author of [undefined, 'system']) {
      expect((await ctx.raw('add-note', { id: f.id, author, body: f.note })).status).toBe(200);
      expect(await ctx.raw('add-note', { id: f.id, author, body: { body: PLAIN } })).toMatchObject({ status: 400 });
      expect(await ctx.raw('add-note', { id: f.id, author, body: { ...f.note, preview: PLAIN } })).toMatchObject({
        status: 400,
      });
    }
    expect(await ctx.raw('add-note', { id: f.id, body: PLAIN })).toMatchObject({ status: 400 });
    for (const command of ['pause', 'fail']) {
      expect(await ctx.raw(command, { id: f.id, body: { body: PLAIN } }), command).toMatchObject({ status: 400 });
      expect(await ctx.raw(command, { id: f.id, body: PLAIN }), command).toMatchObject({ status: 400 });
    }
    const body = await sealed.noteBody(f.id, '');
    for (const bad of [
      { body: PLAIN, questions: f.questions },
      { body, questions: JSON.stringify([question]) },
      { body, questions: [question] },
    ])
      expect(await ctx.raw('ask', { id: f.id, body: bad })).toMatchObject({ status: 400 });
    expect((await ctx.raw('ask', { id: f.id, body: { body, questions: f.questions } })).status).toBe(200);
    expect((await ctx.ui.tasks.get({ id: f.id })).task.status).toBe('needs-me');
  });

  it('on transcript events: data and output', async () => {
    const f = await fixtures();
    const event = async (seq: number, patch: Record<string, unknown> = {}) => ({
      seq,
      at: at(seq),
      parent: null,
      kind: 'tool_result',
      data: await sealed.trData('run-enc-0001', seq, { kind: 'tool_result' }),
      output: await sealed.trOutput('run-enc-0001', seq, 'out'),
      outputSize: 3,
      ...patch,
    });
    const send = (events: unknown[]) =>
      ctx.raw('transcript', {
        id: f.id,
        body: { runId: 'run-enc-0001', startedAt: at(0), sessionId: null, resumed: false, events },
      });
    expect((await send([await event(0)])).status).toBe(200);
    expect((await send([await event(1, { data: '{"kind":"text","text":"x"}' })])).status).toBe(400);
    expect((await send([await event(2, { output: 'plain output' })])).status).toBe(400);
    expect((await send([await event(3, { outputSize: -1 })])).status).toBe(400);
    expect((await send([await event(4, { outputSize: null })])).status).toBe(400);
    expect((await send([await event(5, { kind: 'text', output: undefined, outputSize: undefined })])).status).toBe(200);
  });

  it('and a client can neither write a note as the server nor write one in plain text', async () => {
    const f = await fixtures();
    await ctx.call('claim-task', { id: f.id, machine: 'laptop' });
    await ctx.raw('add-note', { id: f.id, author: 'server', body: f.note });
    await ctx.raw('add-note', { id: f.id, author: 'server', body: { body: 'Marked done.' } });
    await ctx.raw('fail', { id: f.id, body: { body: 'Marked done.' } });
    const rows = await admin.select().from(notes);
    expect(rows.map((n) => n.author)).toEqual(['agent']);
    expect(rows.every((n) => isEnvelope(n.body))).toBe(true);
  });
});

describe('tRPC refuses plaintext in every sealed field', () => {
  it('on create, reply and answer', async () => {
    const [title, input] = await Promise.all([sealed.title('t'), sealed.input('i')]);
    await expect(ctx.rawUi.tasks.create({ title: PLAIN, input })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(ctx.rawUi.tasks.create({ title, input: PLAIN })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const task = await ctx.rawUi.tasks.create({ title, input });
    const note = await sealed.note(task.id, 'hello');
    const refused = async (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await refused(ctx.rawUi.tasks.reply({ id: task.id, message: { body: PLAIN }, resume: false }));
    await refused(ctx.rawUi.tasks.reply({ id: task.id, message: { ...note, preview: PLAIN }, resume: false }));
    await refused(ctx.rawUi.tasks.reply({ id: task.id, message: PLAIN as never, resume: false }));
    await refused(
      ctx.rawUi.tasks.answer({ id: task.id, questionNoteId: 'q', answers: JSON.stringify([]), message: note }),
    );
    await refused(
      ctx.rawUi.tasks.answer({
        id: task.id,
        questionNoteId: 'q',
        answers: await sealed.answers(task.id, []),
        message: { body: PLAIN },
      }),
    );
    expect(await ctx.rawUi.tasks.reply({ id: task.id, message: note, resume: false })).toMatchObject({ id: task.id });
    expect(await admin.select().from(notes)).toHaveLength(1);
  });
});

describe('dedupe keys', () => {
  it('are blind indexes, unique per owner, and the plain URL is never stored', async () => {
    const draft = async (url: string) => ({
      title: await sealed.title('t'),
      input: await sealed.input(url),
      dedupeKey: await sealed.dedupeKey(url),
    });
    const body = await draft(PR);
    expect(isBlindIndex(body.dedupeKey)).toBe(true);
    const first = await ctx.raw('add-task', { body });
    const second = await ctx.raw('add-task', { body });
    expect(first.json.result.created).toBe(true);
    expect(second.json.result).toMatchObject({ created: false, task: { id: first.json.result.task.id } });
    expect((await admin.select().from(tasks)).map((t) => t.dedupeKey)).toEqual([body.dedupeKey]);
    const other = await draft('https://github.com/o/r/pull/2');
    expect((await ctx.raw('add-task', { body: other })).json.result.created).toBe(true);
  });
});

describe('schedules carry ciphertext', () => {
  it('copies the schedule’s sealed title, input and workdir into every occurrence, unchanged and readable', async () => {
    const added = await ctx.call('add-schedule', {
      body: { title: TITLE, input: PROMPT, machine: 'laptop', workdir: `/${WORKDIR}`, everyMs: 3_600_000 },
    });
    expect(added.status).toBe(200);
    const [schedule] = await admin.select().from(schedules);
    const [first] = await admin.select().from(tasks);
    expect([first?.title, first?.input, first?.workdir]).toEqual([schedule?.title, schedule?.input, schedule?.workdir]);
    expect(await sealed.open.title(first!.title)).toBe(TITLE);
    expect(await sealed.open.input(first!.input)).toBe(PROMPT);
    expect(await sealed.open.workdir(first!.workdir!)).toBe(`/${WORKDIR}`);

    expect((await ctx.call('claim-task', { id: first!.id, machine: 'laptop' })).status).toBe(200);
    const occurrences = await admin.select().from(tasks).orderBy(tasks.createdAt);
    expect(occurrences).toHaveLength(2);
    expect(occurrences[1]).toMatchObject({
      title: schedule?.title,
      input: schedule?.input,
      workdir: schedule?.workdir,
    });
    expect(await sealed.open.input(occurrences[1]!.input)).toBe(PROMPT);
  });

  it('does the same for a schedule made through tRPC', async () => {
    await ctx.ui.tasks.create({ title: TITLE, input: PROMPT, when: { every: 3_600_000 } });
    const [schedule] = await admin.select().from(schedules);
    const [task] = await admin.select().from(tasks);
    expect([task?.title, task?.input]).toEqual([schedule?.title, schedule?.input]);
    expect(await sealed.open.title(schedule!.title)).toBe(TITLE);
  });
});

describe('note previews and server events', () => {
  it('the board card shows the stored preview, null without one, and a server event as its plain text', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'i' });
    const card = async () => (await ctx.ui.tasks.list()).find((t) => t.id === task.id)!.lastNote;
    expect(await card()).toBeNull();
    const body = await sealed.noteBody(task.id, 'the full text, which is not what the card shows');
    await ctx.raw('add-note', { id: task.id, body: { body } });
    expect(await card()).toMatchObject({ kind: 'comment', author: 'agent', preview: null, text: null });
    const preview = await sealed.notePreview(task.id, 'PREVIEW-ONLY');
    await ctx.raw('add-note', { id: task.id, body: { body, preview } });
    expect(await card()).toMatchObject({ author: 'agent', text: 'PREVIEW-ONLY' });
    await ctx.ui.tasks.reply({ id: task.id, message: 'x'.repeat(1000), resume: false });
    expect((await card())?.text).toHaveLength(300);
    await ctx.ui.tasks.done({ id: task.id });
    expect(await card()).toMatchObject({
      kind: 'event',
      author: 'server',
      preview: 'Marked done.',
      text: 'Marked done.',
    });
  });

  it('a reply, an answer and a pause keep the preview they were sent with', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'i' });
    await ctx.ui.tasks.reply({ id: task.id, message: 'short comment', resume: false });
    const [row] = await admin.select().from(notes);
    expect(await sealed.open.notePreview(task.id, row!.preview!)).toBe('short comment');
    expect(await sealed.open.noteBody(task.id, row!.body)).toBe('short comment');
  });
});

describe('answers', () => {
  async function asking() {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'i' });
    await ctx.call('claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('ask', { id: task.id, body: { questions: [question] } });
    const { thread } = await ctx.ui.tasks.get({ id: task.id });
    return { id: task.id, questionNoteId: thread.find((n) => n.kind === 'question')!.id };
  }

  it('are not read by the server: it checks only that the open question is the task’s own', async () => {
    const a = await asking();
    const b = await asking();
    await expect(
      ctx.ui.tasks.answer({ id: b.id, questionNoteId: a.questionNoteId, answers: [{ selected: ['Yes'] }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      ctx.ui.tasks.answer({ id: b.id, questionNoteId: 'gone', answers: [{ selected: ['Yes'] }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const nonsense = [{ selected: ['Not an option'] }, { selected: [] }];
    const answered = await ctx.ui.tasks.answer({ ...b, answers: nonsense, message: 'ok' });
    expect(answered).toMatchObject({ status: 'todo', openQuestion: false });
    const note = (await ctx.ui.tasks.get({ id: b.id })).thread.find((n) => n.kind === 'answer');
    expect(note).toMatchObject({ author: 'user', text: 'ok', answers: nonsense, questionNoteId: b.questionNoteId });
  });
});

describe('what the database holds', () => {
  it('has none of the plaintext in any text, jsonb or array column after a full scenario', async () => {
    const { ui, call } = ctx;
    const viaUi = await ui.tasks.create({ title: TITLE, input: `${PROMPT} ${PR}` });
    const viaApi = (
      await call('add-task', {
        body: { title: TITLE, input: PROMPT, machine: 'laptop', workdir: `/${WORKDIR}`, dedupeKey: PR },
      })
    ).json.result.task;
    await call('add-schedule', {
      body: { title: TITLE, input: PROMPT, machine: 'laptop', workdir: `/${WORKDIR}`, everyMs: 3_600_000 },
    });
    await ui.tasks.create({ title: TITLE, input: PROMPT, when: { every: 3_600_000 } });
    await ui.tasks.reply({ id: viaUi.id, message: COMMENT, resume: false });
    await call('add-note', { id: viaUi.id, body: COMMENT });
    await call('add-note', { id: viaUi.id, author: 'system', body: COMMENT });

    const id = viaApi.id;
    await call('claim-task', { id, machine: 'laptop' });
    await call('update-task', { id, body: { sessionId: 's', workdir: `/${WORKDIR}/sub`, input: PROMPT } });
    const asked = { ...question, header: 'Scope', question: QUESTION };
    await call('ask', { id, body: { questions: [asked] } });
    const questionNoteId = (await ui.tasks.get({ id })).thread.find((n) => n.kind === 'question')!.id;
    await ui.tasks.answer({ id, questionNoteId, answers: [{ selected: ['Yes'], other: ANSWER }], message: MESSAGE });
    await call('claim-task', { id, machine: 'laptop' });
    await call('pause', { id, body: PAUSE });
    await call('claim-task', { id, machine: 'laptop' });
    await call('transcript', {
      id,
      body: {
        runId: 'run-scan-0001',
        startedAt: at(0),
        sessionId: 's',
        resumed: false,
        events: [
          {
            seq: 0,
            at: at(1),
            parent: null,
            kind: 'tool_use',
            toolUseId: 'tu',
            name: 'Bash',
            input: { command: TOOL_USE },
          },
          { seq: 1, at: at(2), parent: null, kind: 'tool_result', toolUseId: 'tu', isError: false, output: OUTPUT },
        ],
      },
    });
    expect((await call('fail', { id, body: FAIL })).json.result.applied).toBe(true);
    await ui.tasks.done({ id });

    const { rows: columns } = await admin.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and (data_type in ('text', 'jsonb', 'json', 'character varying') or data_type = 'ARRAY')
      order by table_name, column_name`);
    const names = columns.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'task.title',
        'task.input',
        'task.workdir',
        'task.dedupe_key',
        'note.body',
        'note.preview',
      ]),
    );
    expect(names).toEqual(
      expect.arrayContaining(['note.questions', 'note.answers', 'transcript_event.data', 'transcript_event.output']),
    );
    const hits: string[] = [];
    for (const { table_name, column_name } of columns) {
      for (const marker of MARKERS) {
        const { rows } = await admin.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sql.identifier(table_name)} where ${sql.identifier(column_name)}::text like ${`%${marker}%`}`,
        );
        if (rows[0]!.n > 0) hits.push(`${table_name}.${column_name} holds ${marker}`);
      }
    }
    expect(hits).toEqual([]);

    const all = await admin.select().from(notes);
    const plain = all.filter((n) => !isEnvelope(n.body));
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((n) => n.author === 'server' && n.kind === 'event')).toBe(true);
    expect(all.filter((n) => n.author === 'server').every((n) => !isEnvelope(n.body))).toBe(true);
    expect(plain.map((n) => n.body).some((body) => MARKERS.some((marker) => body.includes(marker)))).toBe(false);
    const sealedRows = all.filter((n) => isEnvelope(n.body));
    expect(sealedRows.length).toBeGreaterThan(5);
    for (const row of await admin.select().from(tasks))
      expect(isEnvelope(row.title) && isEnvelope(row.input)).toBe(true);
  });
});
