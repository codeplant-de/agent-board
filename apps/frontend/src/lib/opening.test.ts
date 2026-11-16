import { deriveKeys, machineDirsBinding, prBinding, seal, sealPr } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { openBoardTask, openMachines } from './opening';
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

describe('the directory lists of machines, as the browser opens them', () => {
  const sealFor = (machine: string, text: string) => sealerFor(keys)(machineDirsBinding(machine), text);
  const list = (paths: string[]) => JSON.stringify({ dirs: paths.map((path) => ({ path })) });
  const wire = (name: string, dirs: string | null, revokedAt: Date | null = null) =>
    ({ name, dirs, revokedAt, lastSeenAt: null }) as unknown as RouterOutputs['machines']['list'][number];
  const openOne = async (...machines: RouterOutputs['machines']['list']) => (await openMachines(keys, machines))[0];

  it('opens a good list under the machine own name', async () => {
    const machine = await openOne(wire('laptop', await sealFor('laptop', list(['/a', '/b c']))));
    expect(machine).toMatchObject({ shown: 'laptop', dirs: ['/a', '/b c'], dirsUnreadable: false });
  });

  it('has no list when the machine sent none', async () => {
    expect(await openOne(wire('laptop', null))).toMatchObject({ dirs: null, dirsUnreadable: false });
  });

  it('is unreadable when it was sealed for another machine name', async () => {
    const machine = await openOne(wire('laptop', await sealFor('desktop', list(['/a']))));
    expect(machine).toMatchObject({ dirs: null, dirsUnreadable: true });
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object with dirs', JSON.stringify(['/a'])],
    ['an entry without a path', JSON.stringify({ dirs: [{}] })],
    ['a relative path', list(['relative'])],
    ['a path with a control character', list(['/a\nb'])],
  ])('is unreadable when the list is %s', async (_, text) => {
    expect(await openOne(wire('laptop', await sealFor('laptop', text)))).toMatchObject({
      dirs: null,
      dirsUnreadable: true,
    });
  });

  it('is unreadable when it is not an envelope', async () => {
    expect(await openOne(wire('laptop', list(['/a'])))).toMatchObject({ dirs: null, dirsUnreadable: true });
  });

  it('offers nothing for a revoked machine', async () => {
    const sealed = await sealFor('laptop', list(['/a']));
    expect(await openOne(wire('laptop', sealed, new Date()))).toMatchObject({ dirs: null, dirsUnreadable: false });
  });

  it('offers nothing for a machine whose name does not pass the shape check', async () => {
    const name = 'bad name\n';
    const machine = await openOne(wire(name, await sealFor(name, list(['/a']))));
    expect(machine).toMatchObject({ shown: '(invalid)', name, dirs: null, dirsUnreadable: false });
  });
});
