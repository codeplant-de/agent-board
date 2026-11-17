import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { limitTick, runDispatch } from './dispatch.mts';
import type { DispatchDeps } from './dispatch.mts';
import { BackendError } from '../backend/backend.mts';
import type { Fetch } from '../backend/backend.mts';
import { createWebBackend } from '../backend/web-backend.mts';
import { API_VERSION, MIN_SERVER } from '@agent-board/shared';
import { RETRY_AFTER_FAILURE_MS, RETRY_AFTER_UNPUBLISHED_MS } from '../self/auto-update.mts';
import type { UpdateDeps } from '../self/auto-update.mts';
import type { AutoUpdate } from '../config/config.mts';
import { parseWorkerUnits, SystemError } from '../setup/system.mts';
import type { System } from '../setup/system.mts';
import { START_MARKER } from '../task-rules.mts';
import {
  CONFIG,
  DATA_KEY,
  fakeBackend,
  fakeRunFiles,
  fakeTaskFiles,
  fakeWorktreeLocks,
  fakeUpdateState,
  fakeWaitStore,
  task,
} from '../__tests__/helpers/fakes.mts';
import type { CheckResult, WaitCheck } from './waits.mts';
import { TASK_FILES_KEEP_MS } from './dispatch.mts';
import type { TaskFile } from './task-files.mts';
import type { FakeBackend } from '../__tests__/helpers/fakes.mts';
import { GitHubError } from './github.mts';
import type { GitHub } from './github.mts';
import { createPrRefreshState, PR_REFRESH_INTERVAL_MS, prRefreshFile } from './pr-states.mts';
import type { PrRefreshState } from './pr-states.mts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NOW = new Date('2026-01-01T12:00:00Z');

function fakePrRefreshState(at?: Date): PrRefreshState & { at: Date | undefined } {
  const state = {
    at,
    refreshedAt: () => state.at,
    markRefreshed: (when: Date) => {
      state.at = when;
    },
  };
  return state;
}

