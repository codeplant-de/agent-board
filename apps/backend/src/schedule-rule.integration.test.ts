import { MAX_SCHEDULE_CRONS } from '@agent-board/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { schedules, tasks } from './db/schema';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { buildServer } from './server';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db, admin } = useTestDb();
const HOUR = 3_600_000;
const crons = { cron: '0 9 * * 5#1', moreCrons: ['0 9 * * 5#3'], timezone: 'UTC' };

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

async function scheduled(when: Record<string, unknown> = { every: HOUR }) {
  const card = await ctx.ui.tasks.create({ title: 'Sweep', input: 'x', when: when as { every: number } });
  return { card, scheduleId: card.scheduleId! };
}
const scheduleRow = async (id: string) => (await admin.select().from(schedules).where(eq(schedules.id, id)))[0]!;
const taskRow = async (id: string) => (await admin.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const cardsOf = (scheduleId: string) => admin.select().from(tasks).where(eq(tasks.scheduleId, scheduleId));

describe('changing the repeat rule of a schedule', () => {
  it('turns an interval into cron expressions and moves the pending card to the next match', async () => {
    const { card, scheduleId } = await scheduled();
    const before = await scheduleRow(scheduleId);
    const { schedule, pending } = await ctx.ui.schedules.setRule({ id: scheduleId, ...crons });
    expect(pending).toBe('updated');
    expect(schedule).toMatchObject({ everyMs: null, ...crons, occurrenceTaskId: card.id });
    const row = await scheduleRow(scheduleId);
    expect(row).toMatchObject({ everyMs: null, cron: crons.cron, moreCrons: crons.moreCrons, timezone: 'UTC' });
    expect(row.anchorAt).toEqual(before.anchorAt);
    const moved = (await taskRow(card.id)).notBefore!;
    expect(moved.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastOccurrenceAt).toEqual(moved);
    expect(schedule.nextRunAt).toEqual(moved);
    expect(moved.getUTCHours()).toBe(9);
    expect(moved.getUTCDay()).toBe(5);
  });

  it('turns cron expressions into an interval and clears the cron fields', async () => {
    const { card, scheduleId } = await scheduled({ ...crons });
    const { schedule, pending } = await ctx.ui.schedules.setRule({ id: scheduleId, every: 2 * HOUR });
    expect(pending).toBe('updated');
    expect(schedule).toMatchObject({ everyMs: 2 * HOUR, cron: null, timezone: null });
    expect(await scheduleRow(scheduleId)).toMatchObject({
      everyMs: 2 * HOUR,
      cron: null,
      moreCrons: [],
      timezone: null,
    });
    const moved = (await taskRow(card.id)).notBefore!.getTime();
    expect(moved).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(moved).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
  });

  it('keeps one expression without more, replacing the old list', async () => {
    const { scheduleId } = await scheduled({ ...crons });
    await ctx.ui.schedules.setRule({ id: scheduleId, cron: '0 8 * * *', timezone: 'Europe/Berlin' });
    expect(await scheduleRow(scheduleId)).toMatchObject({
      cron: '0 8 * * *',
      moreCrons: [],
      timezone: 'Europe/Berlin',
    });
  });

  it('leaves a pending card that started alone and changes only the schedule', async () => {
    const { card, scheduleId } = await scheduled();
    const before = await taskRow(card.id);
    await admin.update(tasks).set({ lastActiveAt: new Date() }).where(eq(tasks.id, card.id));
    const { pending } = await ctx.ui.schedules.setRule({ id: scheduleId, ...crons });
    expect(pending).toBe('started');
    expect((await taskRow(card.id)).notBefore).toEqual(before.notBefore);
    expect(await scheduleRow(scheduleId)).toMatchObject({ cron: crons.cron });
    expect(await cardsOf(scheduleId)).toHaveLength(1);
  });

  it('changes a paused schedule, which has no pending card, and resuming takes the new rule', async () => {
    const { scheduleId } = await scheduled();
    await ctx.ui.schedules.setPaused({ id: scheduleId, paused: true });
    const { pending } = await ctx.ui.schedules.setRule({ id: scheduleId, ...crons });
    expect(pending).toBe('none');
    const resumed = await ctx.ui.schedules.setPaused({ id: scheduleId, paused: false });
    expect(resumed.nextRunAt).not.toBeNull();
    expect(new Date(resumed.nextRunAt!).getUTCHours()).toBe(9);
  });

  it('refuses an ended schedule', async () => {
    const ended = await ctx.ui.tasks.create({ title: 'once', input: 'x', when: { every: HOUR, times: 1 } });
    await ctx.ui.tasks.move({ id: ended.id, status: 'backlog' });
    await expect(ctx.ui.schedules.setRule({ id: ended.scheduleId!, every: HOUR })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('refuses a schedule that runs after another, and one that does not exist', async () => {
    const { scheduleId } = await scheduled();
    const { scheduleId: followerId } = await scheduled();
    await admin
      .update(schedules)
      .set({ everyMs: null, afterScheduleId: scheduleId, afterDelayMs: 0, occurrenceTaskId: null })
      .where(eq(schedules.id, followerId));
    await expect(ctx.ui.schedules.setRule({ id: followerId, every: HOUR })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('after another'),
    });
    await expect(ctx.ui.schedules.setRule({ id: 'nothere1', every: HOUR })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses an invalid or repeated cron expression, an unknown time zone and a short interval, and changes nothing', async () => {
    const { scheduleId } = await scheduled();
    const before = await scheduleRow(scheduleId);
    const bad = [
      { cron: '0 9 * *', timezone: 'UTC' },
      { cron: '0 99 * * *', timezone: 'UTC' },
      { cron: '0 9 * * *', moreCrons: ['0  9 * * *'], timezone: 'UTC' },
      { cron: '0 9 * * *', timezone: 'Nowhere/City' },
      { every: 1000 },
    ];
    for (const rule of bad)
      await expect(ctx.ui.schedules.setRule({ id: scheduleId, ...rule }), JSON.stringify(rule)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    expect(await scheduleRow(scheduleId)).toEqual(before);
  });

  it(`takes at most ${MAX_SCHEDULE_CRONS} cron expressions`, async () => {
    const { scheduleId } = await scheduled();
    const expressions = Array.from({ length: MAX_SCHEDULE_CRONS + 1 }, (_, hour) => `0 ${hour} * * *`);
    await expect(
      ctx.ui.schedules.setRule({
        id: scheduleId,
        cron: expressions[0]!,
        moreCrons: expressions.slice(1),
        timezone: 'UTC',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const ten = expressions.slice(0, MAX_SCHEDULE_CRONS);
    const { schedule } = await ctx.ui.schedules.setRule({
      id: scheduleId,
      cron: ten[0]!,
      moreCrons: ten.slice(1),
      timezone: 'UTC',
    });
    expect(schedule.moreCrons).toHaveLength(MAX_SCHEDULE_CRONS - 1);
  });

  it('refuses a rule that never runs before the schedule ends, and changes nothing', async () => {
    const until = new Date(Date.now() + 3 * HOUR);
    const { card, scheduleId } = await scheduled({ every: HOUR, until });
    const before = await scheduleRow(scheduleId);
    const pendingBefore = await taskRow(card.id);
    await expect(
      ctx.ui.schedules.setRule({ id: scheduleId, cron: '0 0 29 2 *', timezone: 'UTC' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('would never run') });
    expect(await scheduleRow(scheduleId)).toEqual(before);
    expect(await taskRow(card.id)).toEqual(pendingBefore);
  });
});
