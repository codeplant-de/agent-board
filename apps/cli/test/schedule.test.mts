import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDuplicateAnswer, parseScheduleArgs, schedule } from '../src/schedule.mts';
import type { Duplicate, ScheduleDeps } from '../src/schedule.mts';
import { fakeBackend, task } from './helpers.mts';

test("the board's flags come first; the rest is the prompt, its own flags included", () => {
  assert.deepEqual(parseScheduleArgs(['--priority', 'high', '/review-pr', '17741', '--auto']), {
    prompt: '/review-pr 17741 --auto',
    priority: 'high',
    title: undefined,
    hold: false,
    backlog: false,
    forceNew: false,
  });
  assert.deepEqual(parseScheduleArgs(['--hold', '--new', '--title', 'Export', 'Find', 'out', 'why']), {
    prompt: 'Find out why',
    priority: undefined,
    title: 'Export',
    hold: true,
    backlog: false,
    forceNew: true,
  });
  assert.equal(parseScheduleArgs(['--', '--weird', 'prompt']).prompt, '--weird prompt');
  assert.throws(() => parseScheduleArgs(['--priority', 'asap', 'x']), /unknown priority/);
  assert.throws(() => parseScheduleArgs(['--hold']), /usage: board schedule/);
  assert.equal(parseScheduleArgs(['--backlog', 'Find', 'out']).backlog, true);
  assert.throws(() => parseScheduleArgs(['--hold', '--backlog', 'x']), /cannot be combined/);
});

function setup(duplicate: Duplicate | undefined, choice?: 'requeue' | 'new' | 'abort') {
  const existing = task({ id: 'old', title: '#17741 Show postal code', input: '/review-pr 17741', status: 'needs-me' });
  const backend = fakeBackend([existing]);
  const printed: string[] = [];
  const asked: string[] = [];
  const deps: ScheduleDeps = {
    backend,
    machine: 'here',
    workdir: '/work/cosuno',
    print: (line) => printed.push(line),
    check: async (_prompt, _workdir, open) => {
      asked.push(open.map((t) => t.id).join(','));
      return duplicate;
    },
    choose: choice === undefined ? undefined : async () => choice,
  };
  return { deps, backend, printed, asked };
}

test('without a duplicate the task is created, pinned to this machine and directory', async () => {
  const { deps, backend, printed } = setup(undefined);
  const created = await schedule(deps, parseScheduleArgs(['--priority', 'high', '/grill', 'the', 'plan']));
  assert.deepEqual(
    [created?.machine, created?.workdir, created?.priority, created?.createdBy, created?.status],
    ['here', '/work/cosuno', 'high', 'user', 'todo'],
  );
  assert.ok(backend.writes.some((w) => w.startsWith('create /grill the plan | /grill the plan')));
  assert.ok(printed.some((line) => line.startsWith('scheduled new')));
});

test('a likely duplicate can be requeued, created anyway, or dropped', async () => {
  const dup = { taskId: 'old', reason: 'same PR' };
  const requeue = setup(dup, 'requeue');
  const again = await schedule(requeue.deps, parseScheduleArgs(['/review-pr', '17741']));
  assert.equal(again?.id, 'old');
  assert.ok(requeue.backend.writes.includes('status old -> todo'));
  assert.ok(
    requeue.backend.writes.some((w) => w.startsWith('note old (system): Scheduled again from here:/work/cosuno')),
  );
  assert.ok(!requeue.backend.writes.some((w) => w.startsWith('create')));

  const fresh = setup(dup, 'new');
  await schedule(fresh.deps, parseScheduleArgs(['/review-pr', '17741']));
  assert.ok(fresh.backend.writes.some((w) => w.startsWith('create')));

  const abort = setup(dup, 'abort');
  assert.equal(await schedule(abort.deps, parseScheduleArgs(['/review-pr', '17741'])), undefined);
  assert.deepEqual(abort.backend.writes, []);
});

test('--backlog creates the task in Backlog, --hold in Needs me, neither in Todo', async () => {
  const statusOf = async (flags: string[]) =>
    (await schedule(setup(undefined).deps, parseScheduleArgs([...flags, 'do', 'it'])))?.status;
  assert.equal(await statusOf(['--backlog']), 'backlog');
  assert.equal(await statusOf(['--hold']), 'needs-me');
  assert.equal(await statusOf([]), 'todo');
});

test('a requeue lands in Backlog with --backlog and in Needs me with --hold', async () => {
  const dup = { taskId: 'old', reason: 'same PR' };
  const parked = setup(dup, 'requeue');
  await schedule(parked.deps, parseScheduleArgs(['--backlog', '/review-pr', '17741']));
  assert.ok(parked.backend.writes.includes('status old -> backlog'));
  const held = setup(dup, 'requeue');
  await schedule(held.deps, parseScheduleArgs(['--hold', '/review-pr', '17741']));
  assert.ok(held.backend.writes.includes('status old -> needs-me'));
});

test('without a terminal a duplicate is created with a warning; --new skips the check', async () => {
  const quiet = setup({ taskId: 'old', reason: 'same PR' });
  await schedule(quiet.deps, parseScheduleArgs(['/review-pr', '17741']));
  assert.ok(quiet.backend.writes.some((w) => w.startsWith('note new (system): Possibly a duplicate of old')));
  const forced = setup({ taskId: 'old', reason: 'same PR' });
  await schedule(forced.deps, parseScheduleArgs(['--new', '/review-pr', '17741']));
  assert.deepEqual(forced.asked, [], 'no check');
});

test('requeueing a task that is already queued or running changes nothing', async () => {
  const { deps, backend, printed } = setup({ taskId: 'old', reason: 'same' }, 'requeue');
  backend.tasks[0]!.status = 'running';
  await schedule(deps, parseScheduleArgs(['/review-pr', '17741']));
  assert.deepEqual(backend.writes, []);
  assert.ok(printed.some((line) => line.startsWith('old is already running')));
});

test("the model's answer counts only for a task that is really open", () => {
  const open = [task({ id: 'a1' })];
  const answer = (structured: unknown) => JSON.stringify({ structured_output: structured });
  assert.deepEqual(parseDuplicateAnswer(answer({ duplicate: true, taskId: 'a1', reason: 'same' }), open), {
    taskId: 'a1',
    reason: 'same',
  });
  assert.equal(parseDuplicateAnswer(answer({ duplicate: true, taskId: 'zz', reason: 'x' }), open), undefined);
  assert.equal(parseDuplicateAnswer(answer({ duplicate: false, taskId: null, reason: 'x' }), open), undefined);
});
