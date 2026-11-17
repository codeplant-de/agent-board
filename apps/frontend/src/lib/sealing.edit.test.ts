import { deriveKeys, openFields, sealFields, type RowRef } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { sealerFor } from './contexts';
import { openerFor } from './opening';
import { InputError, sealEdit, sealScheduleEdit, textBeforeEdit, type EditTarget } from './sealing';

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

describe('sealScheduleEdit', () => {
  it('seals the new title and prompt under the schedule', async () => {
    const sealed = await sealScheduleEdit(keys, {
      schedule: { id: 'sched001', agent: null, unreadable: [] },
      title: 'Nightly',
      input: 'sweep',
    });
    expect(await opened({ kind: 'schedule', id: 'sched001' }, sealed)).toMatchObject({
      title: 'Nightly',
      input: 'sweep',
      unreadable: [],
    });
    expect((await opened({ kind: 'schedule', id: 'sched002' }, sealed)).unreadable).toEqual(['title', 'input']);
  });

  it('refuses an empty prompt and a schedule that cannot be read', async () => {
    const schedule = { id: 'sched001', agent: null, unreadable: [] };
    await expect(sealScheduleEdit(keys, { schedule, title: 't', input: '' })).rejects.toThrow(InputError);
    await expect(
      sealScheduleEdit(keys, { schedule: { ...schedule, unreadable: ['input'] }, title: 't', input: 'x' }),
    ).rejects.toThrow(InputError);
  });
});
