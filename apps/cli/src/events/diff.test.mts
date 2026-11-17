import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendError } from '../backend/backend.mts';
import { note, task } from '../__tests__/helpers/fakes.mts';
import { changedFields, diffTasks, matchesFilter } from './diff.mts';
import type { BoardEvent, DiffDeps, EventFilter } from './diff.mts';
import type { Note, Task } from '@agent-board/shared';

const AT = new Date('2027-01-01T12:00:00Z');
const LATER = new Date('2027-01-01T12:05:00Z');

interface Board {
  threads: Map<string, Note[]>;
  gone: Map<string, Task | Error>;
  reads: string[];
}

function deps(board: Partial<Board> = {}): DiffDeps & Board {
  const full: Board = { threads: new Map(), gone: new Map(), reads: [], ...board };
  return {
    ...full,
    at: AT,
    readNotes: async (id) => {
      full.reads.push(id);
      return full.threads.get(id) ?? [];
    },
    getTask: async (id) => {
      const answer = full.gone.get(id);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`unexpected getTask ${id}`);
      return answer;
    },
  };
}

const summary = (events: BoardEvent[]): string[] =>
  events.map((event) =>
    [event.type, event.task.id, event.from, event.to, event.fields?.join('+'), event.note?.text]
      .filter((part) => part !== undefined)
      .join(' '),
  );

test('a task that was not there is created, also one that was reopened', async () => {
  const events = await diffTasks([task({ id: 'a' })], [task({ id: 'a' }), task({ id: 'b' })], deps());
  assert.deepEqual(summary(events), ['created b']);
  assert.equal(events[0]?.status, 'todo');
});

test('a changed status is a move with from and to, and the event holds the new task', async () => {
  const events = await diffTasks([task({ id: 'a', status: 'todo' })], [task({ id: 'a', status: 'needs-me' })], deps());
  assert.deepEqual(summary(events), ['moved a todo needs-me']);
  assert.equal(events[0]?.status, 'needs-me');
  assert.equal(events[0]?.task.status, 'needs-me');
});

test('each watched field is a change, and only those', () => {
  const base = task({ id: 'a' });
  const changes: Partial<Task>[] = [
    { title: 'other' },
    { priority: 'high' },
    { model: 'opus' },
    { agent: 'reviewer' },
    { machine: 'laptop' },
    { openQuestion: true },
    { notBefore: LATER },
    { wakeAt: LATER },
    { prs: [{ id: 'p1', url: 'https://github.com/a/b/pull/1', state: null }] },
    { promptPrState: 'merged' },
  ];
  const names = [
    'title',
    'priority',
    'model',
    'agent',
    'machine',
    'openQuestion',
    'notBefore',
    'wakeAt',
    'prs',
    'promptPrState',
  ];
  changes.forEach((change, index) => assert.deepEqual(changedFields(base, { ...base, ...change }), [names[index]]));
  assert.deepEqual(
    changedFields(
      { ...base, prs: [{ id: 'p1', url: 'u', state: null }] },
      { ...base, prs: [{ id: 'p1', url: 'u', state: 'merged' }] },
    ),
    ['prs'],
  );
  assert.deepEqual(changedFields({ ...base, notBefore: LATER }, { ...base, notBefore: new Date(LATER) }), []);
});

test('the volatile fields are not events', async () => {
  const before = task({ id: 'a', status: 'running' });
  const after: Task = {
    ...before,
    lastActiveAt: LATER,
    lane: 'general',
    borrowed: true,
    runStartedAt: LATER,
    run: 'r1',
    sessionId: 'abcdefab-0000-4000-8000-000000000000',
    workdir: '/tmp/x',
    paused: true,
    woken: true,
    stopRequested: true,
    next: 'resume',
    waitCheck: true,
    input: 'new prompt',
    labels: ['x'],
    head: 'abh1.x',
    unreadable: ['workdir'],
    scheduleId: 's1',
    createdBy: 'agent',
  };
  assert.deepEqual(await diffTasks([before], [after], deps()), []);
});

