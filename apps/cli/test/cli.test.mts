import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  add,
  delay,
  tasks,
  main,
  move,
  parseAddArgs,
  parseDelayArgs,
  parseStatus,
  readNoteFile,
  renderThread,
} from '../src/board.mts';
import { BackendError } from '../src/backend.mts';
import type { Context } from '../src/cli.mts';
import { CONFIG, fakeBackend, note, task } from './helpers.mts';
import { rejectExtraArgs, takeFlag, UsageError } from '../src/cli.mts';

test('leftover arguments are a usage error, so a typo never becomes a real run', () => {
  const args = ['--dryrun'];
  assert.equal(takeFlag(args, '--dry-run'), false);
  assert.throws(() => rejectExtraArgs(args, 'usage: dispatch [--dry-run]'), UsageError);
  const ok = ['--dry-run'];
  takeFlag(ok, '--dry-run');
  assert.doesNotThrow(() => rejectExtraArgs(ok, 'usage'));
});

test('board move takes the human status names as well as the neutral ones', () => {
  assert.equal(parseStatus('Needs me'), 'needs-me');
  assert.equal(parseStatus('needs-me'), 'needs-me');
  assert.equal(parseStatus('Todo'), 'todo');
  assert.equal(parseStatus('Running'), 'running');
  assert.equal(parseStatus('Done'), 'done');
  assert.equal(parseStatus('Backlog'), 'backlog');
  assert.throws(() => parseStatus('Someday'), UsageError);
});

