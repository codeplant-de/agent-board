import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDispatch } from '../src/dispatch.mts';
import type { DispatchDeps } from '../src/dispatch.mts';
import { SystemError } from '../src/system.mts';
import type { System } from '../src/system.mts';
import { START_MARKER } from '../src/decide.mts';
import { CONFIG, fakeBackend, fakeRunFiles, fakeWaitStore, task } from './helpers.mts';
import type { CheckResult, WaitCheck } from '../src/waits.mts';
import type { FakeBackend } from './helpers.mts';

const NOW = new Date('2026-01-01T12:00:00Z');

function setup(
  tasks: ReturnType<typeof task>[],
  active: string[] = [],
  unitStarts: Record<string, Date> = {},
  {
    checks = {},
    checkResult,
  }: { checks?: Record<string, WaitCheck>; checkResult?: (check: WaitCheck) => CheckResult } = {},
) {
  const backend: FakeBackend = fakeBackend(tasks);
  const waits = fakeWaitStore(checks);
  const ranChecks: string[] = [];
  const files = fakeRunFiles(() => NOW);
  const started: string[] = [];
  const stopped: string[] = [];
  const logs: string[] = [];
  const system: System = {
    async isActive(unit) {
      return active.includes(unit);
    },
    async startedAt(unit) {
      return unitStarts[unit];
    },
    async activeWorkers() {
      return active.map((unit) => unit.replace('agent-board-', ''));
    },
    async stop(unit) {
      stopped.push(unit);
    },
    async startWorker(shortLink) {
      started.push(shortLink);
      return { pid: 42 };
    },
  };
  const deps: DispatchDeps = {
    backend,
    config: CONFIG,
    dryRun: false,
    print: (line) => logs.push(line),
    system,
    files,
    now: () => NOW,
    logTail: () => 'last log line',
    notify: async () => undefined,
    waits,
    runCheck: async (check) => {
      ranChecks.push(check.command);
      return checkResult?.(check) ?? { exitCode: 1, timedOut: false, output: 'pending' };
    },
  };
  return { backend, deps, started, stopped, logs, files, waits, ranChecks };
}

const running = (id: string) => task({ id, status: 'running', input: '/selftest go' });
const todo = (id: string) => task({ id, input: '/selftest go' });

test('starts from the top of Todo up to the cap', async () => {
  const { deps, started, backend } = setup([running('r1'), todo('t1'), todo('t2'), todo('t3')], ['agent-board-r1']);
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(backend.writes.includes('claim t1 by here'));
  assert.ok(
    backend.writes.some((w) => w.startsWith('note t1 (system)') && w.includes(START_MARKER) && w.includes('pid 42')),
  );
});

test('with all slots taken nothing starts', async () => {
  const { deps, started } = setup([running('r1'), running('r2'), todo('t1')], ['agent-board-r1', 'agent-board-r2']);
  await runDispatch(deps);
  assert.deepEqual(started, []);
});

test('a task this machine cannot serve is left in Todo for another machine', async () => {
  const odd = task({ id: 'odd', input: '/review-pr https://github.com/other/repo/pull/2 --auto', createdBy: 'intake' });
  const pinned = task({ id: 'pinned', input: '/selftest go', next: 'resume', sessionId: 's', machine: 'there' });
  const elsewhere = task({ id: 'elsewhere', input: 'Find out X', machine: 'there', workdir: '/x' });
  const { deps, started, backend, logs } = setup([odd, pinned, elsewhere, todo('t1')]);
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(!backend.writes.some((w) => w.includes('odd') || w.includes('pinned') || w.includes('elsewhere')));
  assert.ok(logs.some((line) => line.startsWith('SKIP odd no checkout of other/repo')));
  assert.ok(logs.some((line) => line.startsWith('SKIP pinned pinned to there')));
  assert.ok(logs.some((line) => line.startsWith('SKIP elsewhere pinned to there')));
});

test('a claim lost to another machine starts nothing and the next task gets the slot', async () => {
  const { deps, started, backend } = setup([todo('t1'), todo('t2'), todo('t3')]);
  backend.lostClaims.push('t1');
  await runDispatch(deps);
  assert.deepEqual(started, ['t2', 't3']);
});

test("another machine's running task is not swept here", async () => {
  const theirs = task({ id: 'theirs', status: 'running', input: '/selftest go', machine: 'there' });
  const { deps, backend } = setup([theirs]);
  await runDispatch(deps);
  assert.deepEqual(backend.writes, []);
});

test('a stale Running task goes to Needs me with the log tail and frees its slot', async () => {
  const { deps, started, backend } = setup([running('dead'), todo('t1')]);
  await runDispatch(deps);
  assert.ok(backend.writes.some((w) => w.startsWith('fail dead:') && w.includes('last log line')));
  assert.ok(backend.writes.some((w) => w.startsWith('fail dead:')));
  assert.deepEqual(started, ['t1']);
});