test('a move and a field change in one look give a moved and a changed, in that order', async () => {
  const events = await diffTasks(
    [task({ id: 'a', status: 'todo' })],
    [task({ id: 'a', status: 'running', machine: 'laptop', priority: 'high' })],
    deps(),
  );
  assert.deepEqual(summary(events), ['moved a todo running', 'changed a priority+machine']);
});

test('todo, running and needs-me between two looks is one move from todo to needs-me', async () => {
  const events = await diffTasks([task({ id: 'a', status: 'todo' })], [task({ id: 'a', status: 'needs-me' })], deps());
  assert.deepEqual(summary(events), ['moved a todo needs-me']);
});

test('a task that left and is closed is a closed event with the task the board answered', async () => {
  const closed = task({ id: 'a', status: 'done', closed: true, title: 'final' });
  const events = await diffTasks([task({ id: 'a', status: 'needs-me' })], [], deps({ gone: new Map([['a', closed]]) }));
  assert.deepEqual(summary(events), ['closed a']);
  assert.equal(events[0]?.task.title, 'final');
  assert.equal(events[0]?.status, 'needs-me', 'the last status seen');
});

test('a task the board no longer has is removed, with the last task seen', async () => {
  const last = task({ id: 'a', title: 'last seen' });
  const gone = new BackendError('get-task: no task a', 404, true);
  const events = await diffTasks([last], [], deps({ gone: new Map([['a', gone]]) }));
  assert.deepEqual(summary(events), ['removed a']);
  assert.equal(events[0]?.task, last);
});

test('a task this CLI cannot read, or one that is still open, leaves without an event', async () => {
  const refused = new BackendError('this task uses status "x"', 422, true);
  const stillOpen = task({ id: 'b' });
  const events = await diffTasks(
    [task({ id: 'a' }), task({ id: 'b' })],
    [],
    deps({
      gone: new Map<string, Task | Error>([
        ['a', refused],
        ['b', stillOpen],
      ]),
    }),
  );
  assert.deepEqual(events, []);
});

test('an error that may pass (no network, a 5xx) fails the diff, so the old listing stays', async () => {
  for (const error of [
    new Error('fetch failed'),
    new BackendError('get-task: HTTP 502', 502, true),
    new BackendError('x', 404, false),
  ])
    await assert.rejects(diffTasks([task({ id: 'a' })], [], deps({ gone: new Map([['a', error]]) })), error);
});

test('only a task whose note count grew has its thread read, and only the new notes are events', async () => {
  const thread = [note('one', AT), note('two', AT), note('three', AT)];
  const board = deps({ threads: new Map([['a', thread]]) });
  const events = await diffTasks(
    [task({ id: 'a', noteCount: 1 }), task({ id: 'b', noteCount: 4 })],
    [task({ id: 'a', noteCount: 3 }), task({ id: 'b', noteCount: 4 })],
    board,
  );
  assert.deepEqual(summary(events), ['note a two', 'note a three']);
  assert.deepEqual(board.reads, ['a']);
});

test('a task that enters the list, new or reopened, is created without its earlier notes', async () => {
  const board = deps({ threads: new Map([['a', [note('first', AT), note('second', AT)]]]) });
  const events = await diffTasks([], [task({ id: 'a', noteCount: 2 }), task({ id: 'b', noteCount: 0 })], board);
  assert.deepEqual(summary(events), ['created a', 'created b']);
  assert.deepEqual(board.reads, []);
  const reopened = await diffTasks(
    [task({ id: 'x' })],
    [task({ id: 'x' }), task({ id: 'a', noteCount: 2, closed: false })],
    board,
  );
  assert.deepEqual(summary(reopened), ['created a']);
});

test('a note written between the listing and the read is reported by the next refresh, once', async () => {
  const thread = [note('one', AT), note('two', AT), note('three', AT)];
  const board = deps({ threads: new Map([['a', thread]]) });
  const first = await diffTasks([task({ id: 'a', noteCount: 1 })], [task({ id: 'a', noteCount: 2 })], board);
  assert.deepEqual(summary(first), ['note a two']);
  const next = await diffTasks([task({ id: 'a', noteCount: 2 })], [task({ id: 'a', noteCount: 3 })], board);
  assert.deepEqual(summary(next), ['note a three']);
});

