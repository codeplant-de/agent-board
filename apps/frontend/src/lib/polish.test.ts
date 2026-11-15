import { deriveKeys, open } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { canPolish, isOpenPolishOf, polishTask } from './polish';
import { InputError, previousText, sealApply, type PolishTarget } from './sealing';
import type { BoardTask } from './trpc';

const keys = await deriveKeys(
  Uint8Array.from({ length: 32 }, (_, i) => i),
  'alice',
  { index: true },
);

const target: PolishTarget = {
  id: 'target01',
  title: 'rough idea',
  input: 'fix thing?? maybe export',
  createdBy: 'user',
  unreadable: [],
};

describe('polishTask', () => {
  it('is a child of the task, with its priority, and a title cut to a sensible length', () => {
    const long = 'x'.repeat(200);
    const polish = polishTask({ id: 'target01', title: long, priority: 'low' });
    expect(polish).toMatchObject({ parentId: 'target01', priority: 'low' });
    expect(Array.from(polish.title ?? '')).toHaveLength('Polish prompt: '.length + 80);
    expect(polish.title?.endsWith('…')).toBe(true);
    expect(polishTask({ id: 'a', title: 'short', priority: 'normal' }).title).toBe('Polish prompt: short');
  });
});

describe('canPolish and isOpenPolishOf', () => {
  const backlog: Parameters<typeof canPolish>[0] = {
    status: 'backlog',
    closed: false,
    createdBy: 'user',
    scheduleId: null,
    unreadable: [],
  };

  it('polishes only a readable Backlog task of the user’s that is not an occurrence', () => {
    expect(canPolish(backlog)).toBe(true);
    for (const change of [
      { status: 'todo' },
      { closed: true },
      { createdBy: 'agent' },
      { scheduleId: 's' },
    ] satisfies Partial<typeof backlog>[])
      expect(canPolish({ ...backlog, ...change })).toBe(false);
    expect(canPolish({ ...backlog, unreadable: ['title'] })).toBe(false);
  });

  it('counts a polish task as open until it is done or closed', () => {
    const child = {
      title: 'Polish prompt: x',
      createdBy: 'user',
      status: 'needs-me',
      closed: false,
      parentId: 'p',
    } satisfies Pick<BoardTask, 'title' | 'createdBy' | 'status' | 'closed' | 'parentId'>;
    expect(isOpenPolishOf(child, 'p')).toBe(true);
    expect(isOpenPolishOf(child, 'other')).toBe(false);
    expect(isOpenPolishOf({ ...child, status: 'done' }, 'p')).toBe(false);
    expect(isOpenPolishOf({ ...child, closed: true }, 'p')).toBe(false);
    expect(isOpenPolishOf({ ...child, title: 'something else' }, 'p')).toBe(false);
  });
});

describe('sealApply', () => {
  it('seals the new title and prompt as the task’s own and the user’s, and the old text as the user’s comment', async () => {
    const sealed = await sealApply(keys, {
      polishId: 'polish01',
      target,
      rewrite: { title: 'Speed up the export', prompt: 'Find out why it is slow.' },
    });
    expect(sealed).toMatchObject({ id: 'target01', polishId: 'polish01' });
    expect(await open(keys, 'title', 'task:target01', sealed.title)).toBe('Speed up the export');
    expect(await open(keys, 'input', 'task:target01:user', sealed.input)).toBe('Find out why it is slow.');
    const kept = await open(keys, 'note.body', 'note:target01:user:event', sealed.previous.body);
    expect(kept).toBe(previousText(target));
    expect(kept).toContain('rough idea');
    expect(kept).toContain('fix thing?? maybe export');
    expect(await open(keys, 'input', 'task:target01:agent', sealed.input).catch(() => undefined)).toBeUndefined();
  });

  it('refuses a task that is not the user’s or cannot be read, since the old text could not be kept', async () => {
    const rewrite = { title: 't', prompt: 'p' };
    await expect(
      sealApply(keys, { polishId: 'p', target: { ...target, createdBy: 'agent' }, rewrite }),
    ).rejects.toThrow(InputError);
    await expect(
      sealApply(keys, { polishId: 'p', target: { ...target, unreadable: ['input'] }, rewrite }),
    ).rejects.toThrow(InputError);
  });

  it('keeps a prompt that holds code fences inside a longer fence', () => {
    const text = previousText({ title: 't', input: 'before\n```\ncode\n```\nafter' });
    expect(text).toContain('````\nbefore\n```\ncode\n```\nafter\n````');
  });
});
