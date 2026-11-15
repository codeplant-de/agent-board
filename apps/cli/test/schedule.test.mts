import assert from 'node:assert/strict';
import { test } from 'node:test';
import { polishTask } from '@agent-board/shared';
import type { TaskDraft } from '@agent-board/shared';
import { Command } from 'commander';
import {
  addScheduleOptions,
  parseDuplicateAnswer,
  parseScheduleArgs as toScheduleArgs,
  schedule,
} from '../src/schedule.mts';
import type { Duplicate, ScheduleArgs, ScheduleDeps, ScheduleFlags } from '../src/schedule.mts';
import { fakeBackend, task } from './helpers.mts';

// The command line as `board schedule` reads it: commander splits flags from the prompt, then the flags are checked.
function parseScheduleArgs(args: string[], now?: Date): ScheduleArgs {
  let parsed: ScheduleArgs | undefined;
  const program = new Command()
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ outputError: () => undefined });
  addScheduleOptions(program.command('schedule').argument('<prompt...>').passThroughOptions()).action(
    (words: string[], flags: ScheduleFlags) => {
      parsed = toScheduleArgs(flags, words, now);
    },
  );
  program.parse(['schedule', ...args], { from: 'user' });
  if (!parsed) throw new Error('schedule did not run');
  return parsed;
}

