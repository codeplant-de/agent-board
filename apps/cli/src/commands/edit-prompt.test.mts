import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { textBeforeEdit } from '@agent-board/shared';
import type { Schedule, Task } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import type { LinkingContext } from '../cli.mts';
import { CONFIG, fakeBackend, linkTo, schedule, task } from '../__tests__/helpers/fakes.mts';
import { runBoard } from './program.mts';
import type { ProgramOptions } from './program-shared.mts';

const ID = 'abc12345';

// The `board` program over a fake backend that holds `tasks` and `schedules`.
function runner(tasks: Task[], schedules: Schedule[] = []) {
  const backend = fakeBackend(tasks);
  backend.schedules.push(...schedules);
  const printed: string[] = [];
  const makeContext = (dryRun: boolean): LinkingContext => ({
    config: CONFIG,
    backend,
    dryRun,
    taskLink: linkTo,
    print: (line) => printed.push(line),
  });
  return {
    backend,
    printed,
    go: (argv: string[], overrides: ProgramOptions = {}) =>
      runBoard(argv, { env: {}, context: makeContext, writeOut: () => {}, writeErr: () => {}, ...overrides }),
  };
}

const noteTexts = (run: ReturnType<typeof runner>, id: string): string[] =>
  (run.backend.notes.get(id) ?? []).map((note) => note.text);

function promptFile(context: TestContext, text: string): string {
  const dir = mkdtempSync('/tmp/board-edit-prompt-test-');
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'prompt.md'), text);
  return join(dir, 'prompt.md');
}

test('set prompt takes the words after it, keeps the title, and keeps the old text in a note of the user’s', async () => {
  const run = runner([task({ id: ID, title: 'Old title', input: 'Old prompt' })]);
  await run.go(['task', ID, 'set', 'prompt', 'Find', 'out', 'why']);
  assert.deepEqual(run.backend.writes, [`edit-prompt ${ID}: Old title | Find out why`]);
  assert.deepEqual(noteTexts(run, ID), [textBeforeEdit({ title: 'Old title', input: 'Old prompt' })]);
  assert.deepEqual(run.printed, [`${ID} prompt updated; the old prompt is kept in a note on the task`]);
});

test('--title sets the title, an empty one is made from the prompt; - reads stdin and --file a file', async (context) => {
  const run = runner([task({ id: ID, title: 'Old title', input: 'Old prompt' })]);
  await run.go(['task', ID, 'set', 'prompt', '--title', 'New title', 'one']);
  await run.go(['task', ID, 'set', 'prompt', '-'], { readStdin: async () => ' two\nmore \n' });
  await run.go(['task', ID, 'set', 'prompt', '--title', '', 'three words']);
  await run.go(['task', ID, 'set', 'prompt', '--file', promptFile(context, 'from a file\n')]);
  assert.deepEqual(run.backend.writes, [
    `edit-prompt ${ID}: New title | one`,
    `edit-prompt ${ID}: New title | two\nmore`,
    `edit-prompt ${ID}: three words | three words`,
    `edit-prompt ${ID}: three words | from a file`,
  ]);
});

test('set prompt with the same title and prompt says so and writes nothing', async () => {
  const run = runner([task({ id: ID, title: 'T', input: 'same' })]);
  await run.go(['task', ID, 'set', 'prompt', ' same ']);
  assert.deepEqual(run.backend.writes, []);
  assert.deepEqual(run.printed, [`${ID} already has this title and prompt`]);
});

test('set prompt refuses what the board would, with the way out, before sending anything', async () => {
  const run = runner([
    task({ id: 'agent001', createdBy: 'agent' }),
    task({ id: 'occ00001', scheduleId: 's1' }),
    task({ id: 'start001', lastActiveAt: new Date() }),
    task({ id: 'sess0001', sessionId: 'session' }),
    task({ id: 'done0001', status: 'done' }),
    task({ id: 'closed01', status: 'backlog', closed: true }),
    task({ id: 'bad00001', unreadable: ['input'] }),
  ]);
  const refuse = (id: string, message: RegExp) => assert.rejects(run.go(['task', id, 'set', 'prompt', 'new']), message);
  await refuse('agent001', /only a task you created/);
  await refuse('occ00001', /board schedules edit/);
  await refuse('start001', /board comment/);
  await refuse('sess0001', /started/);
  await refuse('done0001', /it is done/);
  await refuse('closed01', /it is closed/);
  await refuse('bad00001', /cannot be decrypted/);
  await assert.rejects(run.go(['task', ID, 'set', 'prompt']), /text is missing/);
  assert.deepEqual(run.backend.writes, []);
});