function setup(
  tasks: ReturnType<typeof task>[],
  active: string[] = [],
  unitStarts: Record<string, Date> = {},
  {
    checks = {},
    checkResult,
    taskFiles: initialFiles = [],
    locks = {},
    ...updating
  }: {
    checks?: Record<string, WaitCheck>;
    taskFiles?: TaskFile[];
    locks?: Record<string, string[]>;
    checkResult?: (check: WaitCheck) => CheckResult;
    autoUpdate?: AutoUpdate;
    advertised?: string;
    compiled?: boolean;
    retryAfter?: Date;
    fails?: string;
    warnings?: string[];
  } = {},
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
  const updates: string[] = [];
  const state = fakeUpdateState({ deferred: updating.retryAfter });
  const update: UpdateDeps = {
    compiled: updating.compiled ?? true,
    version: '0.5.0',
    advertised: () => updating.advertised,
    state,
    update: async () => {
      updates.push('self-update');
      if (updating.fails !== undefined) throw new SystemError(updating.fails);
      return 'updated';
    },
  };
  const taskFiles = fakeTaskFiles(initialFiles);
  const worktreeLocks = fakeWorktreeLocks(locks);
  const deps: DispatchDeps = {
    backend,
    config: { ...CONFIG, autoUpdate: updating.autoUpdate ?? 'incompatible' },
    dryRun: false,
    print: (line) => logs.push(line),
    system,
    files,
    now: () => NOW,
    logTail: () => 'last log line',
    waits,
    taskFiles,
    worktreeLocks,
    runCheck: async (check) => {
      ranChecks.push(check.command);
      return checkResult?.(check) ?? { exitCode: 1, timedOut: false, output: 'pending' };
    },
    update,
    configWarnings: () => updating.warnings ?? [],
    prRefresh: { github: undefined, state: fakePrRefreshState() },
  };
  return { backend, deps, started, stopped, logs, files, waits, taskFiles, worktreeLocks, ranChecks, updates, state };
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

test('every tick starts with one WARN line per unknown config key', async () => {
  const { deps, logs, started } = setup([todo('t1')], [], {}, { warnings: ['unknown key "lane", ignored'] });
  await runDispatch(deps);
  assert.equal(logs[0], 'WARN config.json: unknown key "lane", ignored');
  assert.deepEqual(started, ['t1']);
});

test('with all slots taken nothing starts', async () => {
  const { deps, started } = setup([running('r1'), running('r2'), todo('t1')], ['agent-board-r1', 'agent-board-r2']);
  await runDispatch(deps);
  assert.deepEqual(started, []);
});

test('a task this machine cannot serve is left in Todo for another machine', async () => {
  const pinned = task({ id: 'pinned', input: '/selftest go', next: 'resume', sessionId: 's', machine: 'there' });
  const elsewhere = task({ id: 'elsewhere', input: 'Find out X', machine: 'there', workdir: '/x' });
  const { deps, started, backend, logs } = setup([pinned, elsewhere, todo('t1')]);
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(!backend.writes.some((w) => w.includes('pinned') || w.includes('elsewhere')));
  assert.ok(logs.some((line) => line.startsWith('SKIP pinned pinned to there')));
  assert.ok(logs.some((line) => line.startsWith('SKIP elsewhere pinned to there')));
});

test('a task that names an agent this machine does not define is skipped, and one it defines is started', async () => {
  const ghost = task({ id: 'ghost', input: 'Review it', agent: 'ghost' });
  const known = task({ id: 'known', input: 'Review it', agent: 'reviewer' });
  const { deps, started, backend, logs } = setup([ghost, known]);
  deps.config = {
    ...CONFIG,
    agents: {
      reviewer: { description: 'd', tools: ['Read'], allowedTools: [], disallowedTools: [], env: [], mcpServers: [] },
    },
  };
  await runDispatch(deps);
  assert.deepEqual(started, ['known']);
  assert.ok(!backend.writes.some((w) => w.includes('ghost')), 'left in Todo, not claimed or failed');
  assert.ok(logs.includes('SKIP ghost no agents.ghost in config.json here'));
});

test('a task pinned here that names a missing agent is claimed, so its worker can fail it', async () => {
  const pinned = task({ id: 'pin', input: 'Review it', agent: 'ghost', machine: 'here', workdir: '/x' });
  const { deps, started, logs } = setup([pinned]);
  await runDispatch(deps);
  assert.deepEqual(started, ['pin']);
  assert.ok(!logs.some((line) => line.startsWith('SKIP pin')));
});

test('an agent that cannot be read is logged as a warning every tick, and the rest of the machine works', async () => {
  const { deps, started, logs } = setup([todo('t1'), task({ id: 'bad', input: 'x', agent: 'broken' })]);
  deps.config = { ...CONFIG, agentErrors: { broken: 'config: agents.broken has no key "tool"' } };
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(logs.some((line) => line.startsWith('WARN config.json: config: agents.broken has no key "tool"')));
  assert.ok(logs.some((line) => line.startsWith('SKIP bad agents.broken in config.json here cannot be used')));
});

test('a task of the removed intake without an agent is claimed and started, so that its worker fails it', async () => {
  const review = task({
    id: 'rev',
    input: '/review-pr https://github.com/cosuno/cosuno/pull/1 --auto',
    createdBy: 'intake',
  });
  const { deps, started, logs } = setup([review]);
  await runDispatch(deps);
  assert.deepEqual(started, ['rev']);
  assert.ok(!logs.some((line) => line.startsWith('SKIP rev')));
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

test('after a gap between ticks (a sleep) a quiet run is left alone, and the tick is marked', async () => {
  const quiet = task({ id: 'q', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files, stopped, backend, logs } = setup([quiet], ['agent-board-q'], {
    'agent-board-q': new Date(NOW.getTime() - 5 * 60 * 60_000),
  });
  files.alive.set('q', new Date(NOW.getTime() - 3 * 60 * 60_000));
  files.dispatchTick = new Date(NOW.getTime() - 3 * 60 * 60_000);
  await runDispatch(deps);
  assert.deepEqual(stopped, []);
  assert.ok(!backend.writes.some((w) => w.startsWith('fail q:')));
  assert.ok(logs.some((line) => line.startsWith('NOTE no tick for 180 minutes')));
  assert.equal(files.dispatchTick?.getTime(), NOW.getTime());
  // The next tick has no gap, and a run that is still quiet is swept.
  await runDispatch(deps);
  assert.deepEqual(stopped, ['agent-board-q']);
});

test('the first tick, or one two minutes after the last, sweeps a quiet run as always', async () => {
  for (const last of [undefined, new Date(NOW.getTime() - 2 * 60_000)]) {
    const quiet = task({ id: 'q', status: 'running', input: '/selftest go', machine: 'here' });
    const { deps, files, stopped } = setup([quiet], ['agent-board-q'], {
      'agent-board-q': new Date(NOW.getTime() - 5 * 60 * 60_000),
    });
    files.alive.set('q', new Date(NOW.getTime() - 3 * 60 * 60_000));
    files.dispatchTick = last;
    await runDispatch(deps);
    assert.deepEqual(stopped, ['agent-board-q']);
  }
});

test('a dry run does not mark the tick', async () => {
  const { deps, files } = setup([]);
  deps.dryRun = true;
  await runDispatch(deps);
  assert.equal(files.dispatchTick, undefined);
});

test('the in-process time limit calls its handler once the limit is up, and not when cancelled', async () => {
  let fired = 0;
  const cancel = limitTick(20, () => void (fired += 1));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 1);
  const cancelled = limitTick(20, () => void (fired += 1));
  cancelled();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 1);
  cancel();
});

test('a todo task whose last worker is still stopping is not started again', async () => {
  const { deps, started, backend, logs } = setup([todo('t1'), todo('t2')], ['agent-board-t1']);
  await runDispatch(deps);
  assert.deepEqual(started, ['t2']);
  assert.ok(logs.includes('SKIP t1 its last worker is still stopping'));
  assert.ok(!backend.writes.some((w) => w.includes('t1')));
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

test('the next due time is the first delayed Todo task this machine could serve', async () => {
  const later = task({ id: 'w1', input: '/selftest go', notBefore: at(10 * MIN) });
  const sooner = task({ id: 'w2', input: '/selftest go', notBefore: at(3 * MIN) });
  const elsewhere = task({ id: 'w3', input: '/selftest go', machine: 'there', workdir: '/x', notBefore: at(MIN) });
  const proposal = task({ id: 'w4', input: 'x', createdBy: 'agent', notBefore: at(MIN) });
  const { deps, files, logs } = setup([later, sooner, elsewhere, proposal]);
  await runDispatch(deps);
  assert.equal(files.next?.getTime(), at(3 * MIN).getTime());
  assert.ok(logs.includes(`TICK started=0 general=0/2 next=${at(3 * MIN).toISOString()}`), logs.join('\n'));
});

test('the next due time counts the end of a wait here, not one on another machine', async () => {
  const { deps, files } = setup([
    waitingTask('w1', { wakeAt: at(10 * MIN) }),
    waitingTask('w2', { wakeAt: at(MIN), machine: 'other' }),
  ]);
  await runDispatch(deps);
  assert.equal(files.next?.getTime(), at(10 * MIN).getTime());
});

test('a check that failed is due again --every after it ran', async () => {
  const { deps, files } = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check({ everyMs: 5 * MIN }) } },
  );
  await runDispatch(deps);
  assert.equal(files.next?.getTime(), at(5 * MIN).getTime());
});

test('a check not due yet counts from its last attempt; one that passed counts no more', async () => {
  const waiting = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check({ lastCheckAt: at(-MIN) }) } },
  );
  await runDispatch(waiting.deps);
  assert.equal(waiting.files.next?.getTime(), at(MIN).getTime());

  const passed = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check() }, checkResult: () => ({ exitCode: 0, timedOut: false, output: '' }) },
  );
  await runDispatch(passed.deps);
  assert.equal(passed.files.next, undefined);
});

