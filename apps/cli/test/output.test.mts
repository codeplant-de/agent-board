import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatTasks } from '../src/board.mts';
import { UsageError } from '../src/cli.mts';
import type { Context } from '../src/cli.mts';
import { runBoard } from '../src/commands.mts';
import type { ProgramOptions } from '../src/commands.mts';
import { haikuDuplicateCheck } from '../src/schedule.mts';
import { createStyle, wantsColor } from '../src/style.mts';
import { CONFIG, fakeBackend, note, schedule, task } from './helpers.mts';

const ID = 'Zt0Test1';

function setup(overrides: Partial<Context> = {}) {
  const backend = fakeBackend([
    task({ id: ID, title: 'Fix the thing', priority: 'high', status: 'needs-me' }),
    task({ id: 'Ab3dEf9x', title: 'Another', status: 'todo' }),
    task({ id: 'Cl0sedXx', title: 'Old', status: 'done', closed: true }),
  ]);
  const printed: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  for (const name of ['listTasks', 'getTask', 'listSchedules'] as const) {
    const original = backend[name] as (...args: unknown[]) => Promise<unknown>;
    (backend as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls.push(name);
      return original.apply(backend, args);
    };
  }
  const go = (argv: string[], options: ProgramOptions = {}, dryRun = false) =>
    runBoard(argv, {
      env: {},
      context: (_dry, contextOptions) => ({
        config: CONFIG,
        backend,
        dryRun,
        print: contextOptions.print ?? ((line) => printed.push(line)),
        boardUrl: () => 'https://board.example',
        ...overrides,
      }),
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      ...options,
    });
  return { backend, printed, out, err, calls, go };
}

test('tasks aligns its columns, has no labels column and marks delayed and closed tasks', async () => {
  const { printed, go, backend } = setup();
  backend.tasks[1]!.notBefore = new Date('2027-01-01T12:00:00');
  await go(['tasks', '--all']);
  assert.deepEqual(printed.slice(0, 2), ['backlog (0)', 'todo (1)']);
  assert.match(printed[2] ?? '', /^ {2}Ab3dEf9x {2}normal {2}Another {2}\(starts 2027-01-01 12:00\)$/);
  assert.ok(printed.includes('  Zt0Test1  high    Fix the thing'));
  assert.ok(printed.includes('  Cl0sedXx  normal  Old  (closed)'));
  assert.ok(printed.every((line) => !line.includes('[')));
});

test('tasks hides closed tasks without --all and takes --status in any spelling', async () => {
  const { printed, go } = setup();
  await go(['tasks', '--status', 'Needs me']);
  assert.deepEqual(printed, ['needs-me (1)', '  Zt0Test1  high  Fix the thing']);
  printed.length = 0;
  await go(['tasks']);
  assert.ok(!printed.some((line) => line.includes('Cl0sedXx')));
  await assert.rejects(go(['tasks', '--status', 'someday']), UsageError);
});

