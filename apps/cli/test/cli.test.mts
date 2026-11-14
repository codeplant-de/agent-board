import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { add, main, move, parseAddArgs, parseStatus, readNoteFile, renderThread } from '../src/board.mts';
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
