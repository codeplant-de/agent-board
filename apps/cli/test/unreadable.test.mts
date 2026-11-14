import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNREADABLE_TITLE } from '@agent-board/shared';
import type { Context } from '../src/cli.mts';
import { runBoard } from '../src/commands.mts';
import { resolveTaskId } from '../src/ids.mts';
import { CONFIG, fakeBackend, note, schedule, task } from './helpers.mts';

const SEALED_ELSEWHERE = task({
  id: 'Un0pen01',
  title: UNREADABLE_TITLE,
  input: '',
  unreadable: ['title', 'input'],
  status: 'todo',
});
const READABLE = task({ id: 'Re4dab1e', title: 'Fix the thing', status: 'todo' });

function setup() {
  const backend = fakeBackend([SEALED_ELSEWHERE, READABLE]);
  backend.schedules = [
    schedule({ id: 'Sc0pen01', title: UNREADABLE_TITLE, input: '', unreadable: ['title', 'input'] }),
  ];
  backend.notes.set('Un0pen01', [
    note('', new Date('2026-11-13T10:00:00Z'), { unreadable: true }),
    note('readable', new Date('2026-11-13T10:01:00Z')),
  ]);
  const printed: string[] = [];
  const out: string[] = [];
  const go = (argv: string[]) =>
    runBoard(argv, {
      env: {},
      context: (): Context => ({ config: CONFIG, backend, dryRun: false, print: (line) => printed.push(line) }),
      writeOut: (text) => out.push(text),
    });
  return { backend, printed, out, go };
}

test('the tasks table says which fields it could not decrypt', async () => {
  const { printed, go } = setup();
  await go(['tasks']);
  assert.ok(printed.includes(`  Un0pen01  normal  ${UNREADABLE_TITLE}  (cannot decrypt: title, input)`));
  assert.ok(printed.includes('  Re4dab1e  normal  Fix the thing'));
});

test('--json lists unreadable fields and gives them as null, never as the placeholder', async () => {
  const { out, go } = setup();
  await go(['tasks', '--json']);
  const list = JSON.parse(out.join('')) as {
    id: string;
    title: string | null;
    input: string | null;
    unreadable: string[];
  }[];
  const closed = list.find((item) => item.id === 'Un0pen01');
  assert.deepEqual([closed?.title, closed?.input, closed?.unreadable], [null, null, ['title', 'input']]);
  assert.equal(list.find((item) => item.id === 'Re4dab1e')?.title, 'Fix the thing');
  assert.ok(!out.join('').includes(UNREADABLE_TITLE));

  out.length = 0;
  await go(['show', 'Un0pen01', '--json']);
  const shown = JSON.parse(out.join('')) as {
    task: { title: string | null; unreadable: string[] };
    notes: { text: string | null; unreadable: boolean }[];
  };
  assert.deepEqual([shown.task.title, shown.task.unreadable], [null, ['title', 'input']]);
  assert.deepEqual(
    shown.notes.map((entry) => [entry.text, entry.unreadable]),
    [
      [null, true],
      ['readable', false],
    ],
  );
  assert.ok(!out.join('').includes(UNREADABLE_TITLE));

  out.length = 0;
  await go(['schedules', '--json']);
  const schedules = JSON.parse(out.join('')) as { title: string | null; unreadable: string[] }[];
  assert.deepEqual([schedules[0]?.title, schedules[0]?.unreadable], [null, ['title', 'input']]);
});

test('the schedules list marks what it could not decrypt', async () => {
  const { printed, go } = setup();
  await go(['schedules']);
  assert.ok(printed.some((line) => line.endsWith(`${UNREADABLE_TITLE}  (cannot decrypt: title, input)`)));
});

test('an ambiguous prefix lists the candidates, the unreadable one with its placeholder', async () => {
  const backend = fakeBackend([SEALED_ELSEWHERE, task({ id: 'Un0pen02', title: 'Readable one' })]);
  await assert.rejects(resolveTaskId(backend, 'Un0', { inRun: false }), (error: Error) => {
    assert.match(error.message, new RegExp(`Un0pen01  ${UNREADABLE_TITLE.replace(/[()]/g, '\\$&')}`));
    assert.match(error.message, /Un0pen02 {2}Readable one/);
    return true;
  });
});

test('__complete offers an unreadable task with its placeholder as the description', async () => {
  const { out, go } = setup();
  await go(['__complete', 'tasks']);
  assert.deepEqual(out, [`Un0pen01\t${UNREADABLE_TITLE}\n`, 'Re4dab1e\tFix the thing\n']);
});

test('show prints the placeholder text for an unreadable input and note', async () => {
  const { printed, go } = setup();
  await go(['show', 'Un0pen01']);
  const text = printed.join('\n');
  assert.match(text, /^# \(cannot decrypt this title\)/);
  assert.match(text, /cannot decrypt/i);
});
