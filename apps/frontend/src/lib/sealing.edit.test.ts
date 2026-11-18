import { deriveKeys, openFields, sealFields, textBeforeEdit, type RowRef } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { sealerFor } from './contexts';
import { openerFor } from './opening';
import { InputError, sealEdit, sealScheduleUpdate, type EditTarget, type ScheduleUpdate } from './sealing';

const keys = await deriveKeys(
  Uint8Array.from({ length: 32 }, (_, i) => i),
  'alice',
  { index: true },
);

const target = (overrides: Partial<EditTarget> = {}): EditTarget => ({
  id: 'task0001',
  title: 'Old title',
  input: 'Old prompt',
  createdBy: 'user',
  scheduleId: null,
  agent: null,
  unreadable: [],
  ...overrides,
});

/** What the board does with the sealed fields: opens them for the row they are on. */
const opened = (row: RowRef, wire: { title: string; input: string; agent?: string }) =>
  openFields(openerFor(keys), row, wire);

describe('sealEdit', () => {
  it('seals the new title and prompt so that the task’s row opens them, and no other row does', async () => {
    const sealed = await sealEdit(keys, { target: target(), title: ' New title ', input: ' New prompt\n' });
    const row: RowRef = { kind: 'task', id: 'task0001', createdBy: 'user', scheduleId: null, forkOf: null };
    expect(await opened(row, sealed)).toMatchObject({ title: 'New title', input: 'New prompt', unreadable: [] });
    expect((await opened({ ...row, id: 'task0002' }, sealed)).unreadable).toEqual(['title', 'input']);
  });

  it('keeps the fork link of a fork: the edited prompt opens under it and under no other', async () => {
    const sealed = await sealEdit(keys, { target: target({ forkOf: 'parent01' }), title: 'a', input: 'b' });
    const row: RowRef = { kind: 'task', id: 'task0001', createdBy: 'user', scheduleId: null, forkOf: 'parent01' };
    expect((await opened(row, sealed)).unreadable).toEqual([]);
    expect((await opened({ ...row, forkOf: null }, sealed)).unreadable).toEqual(['input']);
    expect((await opened({ ...row, forkOf: 'parent02' }, sealed)).unreadable).toEqual(['input']);
  });

  it('seals the old text as a note of the user’s', async () => {
    const sealed = await sealEdit(keys, { target: target(), title: 'a', input: 'b' });
    expect(sealed.previous.body).toMatch(/^abe1\./);
    expect(textBeforeEdit(target())).toBe('Prompt before editing\n\nTitle: Old title\n\n```\nOld prompt\n```');
  });

  it('refuses a schedule’s occurrence, which a sealed edit could be replayed on as the schedule’s prompt', async () => {
    await expect(
      sealEdit(keys, { target: target({ scheduleId: 'sched001' }), title: 'a', input: 'b' }),
    ).rejects.toThrow(/Schedules page/);
  });

  it('binds the prompt to the agent the task runs as', async () => {
    const sealed = await sealEdit(keys, { target: target({ agent: 'reviewer' }), title: 'a', input: 'b' });
    const row: RowRef = { kind: 'task', id: 'task0001', createdBy: 'user', scheduleId: null, forkOf: null };
    const { agent } = await sealFields(sealerFor(keys), { ...row, agent: 'reviewer' }, { title: '', input: '' });
    expect(await opened(row, { ...sealed, agent })).toMatchObject({ input: 'b', agent: 'reviewer', unreadable: [] });
    expect((await opened(row, sealed)).unreadable).toEqual(['input']);
  });

  it('takes a title from the prompt when the title is blank, and refuses an empty prompt', async () => {
    const sealed = await sealEdit(keys, { target: target(), title: '  ', input: 'Fix the export' });
    const row: RowRef = { kind: 'task', id: 'task0001', createdBy: 'user', scheduleId: null, forkOf: null };
    expect((await opened(row, sealed)).title).toBe('Fix the export');
    await expect(sealEdit(keys, { target: target(), title: 't', input: '  ' })).rejects.toThrow(InputError);
  });

  it('refuses a task that is not the user’s or that cannot be read, since the old text could not be kept', async () => {
    await expect(sealEdit(keys, { target: target({ createdBy: 'agent' }), title: 'a', input: 'b' })).rejects.toThrow(
      InputError,
    );
    await expect(sealEdit(keys, { target: target({ unreadable: ['input'] }), title: 'a', input: 'b' })).rejects.toThrow(
      InputError,
    );
  });
});

describe('sealScheduleUpdate', () => {
  const update = (overrides: Partial<ScheduleUpdate> = {}): ScheduleUpdate => ({
    id: 'sched001',
    title: 'Nightly',
    input: 'sweep',
    agent: null,
    place: null,
    priority: 'normal',
    model: null,
    autoDone: false,
    repeat: { everyMs: 3_600_000 },
    runsLeft: null,
    until: null,
    maxConcurrent: null,
    unreadable: [],
    ...overrides,
  });

  it('seals the title, prompt, directory and agent under the schedule, and passes the clear fields on', async () => {
    const sealed = await sealScheduleUpdate(
      keys,
      update({ agent: ' auditor ', place: { machine: 'laptop', workdir: '/work' }, priority: 'high', runsLeft: 3 }),
    );
    expect(sealed).toMatchObject({
      id: 'sched001',
      priority: 'high',
      runsLeft: 3,
      repeat: { everyMs: 3_600_000 },
      place: { machine: 'laptop' },
    });
    expect(sealed).not.toHaveProperty('unreadable');
    expect(
      await openFields(
        openerFor(keys),
        { kind: 'schedule', id: 'sched001' },
        { ...sealed, workdir: sealed.place?.workdir },
      ),
    ).toMatchObject({ title: 'Nightly', input: 'sweep', agent: 'auditor', workdir: '/work', unreadable: [] });
    expect((await opened({ kind: 'schedule', id: 'sched002' }, sealed)).unreadable).toContain('title');
  });

  it('seals again under a new agent, which the old one does not open', async () => {
    const withAgent = await sealScheduleUpdate(keys, update({ agent: 'auditor' }));
    const without = await sealScheduleUpdate(keys, update());
    expect(without).not.toHaveProperty('agent');
    expect(without.input).not.toBe(withAgent.input);
  });

  it('leaves no directory sealed for none', async () => {
    expect((await sealScheduleUpdate(keys, update())).place).toBeNull();
  });

  it('refuses an empty prompt, a bad agent name and a schedule that cannot be read', async () => {
    await expect(sealScheduleUpdate(keys, update({ input: ' ' }))).rejects.toThrow(InputError);
    await expect(sealScheduleUpdate(keys, update({ agent: 'not an agent!' }))).rejects.toThrow(InputError);
    await expect(sealScheduleUpdate(keys, update({ unreadable: ['input'] }))).rejects.toThrow(InputError);
  });
});