test("the board's flags come first; the rest is the prompt, its own flags included", () => {
  assert.deepEqual(parseScheduleArgs(['--priority', 'high', '/review-pr', '17741', '--auto']), {
    prompt: '/review-pr 17741 --auto',
    priority: 'high',
    model: undefined,
    title: undefined,
    hold: false,
    backlog: false,
    notBefore: undefined,
    every: undefined,
    cron: undefined,
    times: undefined,
    until: undefined,
    forceNew: false,
    polish: false,
  });
  assert.deepEqual(parseScheduleArgs(['--hold', '--new', '--title', 'Export', 'Find', 'out', 'why']), {
    prompt: 'Find out why',
    priority: undefined,
    model: undefined,
    title: 'Export',
    hold: true,
    backlog: false,
    notBefore: undefined,
    every: undefined,
    cron: undefined,
    times: undefined,
    until: undefined,
    forceNew: true,
    polish: false,
  });
  assert.equal(parseScheduleArgs(['--', '--weird', 'prompt']).prompt, '--weird prompt');
  assert.throws(() => parseScheduleArgs(['--priority', 'asap', 'x']), /unknown priority/);
  assert.throws(() => parseScheduleArgs(['--hold']), /missing required argument 'prompt'/);
  assert.throws(() => parseScheduleArgs(['--hodl', 'x']), /unknown option '--hodl'/);
  assert.throws(() => parseScheduleArgs(['--hold', '  ']), /a prompt is required/);
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
    timezone: 'Europe/Berlin',
    print: (line) => printed.push(line),
    link: (id) => `https://board.test/t/${id}`,
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
  const created = (await schedule(deps, parseScheduleArgs(['--priority', 'high', '/grill', 'the', 'plan'])))?.task;
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
  const again = (await schedule(requeue.deps, parseScheduleArgs(['/review-pr', '17741'])))?.task;
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
    (await schedule(setup(undefined).deps, parseScheduleArgs([...flags, 'do', 'it'])))?.task.status;
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

test('requeueing a task that is already queued or running changes nothing without a start time', async () => {
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

const NOW = new Date(2026, 10, 14, 10, 0, 0);

test('--in and --at set when the task starts; both need Todo and exclude each other', () => {
  assert.equal(parseScheduleArgs(['--in', '2h', 'x'], NOW).notBefore?.getTime(), NOW.getTime() + 2 * 3_600_000);
  assert.equal(parseScheduleArgs(['--in', '1h30m', 'x'], NOW).notBefore?.getTime(), NOW.getTime() + 90 * 60_000);
  assert.equal(
    parseScheduleArgs(['--at', '14:30', 'x'], NOW).notBefore?.getTime(),
    new Date(2026, 10, 14, 14, 30).getTime(),
  );
  assert.equal(
    parseScheduleArgs(['--at', '2027-01-01', '--new', 'x'], NOW).notBefore?.getTime(),
    new Date(2027, 0, 1).getTime(),
  );
  assert.equal(parseScheduleArgs(['x'], NOW).notBefore, undefined);
  assert.throws(() => parseScheduleArgs(['--in', '1h', '--at', '14:30', 'x'], NOW), /--in and --at cannot be combined/);
  for (const flag of ['--hold', '--backlog'])
    for (const timing of [
      ['--in', '1h'],
      ['--at', '14:30'],
    ])
      assert.throws(
        () => parseScheduleArgs([flag, ...timing, 'x'], NOW),
        /cannot be combined with --hold or --backlog/,
      );
  assert.throws(() => parseScheduleArgs(['--in', 'soon', 'x'], NOW), /not a duration; use .*m, h, d, w/);
  assert.throws(() => parseScheduleArgs(['--in', '0m', 'x'], NOW), /longer than zero/);
  assert.throws(() => parseScheduleArgs(['--at', '2020-01-01', 'x'], NOW), /in the past/);
  assert.throws(() => parseScheduleArgs(['--at', 'tomorrow', 'x'], NOW), /not a time/);
  assert.throws(() => parseScheduleArgs(['--in'], NOW), /argument missing/);
  assert.throws(() => parseScheduleArgs(['--in', '1h'], NOW), /missing required argument 'prompt'/);
});

test('a delayed task is created in Todo with its start time, which the confirmation names', async () => {
  const { deps, backend, printed } = setup(undefined);
  const created = (await schedule(deps, parseScheduleArgs(['--in', '2h', '/grill', 'plan'])))?.task;
  assert.equal(created?.status, 'todo');
  assert.ok(created?.notBefore && created.notBefore.getTime() > Date.now() + 100 * 60_000);
  assert.ok(
    printed.some((line) => /^scheduled new .*, starts \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(line)),
    printed.join('\n'),
  );
  assert.equal(backend.writes.length, 1);
});

test('a requeue with a delay gives the requeued task the delay', async () => {
  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  const requeued = (await schedule(requeue.deps, parseScheduleArgs(['--in', '1h', '/review-pr', '17741'])))?.task;
  assert.ok(requeue.backend.writes.includes('status old -> todo'));
  assert.ok(requeue.backend.writes.some((w) => w.startsWith('notBefore old: ')));
  assert.ok(requeued?.notBefore);
  assert.ok(requeue.printed.some((line) => line.startsWith('requeued old') && line.includes(', starts ')));
});

test('--in or --at on a requeue of a task already in Todo delays that task', async () => {
  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  requeue.backend.tasks[0]!.status = 'todo';
  const delayed = (await schedule(requeue.deps, parseScheduleArgs(['--in', '1h', '/review-pr', '17741'])))?.task;
  assert.deepEqual(requeue.backend.writes, [`notBefore old: ${delayed?.notBefore?.toISOString()}`]);
  assert.ok(delayed?.notBefore && delayed.notBefore.getTime() > Date.now() + 50 * 60_000);
  assert.ok(requeue.printed.some((line) => line.startsWith('old is already queued, now starts ')));
});

test('a requeue of a running task with --in leaves it alone and says the start time was not applied', async () => {
  const { deps, backend, printed } = setup({ taskId: 'old', reason: 'same' }, 'requeue');
  backend.tasks[0]!.status = 'running';
  await schedule(deps, parseScheduleArgs(['--in', '1h', '/review-pr', '17741']));
  assert.deepEqual(backend.writes, []);
  assert.ok(printed.some((line) => line.startsWith('old is already running; the start time was not applied')));
});

test('--every and --cron repeat; --times or --until end the repeat; --in and --at set the first run', () => {
  const every = parseScheduleArgs(['--every', '2h', '--times', '5', 'x'], NOW);
  assert.deepEqual([every.every, every.times, every.cron, every.until], [2 * 3_600_000, 5, undefined, undefined]);
  const cron = parseScheduleArgs(['--cron', '0 9 * * 1-5', '--until', '2027-06-01', 'x'], NOW);
  assert.deepEqual(
    [cron.cron, cron.every, cron.until?.getTime()],
    ['0 9 * * 1-5', undefined, new Date(2027, 5, 1).getTime()],
  );
  const first = parseScheduleArgs(['--in', '2h', '--every', '2h', 'x'], NOW);
  assert.equal(first.notBefore?.getTime(), NOW.getTime() + 2 * 3_600_000);
  assert.equal(parseScheduleArgs(['--every', '1h', 'x'], NOW).notBefore, undefined);
});

test('repeat flags that cannot go together, or are malformed, are usage errors', () => {
  const bad = (flags: string[], message: RegExp) =>
    assert.throws(() => parseScheduleArgs([...flags, 'x'], NOW), message, flags.join(' '));
  bad(['--every', '1h', '--cron', '0 9 * * *'], /--every and --cron cannot be combined/);
  bad(['--times', '3'], /end a repeat; add --every or --cron/);
  bad(['--until', '2027-01-01'], /end a repeat/);
  bad(['--every', '1h', '--times', '2', '--until', '2027-01-01'], /--times and --until cannot be combined/);
  bad(['--every', '1h', '--hold'], /cannot be combined with --hold or --backlog/);
  bad(['--cron', '0 9 * * *', '--backlog'], /cannot be combined with --hold or --backlog/);
  bad(['--every', '1h', '--times', '0'], /positive whole number/);
  bad(['--every', '1h', '--times', '2.5'], /positive whole number/);
  bad(['--every', '1h', '--times', 'two'], /positive whole number/);
  bad(['--every', 'often'], /not a duration/);
  bad(['--cron', '0 9 * *'], /5 fields/);
  bad(['--cron', '0 0 9 * * *'], /5 fields/);
  bad(['--every', '1h', '--until', '2020-01-01'], /in the past/);
  bad(['--every', '1h', '--in', '3h', '--until', '11:00'], /--until is before the first run/);
  assert.throws(() => parseScheduleArgs(['--every'], NOW), /argument missing/);
  bad(['--every', '1h', '--in', '1h', '--at', '14:30'], /--in and --at cannot be combined/);
});

test('a repeat creates a schedule bound to this machine, skips the duplicate check and names the first run', async () => {
  const { deps, backend, printed, asked } = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  const created = (
    await schedule(
      deps,
      parseScheduleArgs(
        ['--priority', 'high', '--in', '1h', '--every', '2h', '--times', '3', '/review-pr', '17741'],
        NOW,
      ),
    )
  )?.task;
  assert.deepEqual(asked, [], 'no duplicate check');
  assert.equal(created?.scheduleId, 'sched');
  assert.equal(backend.writes.length, 1);
  assert.ok(backend.writes[0]?.startsWith('add-schedule /review-pr 17741 | /review-pr 17741 | 7200000 | start '));
  assert.ok(backend.writes[0]?.endsWith('| times 3 | here:/work/cosuno'));
  assert.equal(printed.length, 1);
  assert.match(
    printed[0] ?? '',
    /^scheduled repeat sched: every 2h, 3 runs; first run \d{4}-\d{2}-\d{2} \d{2}:\d{2} https:\/\/board\.test\/t\/pending$/,
  );
});

test('a cron repeat sends the machine time zone and says nothing about duplicates', async () => {
  const { deps, backend, printed } = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  await schedule(deps, parseScheduleArgs(['--cron', '0 9 * * 1-5', 'daily', 'sweep'], NOW));
  assert.ok(backend.writes[0]?.includes('| 0 9 * * 1-5 Europe/Berlin'));
  assert.match(printed[0] ?? '', /^scheduled repeat sched: cron 0 9 \* \* 1-5 \(Europe\/Berlin\);/);
  assert.ok(!printed.some((line) => line.includes('Looks like')));
});

test('--model is checked and sent for a plain task and for a repeat', async () => {
  assert.equal(parseScheduleArgs(['--model', 'opus', 'x']).model, 'opus');
  assert.equal(parseScheduleArgs(['--model', 'claude-sonnet-5-5[1m]', 'x']).model, 'claude-sonnet-5-5[1m]');
  assert.equal(parseScheduleArgs(['x']).model, undefined);
  for (const bad of ['--x', 'a b', 'opus;ls', ''])
    assert.throws(() => parseScheduleArgs(['--model', bad, 'x']), /is not a model name|argument missing/, bad);

  const plain = setup(undefined);
  const created = (await schedule(plain.deps, parseScheduleArgs(['--model', 'haiku', '--new', '/sweep'])))?.task;
  assert.equal(created?.model, 'haiku');
  const none = setup(undefined);
  assert.equal((await schedule(none.deps, parseScheduleArgs(['--new', '/sweep'])))?.task.model, null);

  const repeat = setup(undefined);
  const first = (await schedule(repeat.deps, parseScheduleArgs(['--model', 'fable', '--every', '2h', '/sweep'], NOW)))
    ?.task;
  assert.equal(first?.model, 'fable');
  assert.ok(repeat.backend.writes[0]?.endsWith('| here:/work/cosuno | model fable'));
});

test('a requeue keeps the existing task model and says --model was not applied', async () => {
  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  await schedule(requeue.deps, parseScheduleArgs(['--model', 'opus', '/review-pr', '17741']));
  assert.ok(requeue.printed.includes('old keeps its model (the default); --model applies only to a new task'));
  assert.ok(!requeue.backend.writes.some((w) => w.startsWith('create')));
});

test('--polish parks the task in Backlog; it cannot be combined with what keeps a task out of Backlog', () => {
  const args = parseScheduleArgs(['--polish', 'rough', 'idea']);
  assert.deepEqual([args.polish, args.backlog, args.hold, args.prompt], [true, true, false, 'rough idea']);
  assert.equal(parseScheduleArgs(['--polish', '--backlog', 'x']).backlog, true);
  for (const flags of [
    ['--hold'],
    ['--in', '2h'],
    ['--at', '09:30'],
    ['--every', '2h'],
    ['--cron', '0 9 * * 1-5'],
    ['--every', '2h', '--times', '3'],
  ])
    assert.throws(
      () => parseScheduleArgs(['--polish', ...flags, 'x']),
      new RegExp(`--polish .* cannot be combined with .*${flags[0]}`),
    );
  assert.throws(() => parseScheduleArgs(['--polish', '--until', '2099-01-01', 'x']), /--polish .* --until/);
});

test('--polish creates the task in Backlog and a polish task for it, placed in the same machine and directory', async () => {
  const { deps, backend, printed } = setup(undefined);
  const drafts: TaskDraft[] = [];
  const addTask = backend.addTask.bind(backend);
  backend.addTask = async (draft) => {
    drafts.push(draft);
    const added = await addTask(draft);
    return { ...added, task: { ...added.task, id: `t${drafts.length}` } };
  };
  const scheduled = await schedule(
    deps,
    parseScheduleArgs(['--polish', '--priority', 'high', '--title', 'Postal codes', 'export', 'postal', 'codes']),
  );
  assert.equal(scheduled?.task.status, 'backlog');
  assert.equal(scheduled?.polish?.id, 't2');
  const expected = polishTask({
    id: 't1',
    title: 'Postal codes',
    priority: 'high',
    machine: 'here',
    workdir: '/work/cosuno',
  });
  assert.deepEqual(drafts[1], {
    title: 'Polish prompt: Postal codes',
    input: expected.input,
    priority: 'high',
    parentId: 't1',
    createdBy: 'user',
    machine: 'here',
    workdir: '/work/cosuno',
  });
  assert.equal(drafts[1]?.status, undefined, 'the polish task runs from Todo');
  assert.match(drafts[1]?.input ?? '', /board polish t1 /);
  assert.ok(printed.some((line) => line === 'queued polish t2 https://board.test/t/t2'));
});

test('--polish queues no polish when the duplicate is requeued or the schedule dropped', async () => {
  const dup = { taskId: 'old', reason: 'same PR' };
  const requeue = setup(dup, 'requeue');
  const again = await schedule(requeue.deps, parseScheduleArgs(['--polish', '/review-pr', '17741']));
  assert.equal(again?.polish, undefined);
  assert.ok(requeue.backend.writes.includes('status old -> backlog'));
  assert.ok(!requeue.backend.writes.some((w) => w.startsWith('create')));
  assert.ok(requeue.printed.some((line) => line.startsWith('no polish queued for old')));

  const abort = setup(dup, 'abort');
  assert.equal(await schedule(abort.deps, parseScheduleArgs(['--polish', '/review-pr', '17741'])), undefined);
  assert.deepEqual(abort.backend.writes, []);
});