test('a borrowed run counts the moment it may be paused, while its lane has own work waiting', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files } = setup([borrowed, impl('i1')], ['agent-board-b1']);
  deps.config = { ...LANED, lanes: [{ name: 'implement', skills: ['implement'], slots: 1 }] };
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: at(-2 * MIN) });
  files.alive.set('b1', NOW);
  await runDispatch(deps);
  assert.equal(files.pauses.size, 0);
  assert.equal(files.next?.getTime(), at(3 * MIN).getTime());
});

test('a borrowed run paused in this tick, or one whose lane has nothing waiting, counts nothing', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  const young = task({ id: 'b2', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files } = setup([borrowed, young, impl('i1')], ['agent-board-b1', 'agent-board-b2']);
  deps.config = { ...LANED, lanes: [{ name: 'implement', skills: ['implement'], slots: 2 }] };
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: at(-6 * MIN) });
  files.runs.set('b2', { lane: 'implement', borrowed: true, startedAt: at(-MIN) });
  files.alive.set('b1', NOW);
  files.alive.set('b2', NOW);
  await runDispatch(deps);
  assert.ok(files.pauses.has('b1'));
  assert.equal(files.next, undefined, 'the lane has a pause pending');

  const idle = setup([borrowed], ['agent-board-b1']);
  idle.deps.config = deps.config;
  idle.files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: at(-MIN) });
  idle.files.alive.set('b1', NOW);
  await runDispatch(idle.deps);
  assert.equal(idle.files.next, undefined);
});