test('colour is bold headers and dim hints, and only when asked for', () => {
  const found = [task({ id: 'a1b2c3d4', closed: true })];
  const plain = formatTasks(found, {}, createStyle(false)).join('\n');
  assert.ok(!plain.includes('\x1b'));
  const coloured = formatTasks(found, {}, createStyle(true)).join('\n');
  assert.ok(coloured.includes('\x1b[1mtodo (1)\x1b[22m'));
  assert.ok(coloured.includes('\x1b[2m  (closed)\x1b[22m'));
  assert.equal(wantsColor({ isTTY: true }, {}), true);
  assert.equal(wantsColor({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(wantsColor({ isTTY: false }, {}), false);
  assert.equal(wantsColor({}, {}), false);
});

test('board tasks in a context without colour prints no escape codes', async () => {
  const { printed, go } = setup();
  await go(['tasks']);
  assert.ok(printed.every((line) => !line.includes('\x1b')));
});

test('--json puts only the document on stdout', async () => {
  const { out, err, printed, backend, go } = setup();
  backend.schedules = [schedule({ id: 'Sc1aBcDe' })];
  backend.notes.set(ID, [note('hello', new Date('2026-11-13T10:00:00Z'))]);

  await go(['tasks', '--json']);
  const list = JSON.parse(out.join('')) as { id: string; labels?: unknown; input?: unknown }[];
  assert.deepEqual(
    list.map((item) => item.id),
    [ID, 'Ab3dEf9x'],
  );
  assert.ok(!('labels' in list[0]!));

  out.length = 0;
  await go(['show', ID, '--json']);
  const shown = JSON.parse(out.join('')) as { task: { id: string }; notes: { text: string }[] };
  assert.equal(shown.task.id, ID);
  assert.equal(shown.notes[0]?.text, 'hello');

  out.length = 0;
  await go(['schedules', '--json']);
  assert.equal((JSON.parse(out.join('')) as { id: string }[])[0]?.id, 'Sc1aBcDe');
  await assert.rejects(go(['schedules', '--json', 'rm', 'Sc1aBcDe']), /only prints the list/);

  out.length = 0;
  await go(['schedule', '--json', '--new', 'Do', 'it']);
  assert.deepEqual(JSON.parse(out.join('')), { id: 'new', url: 'https://tasks.example/new' });
  assert.match(err.join(''), /scheduled new/);
  assert.deepEqual(printed, []);
  assert.equal(out.join('').trim().startsWith('{'), true);
});

test('add --json prints {id, url} and keeps the human line off stdout', async () => {
  const { out, err, backend, go } = setup();
  const dir = mkdtempSync('/tmp/board-output-test-');
  try {
    writeFileSync(join(dir, 'p.md'), 'follow up');
    backend.addTask = async () => ({ task: task({ id: 'p1234567' }), created: true });
    await go(['add', '--json', '--title', 't', '--file', join(dir, 'p.md')]);
  } finally {
    rmSync(dir, { recursive: true });
  }
  assert.deepEqual(JSON.parse(out.join('')), { id: 'p1234567', url: 'https://tasks.example/p1234567' });
  assert.match(err.join(''), /proposed p1234567/);
});

test('comment, move and notify confirm in one line with the task link', async () => {
  const { printed, calls, go } = setup();
  await go(['comment', ID, 'some', 'text']);
  await go(['move', ID, 'Needs', 'me']);
  assert.deepEqual(printed, [
    `commented on ${ID}  https://board.example/t/${ID}`,
    `moved ${ID} to needs-me  https://tasks.example/${ID}`,
  ]);
  assert.deepEqual(calls, [], 'a full id and a confirmation cost no extra request');
});

test('comment without a known board URL confirms without a link, and a dry run confirms nothing', async () => {
  const { printed, go } = setup({ boardUrl: () => '' });
  await go(['comment', ID, 'x']);
  assert.deepEqual(printed, [`commented on ${ID}`]);
  printed.length = 0;
  await go(['comment', ID, 'x'], {}, true);
  await go(['move', ID, 'todo'], {}, true);
  assert.deepEqual(printed, []);
});

test('notify and ask confirm after the Slack post', async () => {
  const dir = mkdtempSync('/tmp/board-output-test-');
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => response.end('ok'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const hook = join(dir, 'webhook');
    writeFileSync(hook, `http://127.0.0.1:${port}/hook\n`);
    chmodSync(hook, 0o600);
    writeFileSync(
      join(dir, 'q.json'),
      JSON.stringify({
        questions: [
          {
            header: 'Q',
            question: 'Which?',
            multiSelect: false,
            options: [
              { label: 'A', description: '' },
              { label: 'B', description: '' },
            ],
          },
        ],
      }),
    );
    const { printed, go } = setup({ config: { ...CONFIG, slackWebhookFile: hook } });
    await go(['notify', ID, 'hello']);
    await go(['ask', ID, '--file', join(dir, 'q.json')]);
    assert.deepEqual(printed, [
      `notified about ${ID}  https://tasks.example/${ID}`,
      `asked 1 question on ${ID}, now in needs-me  https://tasks.example/${ID}`,
    ]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true });
  }
});

test('commands resolve a task prefix or link, and inside a run take the id as typed', async () => {
  const { backend, calls, go } = setup();
  await go(['comment', 'ab3d', 'hi']);
  await go(['move', 'https://board.example/t/Ab3dEf9x', 'done']);
  await go(['show', 'zt0']);
  assert.deepEqual(backend.writes.slice(0, 2), ['note Ab3dEf9x: hi', 'status Ab3dEf9x -> done']);
  assert.equal(calls.filter((call) => call === 'listTasks').length, 2);
  calls.length = 0;
  backend.writes.length = 0;
  await go(['comment', 'Zt0', 'hi'], { env: { AGENT_BOARD_TASK: ID } });
  assert.deepEqual(backend.writes, ['note Zt0: hi']);
  assert.deepEqual(calls, []);
});

test('add --parent and schedules pause take a prefix too', async () => {
  const { backend, go } = setup();
  backend.schedules = [schedule({ id: 'Sc1aBcDe' })];
  await go(['schedules', 'pause', 'sc1']);
  assert.deepEqual(backend.writes, ['pause-schedule Sc1aBcDe']);
  const dir = mkdtempSync('/tmp/board-output-test-');
  try {
    writeFileSync(join(dir, 'p.md'), 'x');
    const drafts: { parentId?: string }[] = [];
    backend.addTask = async (draft) => {
      drafts.push(draft);
      return { task: task({ id: 'p1234567' }), created: true };
    };
    await go(['add', '--title', 't', '--file', join(dir, 'p.md'), '--parent', 'ab3d']);
    assert.equal(drafts[0]?.parentId, 'Ab3dEf9x');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('help lists the new flags and the id shortcuts', async () => {
  const { out, go } = setup();
  await go(['help', 'tasks']);
  assert.match(out.join(''), /--all[\s\S]*--status <status>[\s\S]*--json/);
  out.length = 0;
  await go(['help', 'comment']);
  assert.match(out.join(''), /start of the\s+id \(3\+ characters/);
  out.length = 0;
  await go(['help', 'schedule']);
  assert.match(out.join(''), /--json/);
});

test('the duplicate check says it is running before it calls the model, and only when it does', async () => {
  const dir = mkdtempSync('/tmp/board-output-test-');
  const path = process.env['PATH'];
  try {
    writeFileSync(
      join(dir, 'claude'),
      '#!/bin/sh\ncat >/dev/null\necho \'{"structured_output":{"duplicate":false,"taskId":null,"reason":""}}\'\n',
      { mode: 0o755 },
    );
    process.env['PATH'] = `${dir}:${path}`;
    const said: string[] = [];
    const check = haikuDuplicateCheck(
      () => undefined,
      (line) => said.push(line),
    );
    assert.equal(await check('prompt', '/work', []), undefined);
    assert.deepEqual(said, []);
    assert.equal(await check('prompt', '/work', [task({ id: 'abc12345' })]), undefined);
    assert.deepEqual(said, ['checking for duplicates…']);
  } finally {
    process.env['PATH'] = path;
    rmSync(dir, { recursive: true });
  }
});
