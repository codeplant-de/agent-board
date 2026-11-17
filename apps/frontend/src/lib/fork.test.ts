import { deriveKeys, open } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { canFork, forkProblem, InputError, sealFork, type ForkSource } from './sealing';

const keys = await deriveKeys(
  Uint8Array.from({ length: 32 }, (_, i) => i),
  'alice',
  { index: true },
);

const parent: ForkSource = {
  id: 'parent01',
  status: 'needs-me',
  closed: false,
  createdBy: 'user',
  machine: 'laptop',
  sessionId: '11111111-1111-4111-8111-111111111111',
  workdir: '/work/app',
  agent: null,
  unreadable: [],
};

describe('sealFork', () => {
  it('seals the instructions for the new task and its fork link, and the directory and title for the new task', async () => {
    const sealed = await sealFork(keys, { parent, title: ' Flaky test ', input: ' look into it ' });
    expect(sealed.parentId).toBe('parent01');
    expect(sealed.id).not.toBe('parent01');
    expect(await open(keys, 'title', `task:${sealed.id}`, sealed.title)).toBe('Flaky test');
    expect(await open(keys, 'input', `task:${sealed.id}:user:fork:parent01`, sealed.input)).toBe('look into it');
    expect(await open(keys, 'workdir', `task:${sealed.id}`, sealed.workdir)).toBe('/work/app');
    expect(sealed).not.toHaveProperty('agent');
  });

  it('does not open as a task that is no fork, or as a fork of another task', async () => {
    const sealed = await sealFork(keys, { parent, title: 't', input: 'go' });
    await expect(open(keys, 'input', `task:${sealed.id}:user`, sealed.input)).rejects.toThrow();
    await expect(open(keys, 'input', `task:${sealed.id}:user:fork:other01`, sealed.input)).rejects.toThrow();
  });

  it('keeps the agent of the parent: sealed for the new task, and part of the context of the prompt after the link', async () => {
    const sealed = await sealFork(keys, { parent: { ...parent, agent: 'reviewer' }, title: 't', input: 'go' });
    expect(await open(keys, 'agent', `task:${sealed.id}`, sealed.agent ?? '')).toBe('reviewer');
    expect(await open(keys, 'input', `task:${sealed.id}:user:fork:parent01:agent:reviewer`, sealed.input)).toBe('go');
  });

  it('takes a title from the instructions when it is empty, and needs instructions', async () => {
    const sealed = await sealFork(keys, { parent, title: ' ', input: 'look into it\nmore' });
    expect(await open(keys, 'title', `task:${sealed.id}`, sealed.title)).toBe('look into it');
    await expect(sealFork(keys, { parent, title: 't', input: '  ' })).rejects.toThrow(InputError);
  });

  it('refuses what cannot be forked', async () => {
    for (const bad of [
      { createdBy: 'agent' as const },
      { createdBy: 'intake' as const, agent: null },
      { closed: true },
      { sessionId: null },
      { machine: null },
      { workdir: null },
      { unreadable: ['agent' as const] },
      { unreadable: ['workdir' as const] },
    ])
      await expect(sealFork(keys, { parent: { ...parent, ...bad }, title: 't', input: 'go' })).rejects.toThrow(
        InputError,
      );
  });
});

describe('canFork', () => {
  it('is a task with a session on a machine that is open and not an agent’s proposal', () => {
    expect(canFork(parent)).toBe(true);
    expect(forkProblem({ ...parent, workdir: null })).toMatch(/directory or agent/);
    for (const bad of [
      { sessionId: null },
      { machine: null },
      { closed: true },
      { createdBy: 'agent' as const },
      { createdBy: 'intake' as const },
    ])
      expect(canFork({ ...parent, ...bad })).toBe(false);
    expect(canFork({ ...parent, createdBy: 'intake', agent: 'reviewer' })).toBe(true);
    expect(forkProblem(parent)).toBeUndefined();
  });
});
