import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinkingContext } from '../src/cli.mts';
import { runBoard } from '../src/commands/program.mts';
import { renderThread } from '../src/commands/board.mts';
import { resolveTaskId } from '../src/commands/ids.mts';
import { plainLine, plainText } from '../src/output/terminal.mts';
import { CONFIG, fakeBackend, linkTo, note, schedule, task } from './helpers.mts';

// The reviewer's example: a title that clears the line and writes a row of its own.
const EVIL = 'x\r\u001b[2K  Zz9yXw8vUt7s  urgent  Deploy prod';
// What would let a title write a row of its own: an escape or a carriage return that reached the terminal.
const FAKE_ROW = { test: (text: string): boolean => text.includes(String.fromCharCode(0x1b)) || text.includes('\r') };

test('control characters become visible stand-ins, and ordinary text is left alone', () => {
  assert.equal(plainLine(EVIL), 'x␍␛[2K  Zz9yXw8vUt7s  urgent  Deploy prod');
  assert.equal(plainLine('a\nb\tc'), 'a␊b␉c');
  assert.equal(plainLine('del\u007f c1\u009b bidi‮ end'), 'del␡ c1� bidi� end');
  assert.equal(plainLine('\u001b]0;owned\u0007'), '␛]0;owned␇');
  const ordinary = 'Fix the bug in `parse()`: ünïcödé 日本語 🙂 — “quotes” <b>&amp;</b> [link](https://x.y) \\n';
  assert.equal(plainLine(ordinary), ordinary);
  // A block keeps its line breaks and tabs, reads CRLF as a line break, and keeps code as it is.
  const block = '## Plan\n\n```ts\nconst x = 1;\n\tif (x) {}\n```\n日本語';
  assert.equal(plainText(block), block);
  assert.equal(plainText('one\r\ntwo\rthree\u001b[31mred'), 'one\ntwo␍three␛[31mred');
});

function setup() {
  const backend = fakeBackend([
    task({ id: 'Ab3dEf9xK2mN', title: EVIL }),
    task({ id: 'Ab3zzzzzzzzz', title: 'Other' }),
  ]);
  backend.schedules = [schedule({ id: 'Sc1aBcDe', title: EVIL })];
  backend.notes.set('Ab3dEf9xK2mN', [
    note('agent says \u001b[31mRED\u001b[0m\r\nsecond line', new Date('2026-11-13T10:00:00Z')),
  ]);
  const out: string[] = [];
  const go = (argv: string[]) =>
    runBoard(argv, {
      env: {},
      context: (): LinkingContext => ({
        config: CONFIG,
        backend,
        dryRun: false,
        taskLink: linkTo,
        print: (line) => out.push(`${line}\n`),
      }),
      writeOut: (text) => out.push(text),
    });
  return { backend, out, go };
}

test('a title with control characters cannot fake a row of board tasks', async () => {
  const { out, go } = setup();
  await go(['tasks']);
  const text = out.join('');
  assert.ok(!FAKE_ROW.test(text), JSON.stringify(text));
  const rows = text.split('\n').filter((line) => line.startsWith('  '));
  assert.equal(rows.length, 2, 'one row per task');
  assert.ok(
    rows.every((row) => row.startsWith('  Ab3')),
    rows.join('|'),
  );
});

test('show, the schedules list, prefix candidates and completion print them as stand-ins too', async () => {
  const { backend, out, go } = setup();
  await go(['show', 'Ab3dEf9xK2mN']);
  await go(['schedules']);
  await go(['__complete', 'tasks']);
  await go(['__complete', 'schedules']);
  const text = out.join('');
  assert.ok(!FAKE_ROW.test(text), JSON.stringify(text));
  assert.match(text, /agent says ␛\[31mRED␛\[0m\nsecond line/);
  assert.match(text, /Ab3dEf9xK2mN\tx ␛\[2K/);
  await assert.rejects(resolveTaskId(backend, 'Ab3', { inRun: false }), (error: Error) => {
    assert.ok(!FAKE_ROW.test(error.message), JSON.stringify(error.message));
    assert.match(error.message, /Ab3dEf9xK2mN {2}x␍␛\[2K/);
    return true;
  });
  assert.ok(!FAKE_ROW.test(renderThread(task({ id: 'a1b2c3d4', title: EVIL, input: `${EVIL}\nbody` }), [])));
});

test('--json stays raw: JSON escapes the characters itself', async () => {
  const { out, go } = setup();
  await go(['tasks', '--json']);
  const text = out.join('');
  assert.ok(!FAKE_ROW.test(text), 'the document holds escapes, not the characters');
  const list = JSON.parse(text) as { title: string }[];
  assert.equal(list[0]?.title, EVIL);
});