test('a tick that fails leaves no next due time behind, and a dry run writes none', async () => {
  const failing = setup([task({ id: 'w1', input: '/selftest go', notBefore: at(MIN) })]);
  failing.files.next = at(-MIN);
  failing.backend.listTasks = async () => {
    throw new Error('backend list-tasks failed');
  };
  await assert.rejects(runDispatch(failing.deps), /list-tasks failed/);
  assert.equal(failing.files.next, undefined);

  const dry = setup([task({ id: 'w1', input: '/selftest go', notBefore: at(MIN) })]);
  dry.deps.dryRun = true;
  await runDispatch(dry.deps);
  assert.equal(dry.files.next, undefined);
});

test('a check wait whose check is gone wakes at once', async () => {
  const { deps, backend } = setup([waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })]);
  await runDispatch(deps);
  assert.ok(backend.writes.some((w) => w.startsWith('wake w1:') && w.includes('no longer stored on here')));
});

const vocabularyRefusal = (): BackendError =>
  new BackendError(
    'get-task: error from the board server (HTTP 422), quoted and not part of the board: "this task uses status \\"x\\""',
    422,
    true,
  );

test('a check whose task the board hides from this CLI is kept, and dropped only once the task is really gone', async () => {
  const { deps, backend, waits, logs } = setup(
    [],
    [],
    {},
    { checks: { hidden: check(), moved: check(), down: check() } },
  );
  const getTask = backend.getTask.bind(backend);
  backend.tasks.push(task({ id: 'moved', status: 'needs-me', machine: 'here' }));
  backend.getTask = async (id) => {
    if (id === 'hidden') throw vocabularyRefusal();
    if (id === 'down') throw new BackendError('cannot reach the board');
    return getTask(id);
  };
  backend.listTasks = async () => [];
  await runDispatch(deps);
  assert.deepEqual(waits.list().sort(), ['down', 'hidden']);
  assert.ok(logs.some((line) => line.startsWith('KEEP-CHECK hidden') && line.includes('does not know')));
  assert.ok(logs.some((line) => line.startsWith('DROP-CHECK moved')));
  const gone = setup([], [], {}, { checks: { gone: check() } });
  await runDispatch(gone.deps);
  assert.deepEqual(gone.waits.list(), []);
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

const OLD = new Date(NOW.getTime() - TASK_FILES_KEEP_MS - 60_000);
const RECENT = new Date(NOW.getTime() - TASK_FILES_KEEP_MS + 60_000);
const filesOf = (taskId: string, modifiedAt: Date = OLD): TaskFile[] => [
  { kind: 'log', taskId, modifiedAt },
  { kind: 'session', taskId, modifiedAt },
];
const remaining = (files: TaskFile[]): string[] => files.map((file) => `${file.kind} ${file.taskId}`).sort();

test('old logs and session records of done, closed and deleted tasks are dropped; recent ones stay', async () => {
  const { deps, taskFiles, logs } = setup(
    [
      task({ id: 'done', status: 'done' }),
      task({ id: 'closed', status: 'needs-me', closed: true }),
      task({ id: 'fresh', status: 'done' }),
    ],
    [],
    {},
    { taskFiles: [...filesOf('done'), ...filesOf('closed'), ...filesOf('deleted'), ...filesOf('fresh', RECENT)] },
  );
  await runDispatch(deps);
  assert.deepEqual(remaining(taskFiles.files), ['log fresh', 'session fresh']);
  assert.ok(logs.includes('DROP-LOG done its task is finished'));
  assert.ok(logs.includes('DROP-SESSION closed its task is finished'));
  assert.ok(logs.includes('DROP-SESSION deleted its task is finished'));
});

test('the files of a task that may still run, or whose worker still runs here, stay however old', async () => {
  const { deps, taskFiles, logs } = setup(
    [
      task({ id: 'resume', status: 'todo', next: 'resume', sessionId: 's', machine: 'there' }),
      task({ id: 'waiting', status: 'waiting', machine: 'here' }),
      task({ id: 'running', status: 'running', machine: 'here' }),
      task({ id: 'needs', status: 'needs-me' }),
      task({ id: 'stopping', status: 'done' }),
    ],
    ['agent-board-running', 'agent-board-stopping'],
    {},
    {
      taskFiles: ['resume', 'waiting', 'running', 'needs', 'stopping', 'hidden', 'down'].flatMap((id) => filesOf(id)),
    },
  );
  const getTask = deps.backend.getTask.bind(deps.backend);
  deps.backend.getTask = async (id) => {
    if (id === 'hidden') throw vocabularyRefusal();
    if (id === 'down') throw new BackendError('cannot reach the board');
    return getTask(id);
  };
  await runDispatch(deps);
  assert.equal(taskFiles.files.length, 14);
  assert.ok(!logs.some((line) => line.startsWith('DROP-')));
});

test('a dry run prints the files it would drop and removes none', async () => {
  const { deps, taskFiles, logs } = setup(
    [task({ id: 'done', status: 'done' })],
    [],
    {},
    { taskFiles: filesOf('done') },
  );
  await runDispatch({ ...deps, dryRun: true });
  assert.equal(taskFiles.files.length, 2);
  assert.ok(logs.includes('DROP-LOG done its task is finished'));
  assert.ok(logs.includes('DROP-SESSION done its task is finished'));
});

test('the worktrees of done, closed and deleted tasks are unlocked; those of tasks that may still run stay locked', async () => {
  const { deps, worktreeLocks, logs } = setup(
    [
      task({ id: 'done', status: 'done' }),
      task({ id: 'closed', status: 'needs-me', closed: true }),
      task({ id: 'needs', status: 'needs-me' }),
      task({ id: 'stopping', status: 'done' }),
    ],
    ['agent-board-stopping'],
    {},
    {
      locks: Object.fromEntries(
        ['done', 'closed', 'deleted', 'needs', 'stopping', 'hidden', 'down'].map((id) => [id, [`/wt/${id}`]]),
      ),
    },
  );
  const getTask = deps.backend.getTask.bind(deps.backend);
  deps.backend.getTask = async (id) => {
    if (id === 'hidden') throw vocabularyRefusal();
    if (id === 'down') throw new BackendError('cannot reach the board');
    return getTask(id);
  };
  await runDispatch(deps);
  assert.deepEqual(worktreeLocks.tasks().sort(), ['down', 'hidden', 'needs', 'stopping']);
  assert.ok(logs.includes('UNLOCK done unlocked the worktree /wt/done'));
  assert.ok(logs.includes('UNLOCK deleted unlocked the worktree /wt/deleted'));
});

test('a dry run prints the worktrees it would unlock and unlocks none', async () => {
  const { deps, worktreeLocks, logs } = setup(
    [task({ id: 'done', status: 'done' })],
    [],
    {},
    { locks: { done: ['/wt/done'] } },
  );
  await runDispatch({ ...deps, dryRun: true });
  assert.deepEqual(worktreeLocks.tasks(), ['done']);
  assert.ok(logs.includes('DRY unlock the worktrees of done: its task is finished'));
});

const tooOld = (backend: FakeBackend): void => {
  backend.listTasks = async () => {
    const error = new BackendError('this CLI is older than the board server', undefined);
    error.contractMismatch = 'cli-older';
    throw error;
  };
};

test('a CLI the board refuses as too old updates itself and ends the tick without failing', async () => {
  const { deps, backend, updates, started, logs, state } = setup([todo('t1')], [], {}, { autoUpdate: 'incompatible' });
  tooOld(backend);
  await runDispatch(deps);
  assert.deepEqual(updates, ['self-update']);
  assert.deepEqual(started, []);
  assert.ok(logs.some((line) => line.startsWith('UPDATING this CLI is too old')));
  assert.equal(state.deferred, undefined);
});

test('the real version check of a server that moved on makes the dispatcher update, and one that is merely older does not', async () => {
  const answering =
    (api: { version: number; minClient: number }): Fetch =>
    async () =>
      new Response(JSON.stringify({ result: { contract: 9, owner: 'alice', keyId: null, api } }));
  const listingVia = (backend: FakeBackend, api: { version: number; minClient: number }): void => {
    const web = createWebBackend({
      loadConfig: () => ({ url: 'https://board.test', token: 'abm_x', dataKey: DATA_KEY }),
      fetch: answering(api),
    });
    backend.listTasks = () => web.listTasks().then(() => []);
  };
  const newer = setup([], [], {}, {});
  listingVia(newer.backend, { version: API_VERSION + 1, minClient: API_VERSION + 1 });
  await runDispatch(newer.deps);
  assert.deepEqual(newer.updates, ['self-update']);
  const older = setup([], [], {}, {});
  listingVia(older.backend, { version: MIN_SERVER - 1, minClient: 1 });
  await assert.rejects(runDispatch(older.deps), /the board server is older than this CLI/);
  assert.deepEqual(older.updates, []);
});

test('with autoUpdate never a too-old CLI does not update and the tick fails as before', async () => {
  const { deps, backend, updates } = setup([], [], {}, { autoUpdate: 'never' });
  tooOld(backend);
  await assert.rejects(runDispatch(deps), /older than the board server/);
  assert.deepEqual(updates, []);
});

test('a checkout never updates itself: it says so and the tick fails', async () => {
  const { deps, backend, updates, logs } = setup([], [], {}, { compiled: false });
  tooOld(backend);
  await assert.rejects(runDispatch(deps), /older than the board server/);
  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.startsWith('UPDATE-NEEDED') && line.includes('git pull')));
});