test('a timed-out active worker is stopped, then reported', async () => {
  const slow = task({
    id: 'slow',
    status: 'running',
    input: '/selftest go',
    runStartedAt: new Date(NOW.getTime() - 7 * 60 * 60_000),
  });
  const { deps, backend, stopped } = setup([slow], ['agent-board-slow']);
  await runDispatch(deps);
  assert.deepEqual(stopped, ['agent-board-slow']);
  assert.ok(backend.writes.some((w) => w.startsWith('fail slow:')));
});

test('a failed start sends the task to Needs me and stops filling slots', async () => {
  const { deps, backend } = setup([todo('t1'), todo('t2')]);
  let calls = 0;
  deps.system = {
    ...deps.system,
    async startWorker() {
      calls++;
      if (calls === 1) throw new Error('unit exists');
      return { pid: undefined };
    },
  };
  await runDispatch(deps);
  assert.equal(calls, 1, 'no further task is started after a failure');
  assert.ok(backend.writes.some((w) => w.includes('could not be started: unit exists')));
});

test('a failed start comment does not send the running task to Needs me', async () => {
  const { deps, backend, started } = setup([todo('t1')]);
  const addNote = backend.addNote.bind(backend);
  backend.addNote = async (id, text) => {
    if (text.startsWith(START_MARKER)) throw new Error('backend down');
    return addNote(id, text);
  };
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(!backend.writes.some((w) => w.includes('needs-me')));
});

test('unknown systemd state starts nothing and changes nothing', async () => {
  const { deps, backend, started } = setup([running('r1'), todo('t1')]);
  deps.system = {
    ...deps.system,
    async isActive() {
      throw new SystemError('bus unreachable');
    },
  };
  await assert.rejects(runDispatch(deps), SystemError);
  assert.deepEqual(started, []);
  assert.deepEqual(backend.writes, []);
});

test("the run is timed from its unit first, and from the task's claim without one", async () => {
  const again = task({
    id: 'again',
    status: 'running',
    input: '/selftest go',
    runStartedAt: new Date(NOW.getTime() - 7 * 60 * 60_000),
  });
  const { deps, backend, stopped } = setup([again], ['agent-board-again'], {
    'agent-board-again': new Date(NOW.getTime() - 5 * 60_000),
  });
  await runDispatch(deps);
  assert.deepEqual(stopped, []);
  assert.deepEqual(backend.writes, []);
});

test('the cap counts active units even when fewer tasks sit in Running', async () => {
  const { deps, started } = setup([running('r1'), todo('t1')], ['agent-board-r1', 'agent-board-orphan']);
  await runDispatch(deps);
  assert.deepEqual(started, []);
});

test('a failed listing starts nothing and changes nothing', async () => {
  const { deps, backend, started } = setup([running('r1'), todo('t1')]);
  backend.listTasks = async () => {
    throw new Error('backend list-tasks failed');
  };
  await assert.rejects(runDispatch(deps), /list-tasks failed/);
  assert.deepEqual(started, []);
  assert.deepEqual(backend.writes, []);
});

const LANED = {
  ...CONFIG,
  lanes: [
    { name: 'reviews', skills: ['selftest'], slots: 1 },
    { name: 'implement', skills: ['implement'], slots: 1 },
  ],
};
const review = (id: string) => task({ id, input: '/selftest go' });
const impl = (id: string) => task({ id, input: '/implement it' });

test('each lane takes its own work, an idle lane borrows, and the lane is written before the unit starts', async () => {
  const { deps, started, files, logs, backend } = setup([review('r1'), review('r2'), review('r3')]);
  deps.config = LANED;
  await runDispatch(deps);
  assert.deepEqual(started, ['r1', 'r2']);
  assert.deepEqual(files.runs.get('r1'), { lane: 'reviews', borrowed: false, startedAt: NOW });
  assert.deepEqual(files.runs.get('r2'), { lane: 'implement', borrowed: true, startedAt: NOW });
  assert.ok(logs.includes('TICK started=2 reviews=1/1 implement=1/1'));
  assert.ok(backend.writes.some((w) => w.startsWith('note r2 (system)') && w.includes('implement lane, borrowed')));
});