test('a note file is read only from /tmp, without following links', () => {
  const dir = mkdtempSync('/tmp/pr-note-test-');
  const secret = join(mkdtempSync(join(homedir(), '.agent-board-test-')), 'secret');
  try {
    writeFileSync(secret, 'TOKEN=1');
    writeFileSync(join(dir, 'note.md'), '  findings\n');
    assert.equal(readNoteFile(join(dir, 'note.md')), 'findings');
    symlinkSync(secret, join(dir, 'link.md'));
    assert.throws(() => readNoteFile(join(dir, 'link.md')), UsageError);
    symlinkSync(dirname(secret), join(dir, 'linkdir'));
    assert.throws(() => readNoteFile(join(dir, 'linkdir', 'secret')), /must be inside \/tmp\//);
    assert.throws(() => readNoteFile(secret), /must be inside \/tmp\//);
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(1024 * 1024 + 1));
    assert.throws(() => readNoteFile(join(dir, 'big.md')), /at most 1 MiB/);
    assert.throws(() => readNoteFile(join(dir, 'missing.md')), /cannot read/);
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(dirname(secret), { recursive: true });
  }
});

test('board add takes its flags in any order and refuses a missing one', () => {
  assert.deepEqual(parseAddArgs(['--file', '/tmp/x.md', '--title', 'Fix it', '--parent', 'abc']), {
    title: 'Fix it',
    file: '/tmp/x.md',
    parent: 'abc',
    priority: undefined,
  });
  assert.equal(parseAddArgs(['--title', 't', '--file', '/tmp/x', '--priority', 'high']).priority, 'high');
  assert.throws(
    () => parseAddArgs(['--title', 't', '--file', '/tmp/x', '--priority', 'asap']),
    /unknown priority "asap"/,
  );
  assert.equal(parseAddArgs(['--title', 't', '--file', '/tmp/x']).parent, undefined);
  assert.throws(() => parseAddArgs(['--title', 't']), UsageError);
  assert.throws(() => parseAddArgs(['--title', 't', '--file', '/tmp/x', '--parent', '../x']), UsageError);
  assert.throws(() => parseAddArgs(['--title', 't', '--title', 'u', '--file', '/tmp/x']), UsageError);
  assert.throws(
    () => parseAddArgs(['--label', 'l', '--title', 't', '--file', '/tmp/x']),
    UsageError,
    'labels are gone; the prompt names its skill',
  );
});

test('board show renders questions and answers in the thread', () => {
  const question = note('', new Date('2026-11-13T10:00:00Z'), {
    kind: 'question',
    questions: [
      {
        header: 'Scope',
        question: 'Include tests?',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'all of them', recommended: true },
          { label: 'No', description: '' },
        ],
      },
    ],
  });
  const answer = note('thanks', new Date('2026-11-13T10:01:00Z'), {
    author: 'user',
    kind: 'answer',
    questionNoteId: question.id,
    answers: [{ selected: ['Yes'] }],
  });
  const text = renderThread(task({ id: 'a', title: 'T', input: 'do it' }), [answer, question]);
  assert.match(text, /^# T/);
  assert.match(text, /- \*\*Scope\*\*: Include tests\?\n {2}- Yes \(recommended\): all of them/);
  assert.match(text, /### user answer[^\n]*\n\n- Scope: Include tests\? → Yes\nthanks/);
  assert.ok(text.indexOf('agent question') < text.indexOf('user answer'), 'oldest first');
});

test('board schedule refuses inside a board run', async () => {
  await assert.rejects(
    main(['schedule', '/grill the plan'], { AGENT_BOARD_TASK: 'abc' }),
    /not available inside a board run; use `board add`/,
  );
  await assert.rejects(main(['schedule', '--hold', 'x'], { AGENT_BOARD_TASK: 'abc' }), UsageError);
});

test('board add sends no status: the board puts a proposal in Needs me itself', async () => {
  const backend = fakeBackend([]);
  const drafts: unknown[] = [];
  backend.addTask = async (draft) => {
    drafts.push(draft);
    return { task: task({ id: 'p1' }), created: true };
  };
  const context: Context = { config: CONFIG, backend, dryRun: false, print: () => undefined };
  const dir = mkdtempSync('/tmp/pr-add-test-');
  try {
    writeFileSync(join(dir, 'p.md'), 'do the thing');
    await add(context, ['--title', 'Do it', '--file', join(dir, 'p.md'), '--parent', 'abc']);
  } finally {
    rmSync(dir, { recursive: true });
  }
  assert.equal(drafts.length, 1);
  assert.ok(!('status' in (drafts[0] as object)));
  assert.equal((drafts[0] as { createdBy: string }).createdBy, 'agent');
});

test('board move on a proposal says so in one plain line', async () => {
  const backend = fakeBackend([task({ id: 'p1' })]);
  backend.updateTask = async () => {
    throw new BackendError('update-task: An agent proposed this task; only you start it.', 403);
  };
  const context: Context = { config: CONFIG, backend, dryRun: false, print: () => undefined };
  await assert.rejects(
    move(context, 'p1', 'todo'),
    (error: Error) =>
      error instanceof UsageError &&
      error.message === 'p1 is a proposal: only the user can start it. Leave it in Needs me.',
  );
  backend.updateTask = async () => {
    throw new BackendError('update-task: no task x', 404);
  };
  await assert.rejects(move(context, 'p1', 'todo'), BackendError);
});

test('board delay takes --in, --at or --now and nothing else', () => {
  const now = new Date(2026, 10, 14, 10, 0, 0);
  assert.equal(parseDelayArgs(['--in', '3h'], now)?.getTime(), now.getTime() + 3 * 3_600_000);
  assert.equal(parseDelayArgs(['--at', '2027-01-01T12:00'], now)?.getTime(), new Date(2027, 0, 1, 12).getTime());
  assert.equal(parseDelayArgs(['--now'], now), null);
  for (const bad of [[], ['--in'], ['--now', 'x'], ['--in', '1h', '--at', '09:00'], ['3h'], ['--every', '1h']])
    assert.throws(() => parseDelayArgs(bad, now), /usage: board comment/, bad.join(' '));
  assert.throws(() => parseDelayArgs(['--in', '0h'], now), /longer than zero/);
  assert.throws(() => parseDelayArgs(['--at', '2020-01-01'], now), /in the past/);
});

test('board delay patches notBefore on a Todo task, and --now clears it', async () => {
  const backend = fakeBackend([task({ id: 'd1' })]);
  const printed: string[] = [];
  const context: Context = { config: CONFIG, backend, dryRun: false, print: (line) => printed.push(line) };
  await delay(context, 'd1', ['--in', '2h']);
  assert.ok(backend.tasks[0]?.notBefore && backend.tasks[0].notBefore.getTime() > Date.now());
  assert.ok(printed[0]?.startsWith('d1 starts '));
  await delay(context, 'd1', ['--now']);
  assert.equal(backend.tasks[0]?.notBefore, null);
  assert.deepEqual(printed.at(-1), 'd1 is due now');
  backend.tasks[0]!.status = 'running';
  await assert.rejects(delay(context, 'd1', ['--in', '1h']), BackendError);
});

test('board tasks shows when a delayed task starts', async () => {
  const backend = fakeBackend([task({ id: 'w1', notBefore: new Date(Date.now() + 3_600_000) }), task({ id: 'p1' })]);
  const printed: string[] = [];
  const context: Context = { config: CONFIG, backend, dryRun: false, print: (line) => printed.push(line) };
  await tasks(context);
  assert.ok(printed.some((line) => line.includes('task w1') && /\(starts \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/.test(line)));
  assert.ok(printed.some((line) => line.endsWith('task p1')));
});
