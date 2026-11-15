import {
  isBlindIndex,
  isEnvelope,
  newTaskId,
  sealAnswers,
  sealFields,
  sealNote,
  sealQuestions,
  transcriptBinding,
  type RowRef,
} from '@agent-board/shared';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { notes, schedules, tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { caller, question, SESSION, testConfig, useTestDb } from './test/helpers';
import { MARKERS, sealed } from './test/sealed';

const { db, admin } = useTestDb();

const PLAIN = 'plain text, not an envelope';
const [TITLE, PROMPT, WORKDIR, , , ANSWER, MESSAGE, , , , , PR, HEAD] = MARKERS as [
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

const taskRef = (id: string): RowRef => ({ kind: 'task', id, createdBy: 'user', scheduleId: null });

/** How much the database holds, so that a refused request can be shown to have written nothing. */
async function rowCounts(): Promise<number[]> {
  const { rows } = await admin.execute<{ n: number }>(sql`
    select (select count(*) from task)::int as n union all select (select count(*) from note)::int
    union all select (select count(*) from schedule)::int union all select (select count(*) from transcript_event)::int`);
  return rows.map((row) => row.n);
}

/** Every sealed value of a request, as a path into its body: each in turn gets plain text, and the server must refuse it. */
type Path = (string | number)[];

function withValue<T>(value: T, path: Path, replacement: unknown): T {
  if (path.length === 0) return replacement as T;
  const [head, ...rest] = path as [string | number, ...Path];
  const copy = Array.isArray(value) ? [...value] : { ...(value as object) };
  (copy as Record<string | number, unknown>)[head] = withValue(
    (value as Record<string | number, unknown>)[head],
    rest,
    replacement,
  );
  return copy as T;
}

describe('the machine API refuses plaintext in every sealed field', () => {
  async function task(id = newTaskId()) {
    const fields = await sealFields(sealed.seal, taskRef(id), { title: 't', input: 'i', workdir: '/w' });
    return { id, ...fields, machine: 'laptop' };
  }

  /** Sends the request as it is (it must be accepted), then once per path with plain text there (each must be refused, writing nothing). */
  async function refusesPlainAt(
    command: string,
    request: Record<string, unknown>,
    paths: Path[],
    afterwards?: () => Promise<void>,
  ) {
    expect((await ctx.raw(command, request)).status, `${command} as sent`).toBe(200);
    await afterwards?.();
    const before = await rowCounts();
    for (const path of paths) {
      const answer = await ctx.raw(command, withValue(request, ['body', ...path], PLAIN));
      expect(answer.status, `${command} ${path.join('.')}`).toBe(400);
      expect(answer.json.error, `${command} ${path.join('.')}`).toMatch(/must be encrypted|must be a blind index/);
    }
    expect(await rowCounts()).toEqual(before);
  }

  async function running() {
    const { id } = (await ctx.call('add-task', { body: { title: 't', input: 'i' } })).json.result.task;
    await ctx.call('claim-task', { id, machine: 'laptop' });
    return id as string;
  }

  it('on add-task: title, input, workdir, dedupe key and head', async () => {
    const draft = { ...(await task()), dedupeKey: await sealed.blind(PR), head: await sealed.headIndex(HEAD) };
    await refusesPlainAt('add-task', { body: draft }, [['title'], ['input'], ['workdir'], ['dedupeKey'], ['head']]);
    expect((await ctx.raw('add-task', { body: { ...(await task()), dedupeKey: draft.input } })).status).toBe(400);
    expect((await ctx.raw('add-task', { body: { ...(await task()), labels: ['x'] } })).status).toBe(400);
    expect((await ctx.raw('add-task', { body: { ...(await task()), id: undefined } })).status).toBe(400);
  });

  it('on add-schedule: title, input and workdir', async () => {
    const id = newTaskId();
    const fields = await sealFields(sealed.seal, { kind: 'schedule', id }, { title: 't', input: 'i', workdir: '/w' });
    await refusesPlainAt('add-schedule', { body: { id, ...fields, machine: 'laptop', everyMs: 3_600_000 } }, [
      ['title'],
      ['input'],
      ['workdir'],
    ]);
  });

  it('on update-task: input, workdir and head', async () => {
    const id = await running();
    const sealedTask = await task(id);
    await refusesPlainAt('update-task', { id, body: { input: sealedTask.input, workdir: sealedTask.workdir } }, [
      ['input'],
      ['workdir'],
    ]);
    expect((await ctx.raw('update-task', { id, body: { head: PLAIN } })).status).toBe(400);
    expect((await ctx.raw('update-task', { id, body: { sessionId: PLAIN } })).status).toBe(400);
    expect((await ctx.raw('update-task', { id, body: { sessionId: SESSION } })).status).toBe(200);
  });

  it('on add-note: body and preview, as agent and as system', async () => {
    const id = await running();
    for (const [author, kind] of [
      [undefined, 'comment'],
      ['system', 'event'],
    ] as const) {
      const note = await sealNote(sealed.seal, { taskId: id, author: author ?? 'agent', kind }, 'n');
      await refusesPlainAt('add-note', { id, author, body: note }, [['body'], ['preview']]);
    }
    expect(await ctx.raw('add-note', { id, body: PLAIN })).toMatchObject({ status: 400 });
  });

  it('on pause and fail: body and preview', async () => {
    const id = await running();
    const note = await sealNote(sealed.seal, { taskId: id, author: 'system', kind: 'event' }, 'n');
    for (const command of ['pause', 'fail']) {
      const before = await rowCounts();
      for (const path of [['body'], ['preview']]) {
        const answer = await ctx.raw(command, { id, body: withValue(note, path, PLAIN) });
        expect(answer.status, `${command} ${path.join('.')}`).toBe(400);
      }
      expect(await ctx.raw(command, { id, body: PLAIN }), command).toMatchObject({ status: 400 });
      expect(await rowCounts()).toEqual(before);
    }
    expect((await ctx.raw('pause', { id, body: note })).status).toBe(200);
    await ctx.call('claim-task', { id, machine: 'laptop' });
    expect((await ctx.raw('fail', { id, body: note })).status).toBe(200);
  });

  it('on ask: body and questions', async () => {
    const id = await running();
    const asked = await sealQuestions(sealed.seal, id, [question]);
    const before = await rowCounts();
    for (const bad of [
      { ...asked, body: PLAIN },
      { ...asked, questions: PLAIN },
      { ...asked, questions: JSON.stringify([question]) },
      { ...asked, questions: [question] },
    ])
      expect(await ctx.raw('ask', { id, body: bad })).toMatchObject({ status: 400 });
    expect(await rowCounts()).toEqual(before);
    expect((await ctx.raw('ask', { id, body: asked })).status).toBe(200);
    expect((await ctx.ui.tasks.get({ id })).task.status).toBe('needs-me');
  });

  it('on transcript events: data and output', async () => {
    const id = await running();
    const event = async (seq: number, patch: Record<string, unknown> = {}) => ({
      seq,
      at: at(seq),
      parent: null,
      kind: 'tool_result',
      data: await sealed.seal(
        transcriptBinding('tr.data', id, 'run-enc-0001', seq),
        JSON.stringify({ kind: 'tool_result' }),
      ),
      output: await sealed.seal(transcriptBinding('tr.output', id, 'run-enc-0001', seq), 'out'),
      outputSize: 3,
      ...patch,
    });
    const send = (events: unknown[]) =>
      ctx.raw('transcript', {
        id,
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
    const id = await running();
    const note = await sealNote(sealed.seal, { taskId: id, author: 'agent', kind: 'comment' }, 'n');
    await ctx.raw('add-note', { id, author: 'server', body: note });
    await ctx.raw('add-note', { id, author: 'server', body: { body: 'Marked done.' } });
    await ctx.raw('fail', { id, body: { body: 'Marked done.' } });
    const rows = await admin.select().from(notes);
    expect(rows.map((n) => n.author)).toEqual(['agent']);
    expect(rows.every((n) => isEnvelope(n.body))).toBe(true);
  });

  it('too long a sealed value is refused as well, whatever it holds', async () => {
    const id = await running();
    const huge = `abe1.${'A'.repeat(2_000_000)}`;
    expect((await ctx.raw('add-note', { id, body: { body: huge } })).json.error).toMatch(/too long/);
    expect((await ctx.raw('update-task', { id, body: { input: huge } })).json.error).toMatch(/too long/);
  });
});

describe('tRPC refuses plaintext in every sealed field', () => {
  const refused = async (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST' });

  it('on create: title and input, for a task and for a schedule', async () => {
    const id = newTaskId();
    const fields = await sealFields(sealed.seal, taskRef(id), { title: 't', input: 'i' });
    await refused(ctx.rawUi.tasks.create({ id, ...fields, title: PLAIN }));
    await refused(ctx.rawUi.tasks.create({ id, ...fields, input: PLAIN }));
    await refused(ctx.rawUi.tasks.create({ id, ...fields, when: { every: 3_600_000 }, title: PLAIN }));
    await refused(ctx.rawUi.tasks.create({ id, ...fields, when: { every: 3_600_000 }, input: PLAIN }));
    expect(await rowCounts()).toEqual([0, 0, 0, 0]);
    expect(await ctx.rawUi.tasks.create({ id, ...fields })).toMatchObject({ id });
  });

  it('on reply and answer: the message, its preview and the answers', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'i' });
    const note = await sealNote(sealed.seal, { taskId: task.id, author: 'user', kind: 'comment' }, 'hello');
    await refused(ctx.rawUi.tasks.reply({ id: task.id, message: { body: PLAIN }, resume: false }));
    await refused(ctx.rawUi.tasks.reply({ id: task.id, message: { ...note, preview: PLAIN }, resume: false }));
    await refused(ctx.rawUi.tasks.reply({ id: task.id, message: PLAIN as never, resume: false }));
    const answers = await sealAnswers(sealed.seal, task.id, [question], [{ selected: ['Yes'] }]);
    const message = await sealNote(sealed.seal, { taskId: task.id, author: 'user', kind: 'answer' }, 'ok');
    const answer = { id: task.id, questionNoteId: 'q', answers, message };
    await refused(ctx.rawUi.tasks.answer({ ...answer, answers: JSON.stringify([]) }));
    await refused(ctx.rawUi.tasks.answer({ ...answer, answers: PLAIN }));
    await refused(ctx.rawUi.tasks.answer({ ...answer, message: { body: PLAIN } }));
    await refused(ctx.rawUi.tasks.answer({ ...answer, message: { ...message, preview: PLAIN } }));
    expect(await ctx.rawUi.tasks.reply({ id: task.id, message: note, resume: false })).toMatchObject({ id: task.id });
    expect(await admin.select().from(notes)).toHaveLength(1);
  });
});

describe('client-chosen ids', () => {
  it('a task or schedule id that is taken is a conflict, whoever holds it, and nothing is written', async () => {
    const id = newTaskId();
    const fields = await sealFields(sealed.seal, taskRef(id), { title: 't', input: 'i' });
    expect((await ctx.raw('add-task', { body: { id, ...fields } })).status).toBe(200);
    const before = await rowCounts();
    const again = await ctx.raw('add-task', { body: { id, ...fields } });
    expect(again).toMatchObject({ status: 409, json: { error: 'that task id is already taken' } });
    await expect(ctx.rawUi.tasks.create({ id, ...fields })).rejects.toMatchObject({ code: 'CONFLICT' });
    const scheduleFields = await sealFields(sealed.seal, { kind: 'schedule', id }, { title: 't', input: 'i' });
    expect(
      (await ctx.raw('add-schedule', { body: { id: 'sched-one', ...scheduleFields, everyMs: 3_600_000 } })).status,
    ).toBe(200);
    expect(
      (await ctx.raw('add-schedule', { body: { id: 'sched-one', ...scheduleFields, everyMs: 3_600_000 } })).status,
    ).toBe(409);
    expect((await rowCounts()).slice(2, 3)).toEqual([1]);
    expect(before[0]).toBe(1);
  });

  it('an id the dedupe key already holds returns that task, not a conflict', async () => {
    const draft = async () => {
      const id = newTaskId();
      return {
        id,
        ...(await sealFields(sealed.seal, taskRef(id), { title: 't', input: PR })),
        dedupeKey: await sealed.blind(PR),
      };
    };
    const first = await ctx.raw('add-task', { body: await draft() });
    const second = await ctx.raw('add-task', { body: await draft() });
    expect(second.json.result).toMatchObject({ created: false, task: { id: first.json.result.task.id } });
  });
});

describe('dedupe keys and heads', () => {
  it('are blind indexes, unique per owner, and neither the plain URL nor the plain sha is stored', async () => {
    const draft = async (url: string) => ({
      title: 't',
      input: url,
      dedupeKey: url,
      head: HEAD,
    });
    const first = await ctx.call('add-task', { body: await draft(PR) });
    const second = await ctx.call('add-task', { body: await draft(PR) });
    expect(first.json.result.created).toBe(true);
    expect(second.json.result).toMatchObject({ created: false, task: { id: first.json.result.task.id } });
    const [row] = await admin.select().from(tasks);
    expect(row?.dedupeKey).toBe(await sealed.blind(PR));
    expect(isBlindIndex(row!.dedupeKey!)).toBe(true);
    expect(row?.head).toBe(await sealed.headIndex(HEAD));
    expect(isBlindIndex(row!.head!)).toBe(true);
    expect(row?.head).not.toBe(await sealed.blind(HEAD));
    const other = await ctx.call('add-task', { body: await draft('https://github.com/o/r/pull/2') });
    expect(other.json.result.created).toBe(true);
  });
});

describe('schedules carry ciphertext', () => {
  it('copies the schedule’s sealed title, input and workdir into every occurrence, unchanged and readable against the schedule', async () => {
    const added = await ctx.call('add-schedule', {
      body: { title: TITLE, input: PROMPT, machine: 'laptop', workdir: `/${WORKDIR}`, everyMs: 3_600_000 },
    });
    expect(added.status).toBe(200);
    const [schedule] = await admin.select().from(schedules);
    const [first] = await admin.select().from(tasks);
    expect(first?.scheduleId).toBe(schedule?.id);
    expect([first?.title, first?.input, first?.workdir]).toEqual([schedule?.title, schedule?.input, schedule?.workdir]);
    expect(added.json.result.task).toMatchObject({ title: TITLE, input: PROMPT, workdir: `/${WORKDIR}` });

    expect((await ctx.call('claim-task', { id: first!.id, machine: 'laptop' })).status).toBe(200);
    const occurrences = await admin.select().from(tasks).orderBy(tasks.createdAt);
    expect(occurrences).toHaveLength(2);
    expect(occurrences[1]).toMatchObject({
      title: schedule?.title,
      input: schedule?.input,
      workdir: schedule?.workdir,
      scheduleId: schedule?.id,
    });
    const listed = (await ctx.call('list-tasks')).json.result;
    expect(listed.map((t: { input: string }) => t.input)).toEqual([PROMPT, PROMPT]);
  });

  it('and an occurrence still opens after its schedule is deleted', async () => {
    const added = await ctx.call('add-schedule', { body: { title: TITLE, input: PROMPT, everyMs: 3_600_000 } });
    const { id: occurrence } = added.json.result.task;
    await ctx.call('claim-task', { id: occurrence, machine: 'laptop' });
    await ctx.call('remove-schedule', { id: added.json.result.schedule.id });
    expect(await admin.select().from(schedules)).toEqual([]);
    const task = (await ctx.call('get-task', { id: occurrence })).json.result;
    expect(task).toMatchObject({ title: TITLE, input: PROMPT, scheduleId: added.json.result.schedule.id });
  });

  it('does the same for a schedule made through tRPC', async () => {
    await ctx.ui.tasks.create({ title: TITLE, input: PROMPT, when: { every: 3_600_000 } });
    const [schedule] = await admin.select().from(schedules);
    const [task] = await admin.select().from(tasks);
    expect([task?.title, task?.input]).toEqual([schedule?.title, schedule?.input]);
    expect((await ctx.ui.schedules.list())[0]).toMatchObject({ title: TITLE, input: PROMPT });
    expect((await ctx.ui.tasks.list())[0]).toMatchObject({ title: TITLE, input: PROMPT });
  });
});

describe('note previews and server events', () => {
  it('the board card shows the stored preview, null without one, and a server event as its plain text', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'i' });
    const card = async () => (await ctx.ui.tasks.list()).find((t) => t.id === task.id)!.lastNote;
    expect(await card()).toBeNull();
    const note = (text: string) => sealNote(sealed.seal, { taskId: task.id, author: 'agent', kind: 'comment' }, text);
    const full = await note('the full text, which is not what the card shows');
    await ctx.raw('add-note', { id: task.id, body: { body: full.body } });
    expect(await card()).toMatchObject({ kind: 'comment', author: 'agent', preview: null, text: null });
    const preview = (await note('PREVIEW-ONLY')).preview;
    await ctx.raw('add-note', { id: task.id, body: { body: full.body, preview } });
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
    expect(row?.preview).not.toBeNull();
    const [note] = (await ctx.ui.tasks.get({ id: task.id })).thread;
    expect(note).toMatchObject({ text: 'short comment', author: 'user', kind: 'comment' });
  });
});