test('a lane whose own work waits asks its borrowed run to pause, once, after five minutes', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files, logs } = setup([borrowed, review('r0'), impl('i1')], ['agent-board-b1', 'agent-board-r0x']);
  deps.config = LANED;
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: new Date(NOW.getTime() - 6 * 60_000) });
  files.runs.set('r0x', { lane: 'reviews', borrowed: false, startedAt: NOW });
  files.alive.set('b1', NOW);
  await runDispatch(deps);
  assert.ok(files.pauses.has('b1'));
  assert.ok(logs.some((line) => line.startsWith('PAUSE b1 lane=implement')));
  logs.length = 0;
  await runDispatch(deps);
  assert.ok(!logs.some((line) => line.startsWith('PAUSE')), 'a pending pause is not asked again');
});

test('a young borrowed run is not paused yet', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files } = setup([borrowed, impl('i1')], ['agent-board-b1']);
  deps.config = { ...LANED, lanes: [{ name: 'implement', skills: ['implement'], slots: 1 }] };
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: new Date(NOW.getTime() - 2 * 60_000) });
  files.alive.set('b1', NOW);
  await runDispatch(deps);
  assert.equal(files.pauses.size, 0);
});

test('dry run plans pauses and starts but writes no run files', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files, logs } = setup([borrowed, impl('i1'), review('r1')], ['agent-board-b1']);
  deps.config = LANED;
  deps.dryRun = true;
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: new Date(NOW.getTime() - 10 * 60_000) });
  files.alive.set('b1', NOW);
  await runDispatch(deps);
  assert.ok(logs.some((line) => line.startsWith('PAUSE b1')));
  assert.equal(files.pauses.size, 0);
  assert.ok(!files.runs.has('r1'));
});

test('a running task whose agent went quiet is stopped and reported by the sweep', async () => {
  const quiet = task({ id: 'q', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files, stopped, backend } = setup([quiet], ['agent-board-q'], {
    'agent-board-q': new Date(NOW.getTime() - 60 * 60_000),
  });
  files.alive.set('q', new Date(NOW.getTime() - 25 * 60_000));
  await runDispatch(deps);
  assert.deepEqual(stopped, ['agent-board-q']);
  assert.ok(backend.writes.some((w) => w.includes('no tool call for 25 minutes')));
});

test('a todo task whose last worker is still stopping is not started again', async () => {
  const { deps, started, backend, logs } = setup([todo('t1'), todo('t2')], ['agent-board-t1']);
  await runDispatch(deps);
  assert.deepEqual(started, ['t2']);
  assert.ok(logs.includes('SKIP t1 its last worker is still stopping'));
  assert.ok(!backend.writes.some((w) => w.includes('t1')));
});

test('a task that moved on since the listing is not reported or notified', async () => {
  const notified: string[] = [];
  const { deps, backend } = setup([running('dead')]);
  deps.notify = async (_task, text) => void notified.push(text);
  const list = backend.listTasks.bind(backend);
  backend.listTasks = async (options) => {
    const listed = await list(options);
    backend.tasks[0]!.status = 'needs-me';
    return listed;
  };
  await runDispatch(deps);
  assert.deepEqual(notified, []);
});

test('a task that is not due yet is left alone: no claim, no log line', async () => {
  const waiting = task({ id: 'w1', input: '/selftest go', notBefore: new Date(NOW.getTime() + 60_000) });
  const due = task({ id: 'd1', input: '/selftest go', notBefore: new Date(NOW.getTime() - 60_000) });
  const waitingThere = task({
    id: 'w2',
    input: '/selftest go',
    machine: 'there',
    workdir: '/x',
    notBefore: new Date(NOW.getTime() + 60_000),
  });
  const { deps, started, backend, logs } = setup([waiting, waitingThere, due, todo('t1')]);
  await runDispatch(deps);
  assert.deepEqual(started, ['d1', 't1']);
  assert.ok(!backend.writes.some((w) => w.includes('w1')));
  assert.ok(!logs.some((line) => line.includes('w1') || line.includes('w2')));
});

test('a task whose prompt or directory cannot be decrypted is never claimed or started; an unreadable title alone is fine', async () => {
  const { deps, started, backend, logs } = setup([
    task({ id: 'u1', input: '', unreadable: ['input'] }),
    task({ id: 'u2', input: '/selftest go', unreadable: ['workdir'] }),
    task({ id: 'u3', input: '/selftest go', unreadable: ['title'] }),
  ]);
  await runDispatch(deps);
  assert.deepEqual(started, ['u3']);
  assert.ok(!backend.writes.some((w) => w.startsWith('claim u1') || w.startsWith('claim u2')));
  assert.ok(logs.includes('SKIP u1 cannot decrypt its input'));
  assert.ok(logs.includes('SKIP u2 cannot decrypt its workdir'));
});

test('a task that still names an agent as its creator is never started, whatever status the board shows (unstarted proposal)', async () => {
  const proposal = task({ id: 'prop', input: 'rm -rf the world', createdBy: 'agent' });
  const { deps, started, backend, logs } = setup([proposal, todo('t1')]);
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(!backend.writes.some((w) => w.includes('claim prop')));
  assert.ok(logs.some((line) => line.startsWith('SKIP prop proposed by an agent')));
});

const MIN = 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const waitingTask = (id: string, overrides: Partial<ReturnType<typeof task>> = {}) =>
  task({
    id,
    status: 'waiting',
    machine: 'here',
    sessionId: '11111111-2222-3333-4444-555555555555',
    input: '/selftest go',
    ...overrides,
  });
const check = (overrides: Partial<WaitCheck> = {}): WaitCheck => ({
  command: 'gh pr checks 1',
  cwd: '/work/cosuno',
  everyMs: 2 * MIN,
  createdAt: at(-10 * MIN),
  ...overrides,
});

test('a timer whose time is up wakes the task, which starts in the same tick', async () => {
  const { deps, backend, started } = setup([waitingTask('w1', { wakeAt: at(-MIN) })]);
  await runDispatch(deps);
  assert.ok(backend.writes.some((w) => w.startsWith('wake w1: agent-board: wait over: its time ran out.')));
  assert.deepEqual(started, ['w1']);
});

test('a timer that still runs, or a wait on another machine, is left alone', async () => {
  const { deps, backend, ranChecks } = setup([
    waitingTask('w1', { wakeAt: at(MIN) }),
    waitingTask('w2', { wakeAt: at(-MIN), machine: 'other' }),
  ]);
  await runDispatch(deps);
  assert.equal(backend.writes.filter((w) => w.startsWith('wake')).length, 0);
  assert.deepEqual(ranChecks, []);
});

test('a due check that passes wakes the task with the end of its output', async () => {
  const { deps, backend, waits, ranChecks } = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check() }, checkResult: () => ({ exitCode: 0, timedOut: false, output: 'all green\n' }) },
  );
  await runDispatch(deps);
  assert.deepEqual(ranChecks, ['gh pr checks 1']);
  const wake = backend.writes.find((w) => w.startsWith('wake w1:'));
  assert.ok(wake?.includes('its check passed.') && wake.includes('all green'), wake);
  assert.equal(waits.read('w1'), undefined);
});

