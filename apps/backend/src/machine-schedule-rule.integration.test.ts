import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { schedules, tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
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
  return { raw, call: plainMachine(raw), ui: plainUi(db) };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

async function scheduled(when: Record<string, unknown> = { every: HOUR }) {
  const card = await ctx.ui.tasks.create({ title: 'Sweep', input: 'x', when: when as { every: number } });
  return { card, scheduleId: card.scheduleId! };
}
const setRule = (id: string, body: Record<string, unknown>) => ctx.raw('set-schedule-rule', { id, body });
const taskRow = async (id: string) => (await admin.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const scheduleRow = async (id: string) => (await admin.select().from(schedules).where(eq(schedules.id, id)))[0]!;

describe('set-schedule-rule', () => {
  it('announces the feature', async () => {
    const { json } = await ctx.raw('version');
    expect(json.result.features).toContain('schedule.rule-edit');
  });

  it('turns an interval into cron expressions and moves the pending card to the next match', async () => {
    const { card, scheduleId } = await scheduled();
    const { status, json } = await setRule(scheduleId, crons);
    expect(status).toBe(200);
    expect(json.result.pending).toBe('updated');
    expect(json.result.schedule).toMatchObject({ id: scheduleId, everyMs: null, ...crons });
    const moved = (await taskRow(card.id)).notBefore!;
    expect(moved.getTime()).toBeGreaterThan(Date.now());
    expect(moved.getUTCHours()).toBe(9);
    expect(await scheduleRow(scheduleId)).toMatchObject({ cron: crons.cron, moreCrons: crons.moreCrons });
  });

  it('turns cron expressions into an interval and moves the pending card', async () => {
    const { card, scheduleId } = await scheduled({ ...crons });
    const { status, json } = await setRule(scheduleId, { everyMs: 2 * HOUR });
    expect(status).toBe(200);
    expect(json.result.pending).toBe('updated');
    expect(json.result.schedule).toMatchObject({ everyMs: 2 * HOUR, cron: null, timezone: null });
    expect((await taskRow(card.id)).notBefore!.getTime()).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
  });

  it('leaves a pending card that started alone and says so', async () => {
    const { card, scheduleId } = await scheduled();
    const before = await taskRow(card.id);
    await admin.update(tasks).set({ lastActiveAt: new Date() }).where(eq(tasks.id, card.id));
    const { json } = await setRule(scheduleId, { everyMs: 2 * HOUR });
    expect(json.result.pending).toBe('started');
    expect((await taskRow(card.id)).notBefore).toEqual(before.notBefore);
  });

  it('says there is no pending card for a paused schedule', async () => {
    const { scheduleId } = await scheduled();
    await ctx.ui.schedules.setPaused({ id: scheduleId, paused: true });
    expect((await setRule(scheduleId, { everyMs: 2 * HOUR })).json.result.pending).toBe('none');
  });

  it('refuses an ended schedule with 409', async () => {
    const ended = await ctx.ui.tasks.create({ title: 'once', input: 'x', when: { every: HOUR, times: 1 } });
    await ctx.ui.tasks.move({ id: ended.id, status: 'backlog' });
    expect((await setRule(ended.scheduleId!, { everyMs: HOUR })).status).toBe(409);
  });

  it('refuses a schedule that runs after another with 400, and an unknown one with 404', async () => {
    const { scheduleId } = await scheduled();
    const { scheduleId: followerId } = await scheduled();
    await admin
      .update(schedules)
      .set({ everyMs: null, afterScheduleId: scheduleId, afterDelayMs: 0, occurrenceTaskId: null })
      .where(eq(schedules.id, followerId));
    expect((await setRule(followerId, { everyMs: HOUR })).status).toBe(400);
    expect((await setRule('nothere1', { everyMs: HOUR })).status).toBe(404);
  });

  it('refuses a body that is not exactly one rule', async () => {
    const { scheduleId } = await scheduled();
    const bad = [
      {},
      { everyMs: HOUR, cron: '0 9 * * *', timezone: 'UTC' },
      { everyMs: 0 },
      { everyMs: HOUR, timezone: 'UTC' },
      { everyMs: HOUR, moreCrons: ['0 8 * * *'] },
      { cron: '0 9 * * *' },
      { cron: '0 9 * * *', timezone: '' },
      { cron: '0 9 * * *', timezone: 'UTC', moreCrons: 'x' },
      { cron: '0 9 * * *', timezone: 'UTC', moreCrons: Array.from({ length: 10 }, () => '0 8 * * *') },
      { everyMs: HOUR, title: 'x' },
    ];
    for (const body of bad) expect((await setRule(scheduleId, body)).status, JSON.stringify(body)).toBe(400);
    expect((await setRule(scheduleId, { cron: 'not a cron', timezone: 'UTC' })).status).toBe(400);
    expect(await scheduleRow(scheduleId)).toMatchObject({ everyMs: HOUR, cron: null });
  });
});