test('a failed update is logged, ends the tick quietly and is not tried again for an hour', async () => {
  const { deps, backend, updates, logs, state } = setup(
    [],
    [],
    {},
    { fails: 'gh is not logged in: run "gh auth login"' },
  );
  tooOld(backend);
  await runDispatch(deps);
  assert.deepEqual(updates, ['self-update']);
  assert.ok(logs.some((line) => line.startsWith('UPDATE-FAILED gh is not logged in')));
  assert.deepEqual(state.deferred, new Date(NOW.getTime() + RETRY_AFTER_FAILURE_MS));

  const soon = setup([], [], {}, { retryAfter: new Date(NOW.getTime() + 60_000) });
  tooOld(soon.backend);
  await runDispatch(soon.deps);
  assert.deepEqual(soon.updates, []);
  assert.ok(soon.logs.some((line) => line.startsWith('UPDATE-SKIPPED')));

  const later = setup([], [], {}, { retryAfter: NOW });
  tooOld(later.backend);
  await runDispatch(later.deps);
  assert.deepEqual(later.updates, ['self-update']);
});

test('the attempt is recorded before it starts, so a tick killed midway does not start over', async () => {
  const { deps, backend, state } = setup([], [], {}, {});
  tooOld(backend);
  let during: Date | undefined;
  deps.update.update = async () => {
    during = state.deferred;
    throw new Error('the tick was killed here');
  };
  await runDispatch(deps);
  assert.deepEqual(during, new Date(NOW.getTime() + RETRY_AFTER_FAILURE_MS));
});