describe('suggested replies', () => {
  const comment = async (id: string, text: string, suggestion?: string) =>
    sealNote(sealed.seal, { taskId: id, author: 'agent', kind: 'comment' }, text, suggestion ? { suggestion } : {});

  it('an agent comment keeps its sealed suggestion, and the thread serves it back to the browser', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'i' });
    await ctx.call('claim-task', { id: task.id, machine: 'laptop' });
    const note = await comment(task.id, 'Ready for review.', 'Yes, open the PR.');
    expect((await ctx.raw('add-note', { id: task.id, body: note })).status).toBe(200);
    const [row] = await admin.select().from(notes);
    expect(isEnvelope(row?.suggestion ?? '')).toBe(true);
    expect(JSON.stringify(row)).not.toContain('open the PR');
    const [served] = (await ctx.ui.tasks.get({ id: task.id })).thread;
    expect(served).toMatchObject({ text: 'Ready for review.', suggestion: 'Yes, open the PR.' });
    const read = await ctx.raw('read-notes', { id: task.id });
    expect(read.json.result[0].suggestion).toBe(note.suggestion);
  });

  it('is refused in plain text, on a system note, and on pause and fail, and a reply of the user never keeps one', async () => {
    const id = (await ctx.ui.tasks.create({ title: 't', input: 'i' })).id;
    await ctx.call('claim-task', { id, machine: 'laptop' });
    const note = await comment(id, 'n', 'Yes.');
    expect((await ctx.raw('add-note', { id, body: { ...note, suggestion: PLAIN } })).status).toBe(400);
    expect((await ctx.raw('add-note', { id, author: 'system', body: note })).status).toBe(400);
    for (const command of ['pause', 'fail'])
      expect((await ctx.raw(command, { id, body: note })).status, command).toBe(400);
    const reply = await sealNote(sealed.seal, { taskId: id, author: 'user', kind: 'comment' }, 'hi');
    await ctx.rawUi.tasks.reply({ id, message: { ...reply, suggestion: note.suggestion } as never, resume: false });
    expect((await admin.select().from(notes)).map((row) => [row.author, row.suggestion])).toEqual([['user', null]]);
  });

  it('is refused when too long for the board', async () => {
    const id = (await ctx.ui.tasks.create({ title: 't', input: 'i' })).id;
    const huge = `abe1.${'A'.repeat(20_000)}`;
    expect(
      (await ctx.raw('add-note', { id, body: { ...(await comment(id, 'n')), suggestion: huge } })).json.error,
    ).toMatch(/too long/);
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
    // An answer that does not fit its question is the client's business: here it is sealed without the check.
    const nonsense = [{ selected: ['Not an option'] }, { selected: [] }];
    const message = await sealNote(sealed.seal, { taskId: b.id, author: 'user', kind: 'answer' }, 'ok');
    const answers = await sealed.seal(
      { field: 'note.answers', context: `note:${b.id}:user:answer` },
      JSON.stringify({ questions: [question], answers: nonsense }),
    );
    const answered = await ctx.rawUi.tasks.answer({ id: b.id, questionNoteId: b.questionNoteId, answers, message });
    expect(answered).toMatchObject({ status: 'todo', openQuestion: false });
    const row = (await admin.select().from(notes)).find((n) => n.kind === 'answer');
    expect(row).toMatchObject({ author: 'user', questionNoteId: b.questionNoteId, answers });
  });

  it('are stored with the questions the user was shown, in one envelope', async () => {
    const a = await asking();
    await ctx.ui.tasks.answer({ ...a, answers: [{ selected: ['Yes'], other: ANSWER }], message: MESSAGE });
    const note = (await ctx.ui.tasks.get({ id: a.id })).thread.find((n) => n.kind === 'answer');
    expect(note).toMatchObject({
      author: 'user',
      text: MESSAGE,
      questions: [question],
      answers: [{ selected: ['Yes'], other: ANSWER }],
    });
  });
});