test('a check that fails is kept with its result, and not run again before --every', async () => {
  const first = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check() } },
  );
  await runDispatch(first.deps);
  const kept = first.waits.read('w1');
  assert.equal(kept?.lastExit, 1);
  assert.equal(kept?.lastOutput, 'pending');
  assert.equal(kept?.lastCheckAt?.getTime(), NOW.getTime());
  assert.equal(first.backend.writes.filter((w) => w.startsWith('wake')).length, 0);

  const second = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check({ lastCheckAt: at(-MIN) }) } },
  );
  await runDispatch(second.deps);
  assert.deepEqual(second.ranChecks, []);
});

test('a check past its timeout wakes the task with what its last attempt said', async () => {
  const { deps, backend, ranChecks } = setup(
    [waitingTask('w1', { wakeAt: at(-MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check({ lastCheckAt: at(-2 * MIN), lastExit: 8, lastOutput: 'still running' }) } },
  );
  await runDispatch(deps);
  assert.deepEqual(ranChecks, []);
  const wake = backend.writes.find((w) => w.startsWith('wake w1:'));
  assert.ok(wake?.includes('did not pass before its timeout') && wake.includes('exit code 8'), wake);
  assert.ok(wake?.includes('still running'));
});

test('checks wait for the next tick when the tick has too little time left for them', async () => {
  let now = NOW;
  const { deps, ranChecks, logs } = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check() } },
  );
  // The board was slow: listing took a minute.
  const listTasks = deps.backend.listTasks.bind(deps.backend);
  deps.backend.listTasks = async (options) => {
    const tasks = await listTasks(options);
    now = at(MIN);
    return tasks;
  };
  await runDispatch({ ...deps, now: () => now });
  assert.deepEqual(ranChecks, []);
  assert.ok(logs.some((line) => line.startsWith('DEFER-CHECKS 1')));
});

test('a check wait whose check is gone wakes at once', async () => {
  const { deps, backend } = setup([waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })]);
  await runDispatch(deps);
  assert.ok(backend.writes.some((w) => w.startsWith('wake w1:') && w.includes('no longer stored on here')));
});

test('a check whose task left Waiting is dropped; one whose task still runs is kept', async () => {
  const { deps, waits } = setup(
    [
      task({ id: 'moved', status: 'needs-me', machine: 'here' }),
      task({ id: 'r1', status: 'running', machine: 'here' }),
    ],
    ['agent-board-r1'],
    {},
    { checks: { moved: check(), r1: check(), gone: check() } },
  );
  await runDispatch(deps);
  assert.deepEqual(waits.list(), ['r1']);
});