test('an advertised release that is not published yet is retried in five minutes, not an hour', async () => {
  const { deps, backend, state, logs } = setup([], [], {}, {});
  tooOld(backend);
  deps.update.update = async () => 'unchanged';
  await runDispatch(deps);
  assert.ok(logs.some((line) => line.includes('no newer release is published yet')));
  assert.deepEqual(state.deferred, new Date(NOW.getTime() + RETRY_AFTER_UNPUBLISHED_MS));
});

test('a tick that fails for another reason is not an update', async () => {
  const { deps, backend, updates } = setup([]);
  backend.listTasks = async () => {
    throw new BackendError('cannot reach the board');
  };
  await assert.rejects(runDispatch(deps), /cannot reach/);
  assert.deepEqual(updates, []);
});

test('with autoUpdate always a newer release updates an idle machine and ends the tick', async () => {
  const { deps, updates, started } = setup([todo('t1')], [], {}, { autoUpdate: 'always', advertised: '0.6.0' });
  await runDispatch(deps);
  assert.deepEqual(updates, ['self-update']);
  assert.deepEqual(started, []);
});

test('with autoUpdate always a newer release waits while workers run, and the tick goes on', async () => {
  const { deps, updates, logs } = setup(
    [running('r1')],
    ['agent-board-r1'],
    {},
    { autoUpdate: 'always', advertised: '0.6.0' },
  );
  await runDispatch(deps);
  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.startsWith('UPDATE-WAIT') && line.includes('1 worker')));
  assert.ok(logs.some((line) => line.startsWith('TICK')));
});