test('--title and --file belong to set prompt, and a file excludes words; unset prompt is refused', async (context) => {
  const run = runner([task({ id: ID })]);
  await assert.rejects(run.go(['task', ID, 'set', 'priority', 'high', '--title', 'x']), /belong to .*set prompt/);
  await assert.rejects(run.go(['task', ID, '--file', '/tmp/x']), /belong to .*set prompt/);
  await assert.rejects(
    run.go(['task', ID, 'set', 'prompt', 'words', '--file', promptFile(context, 'x')]),
    /words or with --file, not both/,
  );
  await assert.rejects(run.go(['task', ID, 'unset', 'prompt']), /always has a prompt/);
});

test('--dry-run prints the write and confirms nothing; the server refusing is passed on', async () => {
  const run = runner([task({ id: ID, title: 'T', input: 'old' })]);
  await run.go(['task', ID, 'set', 'prompt', 'new', '--dry-run']);
  assert.ok(!run.printed.some((line) => line.includes('prompt updated')));
  run.backend.editPrompt = async () => {
    throw new BackendError('the board server does not support editing a prompt yet; update the board server');
  };
  await assert.rejects(run.go(['task', ID, 'set', 'prompt', 'newer']), /does not support editing a prompt/);
});

test('set prompt and schedules edit are refused inside a board run, which writes nothing', async (context) => {
  const run = runner([task({ id: ID })], [schedule({ id: 's1' })]);
  const env = { AGENT_BOARD_TASK: ID };
  const file = promptFile(context, 'x');
  for (const argv of [
    ['task', ID, 'set', 'prompt', 'new'],
    ['task', ID, 'set', 'prompt', '--file', file],
    ['schedules', 'edit', 's1', 'new'],
    ['schedules', 'edit', 's1', '--file', file],
  ])
    await assert.rejects(run.go(argv, { env }), /not available inside a board run/, argv.join(' '));
  assert.deepEqual(run.backend.writes, []);
});

test('schedules edit changes the prompt, keeps the title unless --title is given, and says what became of the pending card', async (context) => {
  const run = runner(
    [task({ id: 'pending', scheduleId: 's1' })],
    [schedule({ id: 's1', title: 'Sweep', input: '/sweep' })],
  );
  await run.go(['schedules', 'edit', 's1', '/sweep', 'more']);
  await run.go(['schedules', 'edit', 's1', '--title', 'Nightly', '--file', promptFile(context, 'from a file')]);
  assert.deepEqual(run.backend.writes, [
    'edit-schedule s1: Sweep | /sweep more',
    'edit-schedule s1: Nightly | from a file',
  ]);
  assert.deepEqual(run.printed, [
    's1 prompt updated. The pending card was updated too.',
    's1 prompt updated. The pending card was updated too.',
  ]);
  assert.deepEqual(
    run.backend.tasks.map((card) => [card.title, card.input]),
    [['Nightly', 'from a file']],
  );
});

test('schedules edit names the other two outcomes: a pending card that started, and none', async () => {
  const started = runner(
    [task({ id: 'pending', scheduleId: 's1', lastActiveAt: new Date() })],
    [schedule({ id: 's1' })],
  );
  await started.go(['schedules', 'edit', 's1', 'new']);
  assert.deepEqual(started.printed, [
    's1 prompt updated. The pending card has already started; the change applies from the next run.',
  ]);
  const none = runner([], [schedule({ id: 's1', occurrenceTaskId: null, paused: true })]);
  await none.go(['schedules', 'edit', 's1', 'new']);
  assert.deepEqual(none.printed, [
    's1 prompt updated. The schedule has no pending card; its next run takes the change.',
  ]);
});

test('schedules edit refuses an ended or unreadable schedule, an unknown one and a missing prompt, and an unchanged text writes nothing', async () => {
  const run = runner(
    [],
    [
      schedule({ id: 'ended001', ended: true }),
      schedule({ id: 'bad00001', unreadable: ['input'] }),
      schedule({ id: 'same0001', title: 'T', input: 'same' }),
    ],
  );
  await assert.rejects(run.go(['schedules', 'edit', 'ended001', 'new']), /has ended/);
  await assert.rejects(run.go(['schedules', 'edit', 'bad00001', 'new']), /cannot be decrypted/);
  await assert.rejects(run.go(['schedules', 'edit', 'nothere1', 'new']), /no schedule/);
  await assert.rejects(run.go(['schedules', 'edit', 'same0001']), /text is missing/);
  await assert.rejects(run.go(['schedules', 'pause', 'same0001', '--title', 'x']), /belong to .*edit/);
  await run.go(['schedules', 'edit', 'same0001', 'same']);
  assert.deepEqual(run.backend.writes, []);
  assert.deepEqual(run.printed, ['same0001 already has this title and prompt']);
});
