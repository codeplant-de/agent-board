import { deriveKeys, prBinding, seal, sealPr } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { openBoardTask } from './opening';
import { sealerFor } from './contexts';
import type { RouterOutputs } from './wire';

const keys = await deriveKeys(
  Uint8Array.from({ length: 32 }, (_, i) => i),
  'alice',
  { index: true },
);
const PR_URL = 'https://github.com/acme/app/pull/17';

const wireTask = async (pr: string | null): Promise<RouterOutputs['tasks']['get']['task']> => {
  const sealer = sealerFor(keys);
  return {
    id: 'task0001',
    title: await sealer({ field: 'title', context: 'task:task0001' }, 'A task'),
    input: await sealer({ field: 'input', context: 'task:task0001:user' }, 'Fix the bug'),
    workdir: null,
    pr,
    status: 'needs-me',
    priority: 'normal',
    createdBy: 'user',
    closed: false,
    openQuestion: false,
    machine: null,
    lane: null,
    sessionId: null,
    next: 'fresh',
    head: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    parentId: null,
    proposed: false,
    paused: false,
    notBefore: null,
    lastActiveAt: null,
    runStartedAt: null,
    borrowed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as RouterOutputs['tasks']['get']['task'];
};

describe('the PR of a task, as the browser opens it', () => {
  it('is the PR the agent of the task sealed', async () => {
    const task = await openBoardTask(keys, await wireTask(await sealPr(sealerFor(keys), 'task0001', PR_URL)));
    expect(task.pr).toBe(PR_URL);
  });

  it('is none when the board has none', async () => {
    expect((await openBoardTask(keys, await wireTask(null))).pr).toBeNull();
  });

  it('is ignored when it was sealed for another task, another purpose, or is not a PR URL, or is not sealed', async () => {
    const sealer = sealerFor(keys);
    for (const value of [
      await sealPr(sealer, 'other001', PR_URL),
      await seal(keys, 'pr', 'task:task0001:user', PR_URL),
      await seal(keys, 'input', 'task:task0001:user', PR_URL),
      await seal(keys, 'pr', prBinding('task0001').context, 'https://example.com/x'),
      await seal(keys, 'pr', prBinding('task0001').context, 'javascript:alert(1)'),
      PR_URL,
    ])
      expect((await openBoardTask(keys, await wireTask(value))).pr).toBeNull();
  });
});