test('without a note count there are no note events, and a count that first appears is no news', async () => {
  const board = deps({ threads: new Map([['a', [note('x', AT)]]]) });
  assert.deepEqual(await diffTasks([task({ id: 'a' })], [task({ id: 'a' })], board), []);
  assert.deepEqual(await diffTasks([task({ id: 'a' })], [task({ id: 'a', noteCount: 5 })], board), []);
  assert.deepEqual(await diffTasks([], [task({ id: 'z' })], board).then(summary), ['created z']);
  assert.deepEqual(board.reads, []);
});

test('a note this CLI cannot open is still an event (its text is empty)', async () => {
  const board = deps({ threads: new Map([['a', [note('', AT, { unreadable: true })]]]) });
  const events = await diffTasks([task({ id: 'a', noteCount: 0 })], [task({ id: 'a', noteCount: 1 })], board);
  assert.equal(events[0]?.note?.text, '');
  assert.equal(events[0]?.note?.unreadable, true);
});

test('the order is the list order; per task created, notes, moved, changed; then the tasks that left', async () => {
  const board = deps({
    threads: new Map([['b', [note('hello', AT)]]]),
    gone: new Map([['x', task({ id: 'x', closed: true })]]),
  });
  const events = await diffTasks(
    [task({ id: 'x' }), task({ id: 'b', status: 'todo', noteCount: 0 }), task({ id: 'a', status: 'todo' })],
    [
      task({ id: 'c', noteCount: 1 }),
      task({ id: 'b', status: 'needs-me', priority: 'high', noteCount: 1 }),
      task({ id: 'a', status: 'todo', title: 'renamed' }),
    ],
    { ...board, readNotes: async (id) => (id === 'c' ? [note('on c', AT)] : [note('hello', AT)]) },
  );
  assert.deepEqual(summary(events), [
    'created c',
    'note b hello',
    'moved b todo needs-me',
    'changed b priority',
    'changed a title',
    'closed x',
  ]);
  assert.ok(events.every((event) => event.at === AT));
});

const FILTER: EventFilter = { tasks: [], statuses: [], types: [] };
const moved = (to: Task['status'], overrides: Partial<Task> = {}): BoardEvent => ({
  type: 'moved',
  at: AT,
  task: task({ id: 'a', status: to, ...overrides }),
  status: to,
  from: 'todo',
  to,
});

test('an empty filter passes everything; each flag narrows, all of them together', () => {
  assert.ok(matchesFilter(moved('needs-me'), FILTER));
  assert.ok(matchesFilter(moved('needs-me'), { ...FILTER, tasks: ['a', 'z'] }));
  assert.ok(!matchesFilter(moved('needs-me'), { ...FILTER, tasks: ['z'] }));
  assert.ok(matchesFilter(moved('needs-me'), { ...FILTER, statuses: ['waiting', 'needs-me'] }));
  assert.ok(!matchesFilter(moved('running'), { ...FILTER, statuses: ['needs-me'] }));
  assert.ok(matchesFilter(moved('needs-me'), { ...FILTER, types: ['moved'] }));
  assert.ok(!matchesFilter(moved('needs-me'), { ...FILTER, types: ['note', 'created'] }));
  assert.ok(matchesFilter(moved('needs-me', { machine: 'laptop' }), { ...FILTER, machine: 'laptop' }));
  assert.ok(!matchesFilter(moved('needs-me', { machine: 'other' }), { ...FILTER, machine: 'laptop' }));
  assert.ok(!matchesFilter(moved('needs-me'), { ...FILTER, machine: 'laptop' }));
  assert.ok(!matchesFilter(moved('needs-me'), { tasks: ['a'], statuses: ['needs-me'], types: ['created'] }));
});

test('--status matches the last status seen for a closed task', () => {
  const closed: BoardEvent = {
    type: 'closed',
    at: AT,
    task: task({ id: 'a', status: 'done', closed: true }),
    status: 'needs-me',
  };
  assert.ok(matchesFilter(closed, { ...FILTER, statuses: ['needs-me'] }));
  assert.ok(!matchesFilter(closed, { ...FILTER, statuses: ['done'] }));
});