test('a newer release is left alone by incompatible, and an equal or unknown one by always', async () => {
  const incompatible = setup([], [], {}, { autoUpdate: 'incompatible', advertised: '0.9.0' });
  await runDispatch(incompatible.deps);
  const equal = setup([], [], {}, { autoUpdate: 'always', advertised: '0.5.0' });
  await runDispatch(equal.deps);
  const unknown = setup([], [], {}, { autoUpdate: 'always' });
  await runDispatch(unknown.deps);
  assert.deepEqual([...incompatible.updates, ...equal.updates, ...unknown.updates], []);
});

test('a failed update under always does not stop the tick, and a dry run never updates', async () => {
  const failing = setup(
    [todo('t1')],
    [],
    {},
    { autoUpdate: 'always', advertised: '0.6.0', fails: 'gh is not installed' },
  );
  await runDispatch(failing.deps);
  assert.deepEqual(failing.started, ['t1']);
  const dry = setup([], [], {}, { autoUpdate: 'always', advertised: '0.6.0' });
  dry.deps.dryRun = true;
  await runDispatch(dry.deps);
  assert.deepEqual(dry.updates, []);
  assert.ok(dry.logs.some((line) => line.startsWith('DRY self-update')));
});

test('the listener and foreign agent-board units are not workers: they neither wait an update out nor take a lane slot', async () => {
  const listing = [
    'agent-board-listen.service loaded active running agent-board listener',
    'agent-board-dispatch.service loaded active running agent-board dispatcher: one tick',
    'agent-board-foo.service loaded active running a unit the user made',
  ].join('\n');
  const { deps, updates } = setup([], [], {}, { autoUpdate: 'always', advertised: '0.6.0' });
  deps.system.activeWorkers = async () => parseWorkerUnits(listing);
  await runDispatch(deps);
  assert.deepEqual(updates, ['self-update']);
});

const listed = { ...CONFIG, dirs: [{ path: tmpdir() }, { path: '/does/not/exist/for/sure' }] };

test('a tick sends the directory list when the board lacks it or has an older one, and logs it once', async () => {
  const { deps, backend, logs } = setup([]);
  deps.config = listed;
  await runDispatch(deps);
  assert.deepEqual(
    backend.writes.filter((w) => w.startsWith('dirs ')),
    [`dirs here: ${tmpdir()}`],
  );
  assert.ok(logs.includes('DIRS sent 1 directories to the board'));
  await runDispatch(deps);
  assert.equal(backend.writes.filter((w) => w.startsWith('dirs ')).length, 1);
  assert.equal(logs.filter((line) => line.startsWith('DIRS')).length, 1, 'unchanged logs nothing');
  deps.config = { ...CONFIG, dirs: [] };
  await runDispatch(deps);
  assert.ok(logs.includes('DIRS sent 0 directories to the board'));
});

test('a tick without a dirs key, or on a server without directory lists, sends and logs nothing about them', async () => {
  const plain = setup([todo('t1')]);
  await runDispatch(plain.deps);
  assert.ok(!plain.backend.writes.some((w) => w.startsWith('dirs ')));
  const old = setup([todo('t1')]);
  old.deps.config = listed;
  old.backend.boardDirs.supported = false;
  await runDispatch(old.deps);
  assert.ok(!old.backend.writes.some((w) => w.startsWith('dirs ')));
  assert.ok(!old.logs.some((line) => /dirs|DIRS/i.test(line)));
  assert.deepEqual(old.started, ['t1']);
});

test('a failure to send the directory list costs one WARN line, and the tick goes on', async () => {
  const { deps, backend, logs, started } = setup([todo('t1')]);
  deps.config = listed;
  backend.boardDirs.failure = new BackendError('set-dirs: the server answered 502 without JSON', 502);
  await runDispatch(deps);
  assert.equal(logs.filter((line) => line.includes('directory list')).length, 1);
  assert.ok(logs.includes('WARN sending the directory list failed: set-dirs: the server answered 502 without JSON'));
  assert.deepEqual(started, ['t1']);
  assert.ok(logs.some((line) => line.startsWith('TICK ')));
});

