import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { caller, sessionNamed, testConfig, useTestDb } from './test/helpers';

const { db, admin } = useTestDb();
const HOUR = 3_600_000;

async function setup() {
  const app = await buildServer(testConfig, db);
  const { token } = await caller(db).machines.issue({ name: 'laptop' });
  const raw = async (command: string, body: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    return { status: res.statusCode, json: res.json() as MachineAnswer['json'] };
  };
  return { call: plainMachine(raw), ui: plainUi(db) };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

const edit = (id: string, title = 'New title', input = 'New prompt', previous = 'Prompt before editing') =>
  ctx.ui.tasks.edit({ id, title, input, previous });
const row = async (id: string) => (await admin.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const threadOf = async (id: string) => (await ctx.ui.tasks.get({ id })).thread.map((note) => note.text);
const claim = (id: string) => ctx.call('claim-task', { id, machine: 'laptop' });
/** A worker claims the task and gives it back before any session was reported. */
const claimAndRelease = async (id: string) => {
  await claim(id);
  expect((await ctx.call('update-task', { id, body: { status: 'todo' } })).status).toBe(200);
};

describe('editing the prompt of a task that has not started', () => {
  it.each(['now', 'backlog'] as const)(
    'takes a new title and prompt in %s and keeps the old text in a note',
    async (when) => {
      const task = await ctx.ui.tasks.create({ title: 'Old title', input: 'Old prompt', when });
      const before = await row(task.id);
      const edited = await edit(task.id, 'New title', 'New prompt', 'Prompt before editing\n\nOld prompt');
      expect(edited).toMatchObject({ title: 'New title', input: 'New prompt', status: before.status, started: false });
      expect((await ctx.ui.tasks.get({ id: task.id })).task).toMatchObject({ title: 'New title', input: 'New prompt' });
      expect(await threadOf(task.id)).toEqual(['Prompt before editing\n\nOld prompt']);
      const { thread } = await ctx.ui.tasks.get({ id: task.id });
      expect(thread[0]).toMatchObject({ author: 'user', kind: 'event' });
      expect((await row(task.id)).updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    },
  );

  it('can be edited again, one note per edit', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'one', when: 'backlog' });
    await edit(task.id, 't', 'two', 'was one');
    await edit(task.id, 't', 'three', 'was two');
    expect(await threadOf(task.id)).toEqual(['was one', 'was two']);
    expect((await ctx.ui.tasks.get({ id: task.id })).task.input).toBe('three');
  });

  it('seals under the agent of a task that has one', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'one', agent: 'reviewer', when: 'backlog' });
    expect(await edit(task.id)).toMatchObject({ input: 'New prompt', agent: 'reviewer' });
  });

  it('refuses a ciphertext that is not sealed', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'x', when: 'backlog' });
    const sealed = await ctx.ui.tasks.edit({ id: task.id, title: 'a', input: 'b', previous: 'c' });
    expect(sealed.input).toBe('b');
    const { thread } = await ctx.ui.raw.tasks.get({ id: task.id });
    await expect(
      ctx.ui.raw.tasks.edit({ id: task.id, title: 'plain', input: 'plain', previous: { body: thread[0]!.body } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('refusing to edit a prompt', () => {
  it('refuses an agent’s proposal and a task an agent created', async () => {
    const proposal = (await ctx.call('add-task', { body: { title: 'idea', input: 'do Y', createdBy: 'agent' } })).json
      .result.task;
    await expect(edit(proposal.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const mine = await ctx.ui.tasks.create({ title: 't', input: 'x', when: 'backlog' });
    await admin.update(tasks).set({ createdBy: 'agent' }).where(eq(tasks.id, mine.id));
    await expect(edit(mine.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await row(proposal.id)).input).not.toBe('New prompt');
  });

  it('refuses a closed task, and one in Needs me, Running or Done', async () => {
    const closed = await ctx.ui.tasks.create({ title: 't', input: 'x', when: 'backlog' });
    await ctx.ui.tasks.setClosed({ id: closed.id, closed: true });
    await expect(edit(closed.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    const hold = await ctx.ui.tasks.create({ title: 't', input: 'x', when: 'hold' });
    await expect(edit(hold.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    const running = await ctx.ui.tasks.create({ title: 't', input: 'x' });
    await claim(running.id);
    await expect(edit(running.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('has started'),
    });

    const done = await ctx.ui.tasks.create({ title: 't', input: 'x', when: 'backlog' });
    await ctx.ui.tasks.done({ id: done.id });
    await expect(edit(done.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await row(done.id)).input).not.toBe('New prompt');
  });

  it('refuses a task a worker claimed, even when it went back to Todo before reporting a session', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'x' });
    await claimAndRelease(task.id);
    expect((await ctx.ui.tasks.get({ id: task.id })).task.status).toBe('todo');
    expect((await ctx.ui.tasks.get({ id: task.id })).task.started).toBe(true);
    await expect(edit(task.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('has started'),
    });
    expect(await threadOf(task.id)).not.toContain('Prompt before editing');
  });

  it('refuses a task that ran, re-run fresh and waits in Todo or Backlog again', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'x', place: { machine: 'laptop', workdir: '/w' } });
    await claim(task.id);
    await ctx.call('update-task', { id: task.id, body: { sessionId: sessionNamed(1) } });
    await ctx.call('update-task', { id: task.id, body: { status: 'needs-me' } });
    await ctx.ui.tasks.rerun({ id: task.id });
    await expect(edit(task.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a schedule’s card, which takes its prompt from the schedule, and changes nothing', async () => {
    const card = await ctx.ui.tasks.create({ title: 'Sweep', input: 'old', when: { every: HOUR } });
    await expect(edit(card.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Schedules page'),
    });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Sweep', input: 'old' });
    expect(await threadOf(card.id)).toEqual([]);
    expect((await ctx.ui.schedules.list())[0]).toMatchObject({ title: 'Sweep', input: 'old' });
  });

  it('says not found for a task that does not exist', async () => {
    await expect(edit('nothere1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('editing a schedule', () => {
  async function scheduled(title = 'Sweep', input = 'old') {
    const card = await ctx.ui.tasks.create({ title, input, when: { every: HOUR } });
    return { card, scheduleId: card.scheduleId! };
  }

  it('changes the schedule and its pending card, which then reads under the schedule’s binding', async () => {
    const { card, scheduleId } = await scheduled();
    const { schedule, pending } = await ctx.ui.schedules.edit({
      id: scheduleId,
      title: 'Nightly',
      input: 'new',
    });
    expect(pending).toBe('updated');
    expect(schedule).toMatchObject({ id: scheduleId, title: 'Nightly', input: 'new', occurrenceTaskId: card.id });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Nightly', input: 'new' });
  });

  it('seals under the schedule’s agent', async () => {
    const card = await ctx.ui.tasks.create({ title: 's', input: 'old', agent: 'reviewer', when: { every: HOUR } });
    const { schedule } = await ctx.ui.schedules.edit({ id: card.scheduleId!, title: 'n', input: 'new' });
    expect(schedule).toMatchObject({ input: 'new', agent: 'reviewer' });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ input: 'new', agent: 'reviewer' });
  });

  it('leaves a card a worker claimed alone: the next card is the pending one and takes the new prompt', async () => {
    const { card, scheduleId } = await scheduled();
    await claimAndRelease(card.id);
    const next = (await ctx.ui.schedules.list())[0]!.occurrenceTaskId!;
    expect(next).not.toBe(card.id);
    const { pending } = await ctx.ui.schedules.edit({ id: scheduleId, title: 'Nightly', input: 'new' });
    expect(pending).toBe('updated');
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Sweep', input: 'old' });
    expect((await ctx.ui.tasks.get({ id: next })).task).toMatchObject({ title: 'Nightly', input: 'new' });
  });

  it('leaves a pending card that somehow started alone and changes only the schedule', async () => {
    const { card, scheduleId } = await scheduled();
    await admin.update(tasks).set({ lastActiveAt: new Date() }).where(eq(tasks.id, card.id));
    const { pending } = await ctx.ui.schedules.edit({ id: scheduleId, title: 'Nightly', input: 'new' });
    expect(pending).toBe('started');
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Sweep', input: 'old' });
    expect((await ctx.ui.schedules.list())[0]).toMatchObject({ title: 'Nightly', input: 'new' });
  });

  it('leaves a card that moved on alone, and the next card takes the new prompt', async () => {
    const { card, scheduleId } = await scheduled();
    await ctx.ui.tasks.move({ id: card.id, status: 'backlog' });
    const next = (await ctx.ui.schedules.list())[0]!.occurrenceTaskId!;
    expect(next).not.toBe(card.id);
    await ctx.ui.schedules.edit({ id: scheduleId, title: 'Nightly', input: 'new' });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Sweep', input: 'old' });
    expect((await ctx.ui.tasks.get({ id: next })).task).toMatchObject({ title: 'Nightly', input: 'new' });
    await ctx.ui.tasks.move({ id: next, status: 'backlog' });
    const after = (await ctx.ui.schedules.list())[0]!.occurrenceTaskId!;
    expect((await ctx.ui.tasks.get({ id: after })).task).toMatchObject({ title: 'Nightly', input: 'new' });
  });

  it('leaves a closed pending card alone', async () => {
    const { card, scheduleId } = await scheduled();
    await admin.update(tasks).set({ closed: true }).where(eq(tasks.id, card.id));
    expect((await ctx.ui.schedules.edit({ id: scheduleId, title: 'n', input: 'new' })).pending).toBe('started');
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Sweep', input: 'old' });
  });

  it('edits a paused schedule, which has no pending card', async () => {
    const { scheduleId } = await scheduled();
    await ctx.ui.schedules.setPaused({ id: scheduleId, paused: true });
    const { schedule, pending } = await ctx.ui.schedules.edit({ id: scheduleId, title: 'n', input: 'new' });
    expect(pending).toBe('none');
    expect(schedule).toMatchObject({ paused: true, input: 'new' });
  });

  it('refuses an ended schedule, a schedule that does not exist and text that is not sealed', async () => {
    const { scheduleId } = await scheduled();
    await expect(ctx.ui.schedules.edit({ id: 'nothere1', title: 'n', input: 'new' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(ctx.ui.raw.schedules.edit({ id: scheduleId, title: 'plain', input: 'plain' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const ended = await ctx.ui.tasks.create({ title: 'once', input: 'x', when: { every: HOUR, times: 1 } });
    await ctx.ui.tasks.move({ id: ended.id, status: 'backlog' });
    const [listed] = (await ctx.ui.schedules.list()).filter((s) => s.id === ended.scheduleId);
    expect(listed).toMatchObject({ ended: true });
    await expect(ctx.ui.schedules.edit({ id: ended.scheduleId!, title: 'n', input: 'new' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
