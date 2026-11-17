import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNREADABLE_TEXT } from '@agent-board/shared';
import { note, task } from '../__tests__/helpers/fakes.mts';
import { createStyle } from '../output/style.mts';
import type { BoardEvent } from './diff.mts';
import { eventJson, eventLine } from './format.mts';

const AT = new Date(2027, 0, 1, 14, 2, 11);
const plain = createStyle(false);
const link = (id: string): string => `https://board.example/t/${id}`;

const event = (overrides: Partial<BoardEvent> & { type: BoardEvent['type'] }): BoardEvent => {
  const t = overrides.task ?? task({ id: 'Ab3dEf9x', title: 'Fix the export' });
  return { at: AT, task: t, status: t.status, ...overrides };
};

test('a line has the time, the type, the id, what happened and the title', () => {
  assert.equal(
    eventLine(event({ type: 'moved', from: 'todo', to: 'needs-me' }), plain),
    '14:02:11  moved    Ab3dEf9x      todo → needs-me  Fix the export',
  );
  assert.equal(eventLine(event({ type: 'created' }), plain), '14:02:11  created  Ab3dEf9x      todo  Fix the export');
  assert.equal(
    eventLine(event({ type: 'changed', fields: ['priority', 'machine'] }), plain),
    '14:02:11  changed  Ab3dEf9x      priority, machine  Fix the export',
  );
  assert.equal(eventLine(event({ type: 'closed' }), plain), '14:02:11  closed   Ab3dEf9x      closed  Fix the export');
  assert.equal(
    eventLine(event({ type: 'removed' }), plain),
    '14:02:11  removed  Ab3dEf9x      deleted  Fix the export',
  );
});

test('a note shows its author and kind and the first line of its text, cut', () => {
  const text = `\n\nfirst line ${'x'.repeat(200)}\nsecond line`;
  const line = eventLine(event({ type: 'note', note: note(text, AT, { kind: 'question' }) }), plain);
  assert.match(line, /^14:02:11 {2}note {5}Ab3dEf9x {6}agent question {2}Fix the export {2}"first line x+…"$/);
  assert.ok(!line.includes('second'));
  assert.ok(line.length < 200);
});

test('a note that cannot be opened says so instead of showing nothing', () => {
  const line = eventLine(event({ type: 'note', note: note('', AT, { unreadable: true }) }), plain);
  assert.ok(line.endsWith(`"${UNREADABLE_TEXT}"`));
});

test('control characters from the board never reach the terminal', () => {
  const hostile = task({ id: 'Ab3dEf9x', title: 'a\u001b[2Jb\nfake  moved  line\u0007' });
  const line = eventLine(
    event({ type: 'note', task: hostile, note: note('x\u001b]0;pwn\u0007y\r\nz', AT, { author: 'user' }) }),
    plain,
  );
  const controls = Array.from(line).filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
  assert.deepEqual(controls, [], JSON.stringify(line));
  assert.ok(line.includes('␛'));
  assert.equal(line.split('\n').length, 1);
});

test('colour only when the style has it', () => {
  const coloured = eventLine(event({ type: 'created' }), createStyle(true));
  assert.ok(coloured.includes('\u001b['));
  assert.ok(!eventLine(event({ type: 'created' }), plain).includes('\u001b['));
});

test('json: type, time, the task as `board tasks --json` shows it plus its url, and the extras of the type', () => {
  const unread = task({ id: 'Ab3dEf9x', title: '(cannot decrypt this title)', unreadable: ['title'], input: 'secret' });
  const json = eventJson(event({ type: 'moved', task: unread, from: 'todo', to: 'done' }), link);
  assert.deepEqual(Object.keys(json), ['type', 'at', 'task', 'from', 'to']);
  assert.equal(json['at'], AT.toISOString());
  assert.deepEqual(JSON.parse(JSON.stringify(json))['task'].title, null);
  assert.equal((json['task'] as { url: string }).url, 'https://board.example/t/Ab3dEf9x');
  assert.equal((json['task'] as { input: string }).input, 'secret');
});

test('json: fields and note', () => {
  assert.deepEqual(eventJson(event({ type: 'changed', fields: ['title'] }), link)['fields'], ['title']);
  const n = note('hello', new Date('2027-01-01T10:00:00Z'), { id: 'n1', kind: 'comment', author: 'agent' });
  assert.deepEqual(eventJson(event({ type: 'note', note: n }), link)['note'], {
    id: 'n1',
    author: 'agent',
    kind: 'comment',
    text: 'hello',
    createdAt: '2027-01-01T10:00:00.000Z',
    unreadable: false,
  });
  const unread = note('', AT, { unreadable: true });
  const unreadJson = eventJson(event({ type: 'note', note: unread }), link)['note'] as {
    text: string;
    unreadable: boolean;
  };
  assert.equal(unreadJson.text, null);
  assert.equal(unreadJson.unreadable, true);
});

test('json is a single line even when the title holds a line break', () => {
  const line = JSON.stringify(
    eventJson(event({ type: 'created', task: task({ id: 'a1b2c3d4', title: 'x\ny' }) }), link),
  );
  assert.ok(!line.includes('\n'));
});