const PR = 'https://github.com/cosuno/cosuno/pull/5';
const withPr = () => task({ id: 'pr1', status: 'needs-me', input: `/review-pr ${PR} --auto` });

function withGitHub(tasks: ReturnType<typeof task>[], github: Partial<GitHub> | undefined, at?: Date) {
  const setupResult = setup(tasks);
  const asked: string[][] = [];
  const state = fakePrRefreshState(at);
  setupResult.deps.prRefresh = {
    github:
      github === undefined
        ? undefined
        : {
            prStates: async (urls) => {
              asked.push(urls);
              return { states: new Map([[PR, 'merged' as const]]), unreadable: [] };
            },
            ...github,
          },
    state,
  };
  return { ...setupResult, asked, state };
}

test('a tick refreshes the PR state of open tasks and stamps the time', async () => {
  const { deps, backend, logs, asked, state } = withGitHub([withPr()], {});
  await runDispatch(deps);
  assert.deepEqual(asked, [[PR]]);
  assert.ok(backend.writes.includes('prStates pr1 prompt=merged'));
  assert.ok(logs.includes('PRSTATES changed=1'));
  assert.deepEqual(state.at, NOW);
});

test('the PR states are looked up once per 10 minutes', async () => {
  const recent = new Date(NOW.getTime() - PR_REFRESH_INTERVAL_MS + 1000);
  const fresh = withGitHub([withPr()], {}, recent);
  await runDispatch(fresh.deps);
  assert.deepEqual(fresh.asked, []);
  assert.deepEqual(fresh.state.at, recent, 'a skipped tick does not move the time');
  const due = withGitHub([withPr()], {}, new Date(NOW.getTime() - PR_REFRESH_INTERVAL_MS));
  await runDispatch(due.deps);
  assert.deepEqual(due.asked, [[PR]]);
});

test('without gh, or without a PR to look up, nothing is looked up or logged', async () => {
  const noGh = withGitHub([withPr()], undefined);
  await runDispatch(noGh.deps);
  assert.equal(noGh.state.at, undefined);
  assert.ok(!noGh.logs.some((line) => /PR/.test(line)));
  const noPr = withGitHub([todo('t1')], {});
  await runDispatch(noPr.deps);
  assert.deepEqual(noPr.asked, []);
  assert.equal(noPr.state.at, undefined);
});

test('a failing lookup costs one WARN line, never the tick, and is not retried before the interval', async () => {
  const failing = withGitHub([withPr(), todo('t1')], {
    prStates: async () => {
      throw new GitHubError('gh api graphql failed: HTTP 502');
    },
  });
  await runDispatch(failing.deps);
  assert.ok(failing.logs.includes('WARN PR states not refreshed: gh api graphql failed: HTTP 502'));
  assert.deepEqual(failing.started, ['t1']);
  assert.deepEqual(failing.state.at, NOW);
  const crashing = withGitHub([withPr()], {
    prStates: async () => {
      throw new Error('boom');
    },
  });
  await runDispatch(crashing.deps);
  assert.ok(crashing.logs.includes('WARN PR states not refreshed: boom'));
  assert.ok(crashing.logs.some((line) => line.startsWith('TICK ')));
});

test('a dry run looks the states up but stamps nothing', async () => {
  const { deps, state, asked } = withGitHub([withPr()], {});
  deps.dryRun = true;
  await runDispatch(deps);
  assert.deepEqual(asked, [[PR]]);
  assert.equal(state.at, undefined);
});

test('the PR refresh time is kept in a small file in the state directory, and a broken file reads as never', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-pr-refresh-'));
  try {
    const state = createPrRefreshState(prRefreshFile(join(dir, 'nested')));
    assert.equal(state.refreshedAt(), undefined);
    state.markRefreshed(NOW);
    assert.deepEqual(state.refreshedAt(), NOW);
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, 'not json');
    assert.equal(createPrRefreshState(broken).refreshedAt(), undefined);
    assert.doesNotThrow(() => createPrRefreshState(join(broken, 'x', 'y.json')).markRefreshed(NOW));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
