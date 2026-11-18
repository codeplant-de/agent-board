import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendError } from '../backend/backend.mts';
import type { Note, Task } from '@agent-board/shared';
import { FakeClock, openStream } from '../__tests__/helpers/stream.mts';
import { note, task } from '../__tests__/helpers/fakes.mts';
import { matchesFilter } from './diff.mts';
import type { BoardEvent, EventFilter } from './diff.mts';
import { EVENTS_OPTIONS, runEvents } from './run.mts';
import type { EventsTarget } from './run.mts';

type Plan = ReturnType<typeof openStream> | Response | Error;

const ALL_FEATURES = new Set(['events', 'task.note-count']);

function harness(
  options: {
    tasks?: Task[];
    plans?: Plan[];
    features?: ReadonlySet<string>;
    filter?: EventFilter;
    verify?: () => Promise<EventsTarget>;
  } = {},
) {
  const clock = new FakeClock();
  const log: string[] = [];
  const out: BoardEvent[] = [];
  const stop = new AbortController();
  const board = {
    tasks: options.tasks ?? [],
    threads: new Map<string, Note[]>(),
    answers: new Map<string, Task | Error>(),
    lists: 0,
    // When set, listTasks waits for the test to release it.
    hold: undefined as (() => void) | undefined,
    failList: undefined as Error | undefined,
    pipe: false,
  };
  const plans = [...(options.plans ?? [])];
  const done = runEvents({
    timers: clock,
    random: () => 1,
    log: (line) => log.push(line),
    signal: stop.signal,
    verify:
      options.verify ??
      (async () => ({ url: 'https://board.example', token: 'abm_x', features: options.features ?? ALL_FEATURES })),
    fetch: async () => {
      const next = plans.shift();
      if (next === undefined) throw new Error('no more plans');
      if (next instanceof Error) throw next;
      return 'response' in next ? next.response : next;
    },
    backend: {
      listTasks: async () => {
        board.lists += 1;
        if (board.failList !== undefined) throw board.failList;
        const snapshot = board.tasks.map((t) => ({ ...t }));
        if (board.hold !== undefined) await new Promise<void>((resolve) => (board.hold = resolve));
        return snapshot;
      },
      getTask: async (id) => {
        const answer = board.answers.get(id);
        if (answer instanceof Error) throw answer;
        if (answer === undefined) throw new Error(`unexpected getTask ${id}`);
        return answer;
      },
      readNotes: async (id) => board.threads.get(id) ?? [],
    },
    filter: options.filter ?? { tasks: [], statuses: [], types: [], actors: [] },
    emit: (event) => {
      if (board.pipe) throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      out.push(event);
    },
    now: () => new Date(clock.now()),
  });
  return { clock, log, out, stop, board, done };
}

const ids = (events: BoardEvent[]): string[] => events.map((event) => `${event.type} ${event.task.id}`);

test('the first listing is the baseline and prints nothing; the connection is announced on the log', async () => {
  const stream = openStream();
  const { clock, log, out, board, stop, done } = harness({ tasks: [task({ id: 'a' })], plans: [stream] });
  await clock.advance(0);
  assert.equal(board.lists, 1);
  assert.deepEqual(out, []);
  assert.deepEqual(log, ['connected']);
  stop.abort();
  assert.equal(await done, 0);
});

test('a tasks event refreshes after the debounce; a burst shares one refresh', async () => {
  const stream = openStream();
  const { clock, out, board, stop, done } = harness({ tasks: [task({ id: 'a' })], plans: [stream] });
  await clock.advance(0);
  board.tasks = [task({ id: 'a', status: 'needs-me' })];
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(200);
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(299);
  assert.equal(board.lists, 1, 'the window is 300 ms from the last event that started it');
  await clock.advance(1);
  assert.equal(board.lists, 2);
  assert.deepEqual(ids(out), ['moved a']);
  assert.equal(out[0]?.at.getTime(), 500, 'the time this CLI saw it');
  stop.abort();
  await done;
});

test('a comment or a ping does not refresh', async () => {
  const stream = openStream();
  const { clock, board, stop, done } = harness({ tasks: [task({ id: 'a' })], plans: [stream] });
  await clock.advance(0);
  stream.push(': ping\n\n');
  await clock.advance(1000);
  assert.equal(board.lists, 1);
  stop.abort();
  await done;
});

test('a signal during a refresh sets a flag and one more refresh follows; refreshes never overlap', async () => {
  const stream = openStream();
  const { clock, out, board, stop, done } = harness({ tasks: [task({ id: 'a' })], plans: [stream] });
  await clock.advance(0);
  board.hold = () => undefined;
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  assert.equal(board.lists, 2, 'the refresh is under way');
  board.tasks = [task({ id: 'a', status: 'running' })];
  stream.push('event: tasks\ndata:\n\nevent: tasks\ndata:\n\n');
  await clock.advance(1000);
  assert.equal(board.lists, 2, 'nothing starts while one is running');
  const release = board.hold;
  board.hold = undefined;
  release?.();
  await clock.advance(0);
  assert.equal(board.lists, 3, 'one more, not two');
  assert.deepEqual(ids(out), ['moved a']);
  stop.abort();
  await done;
});

test('a reconnect refreshes, so what changed while the stream was down is found', async () => {
  const first = openStream();
  const second = openStream();
  const { clock, out, board, log, stop, done } = harness({ tasks: [task({ id: 'a' })], plans: [first, second] });
  await clock.advance(0);
  board.tasks = [task({ id: 'a' }), task({ id: 'b' })];
  first.end();
  await clock.advance(0);
  assert.equal(board.lists, 1);
  await clock.advance(1000);
  assert.deepEqual(ids(out), ['created b']);
  assert.deepEqual(log, [
    'connected',
    'disconnected: the board closed the stream',
    'reconnecting in 1.0 s',
    'connected',
  ]);
  stop.abort();
  await done;
});

test('the fallback timer lists the board again every two minutes, also without any event', async () => {
  const stream = openStream();
  const { clock, out, board, stop, done } = harness({
    tasks: [task({ id: 'a', status: 'done' })],
    plans: [stream],
  });
  await clock.advance(0);
  board.tasks = [];
  board.answers.set('a', task({ id: 'a', status: 'done', closed: true }));
  await clock.advance(EVENTS_OPTIONS.pollMs - 1);
  assert.equal(board.lists, 1);
  await clock.advance(1);
  assert.equal(board.lists, 2);
  assert.deepEqual(ids(out), ['closed a']);
  await clock.advance(EVENTS_OPTIONS.pollMs);
  assert.equal(board.lists, 3);
  stop.abort();
  await done;
});

test('nothing is read before the stream was open once, and a stream that cannot be had is retried', async () => {
  const { clock, out, board, log, stop, done } = harness({ tasks: [task({ id: 'a' })], plans: [] });
  await clock.advance(0);
  assert.equal(board.lists, 0, 'nothing is read before the stream was open once');
  assert.ok(log.some((line) => line.startsWith('disconnected')));
  stop.abort();
  assert.equal(await done, 0);
  assert.deepEqual(out, []);
});

test('a task that left: closed, deleted, or one this CLI cannot read', async () => {
  const stream = openStream();
  const { clock, out, board, stop, done } = harness({
    tasks: [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' }), task({ id: 'd' })],
    plans: [stream],
  });
  await clock.advance(0);
  board.tasks = [task({ id: 'd' })];
  board.answers.set('a', task({ id: 'a', closed: true }));
  board.answers.set('b', new BackendError('get-task: no task b', 404, true));
  board.answers.set('c', new BackendError('this task uses status "x"', 422, true));
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  assert.deepEqual(ids(out), ['closed a', 'removed b']);
  board.tasks = [];
  board.answers.set('d', task({ id: 'd', closed: true }));
  await clock.advance(EVENTS_OPTIONS.pollMs);
  assert.deepEqual(ids(out), ['closed a', 'removed b', 'closed d'], 'c was dropped for good');
  stop.abort();
  await done;
});

test('new notes are events, oldest first', async () => {
  const stream = openStream();
  const { clock, out, board, stop, done } = harness({ tasks: [task({ id: 'a', noteCount: 1 })], plans: [stream] });
  await clock.advance(0);
  board.tasks = [task({ id: 'a', noteCount: 3 })];
  board.threads.set('a', [note('old', new Date(1)), note('new one', new Date(2)), note('new two', new Date(3))]);
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  assert.deepEqual(
    out.map((event) => event.note?.text),
    ['new one', 'new two'],
  );
  stop.abort();
  await done;
});

test('a board without task.note-count works without note events and says so once', async () => {
  const first = openStream();
  const second = openStream();
  const features = new Set(['events']);
  const { clock, out, board, log, stop, done } = harness({
    tasks: [task({ id: 'a' })],
    plans: [first, second],
    features,
  });
  await clock.advance(0);
  board.tasks = [task({ id: 'a', status: 'running' })];
  board.threads.set('a', [note('never read', new Date(1))]);
  first.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  assert.deepEqual(ids(out), ['moved a']);
  first.end();
  await clock.advance(2000);
  assert.equal(log.filter((line) => line.includes('task.note-count')).length, 1);
  stop.abort();
  await done;
});

test('the filter only decides what is printed: the snapshot holds the whole board', async () => {
  const stream = openStream();
  const filter: EventFilter = { tasks: [], statuses: ['needs-me'], types: ['moved'], actors: [] };
  const { clock, out, board, stop, done } = harness({
    tasks: [task({ id: 'a' }), task({ id: 'b' })],
    plans: [stream],
    filter,
  });
  await clock.advance(0);
  board.tasks = [task({ id: 'a', status: 'running' }), task({ id: 'b', status: 'needs-me' }), task({ id: 'c' })];
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  assert.deepEqual(ids(out), ['moved b']);
  board.tasks = [task({ id: 'a', status: 'needs-me' }), task({ id: 'b', status: 'needs-me' }), task({ id: 'c' })];
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  assert.deepEqual(
    ids(out),
    ['moved b', 'moved a'],
    'a was running in the snapshot although nothing was printed for it',
  );
  assert.ok(out.every((event) => matchesFilter(event, filter)));
  stop.abort();
  await done;
});

test('a board that cannot be read is said once, and the next refresh finds what changed meanwhile', async () => {
  const stream = openStream();
  const { clock, out, board, log, stop, done } = harness({ tasks: [task({ id: 'a' })], plans: [stream] });
  await clock.advance(0);
  board.failList = new Error('fetch failed');
  board.tasks = [task({ id: 'a', status: 'running' })];
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  assert.equal(log.filter((line) => line.startsWith('cannot read the board')).length, 1);
  board.failList = undefined;
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  assert.deepEqual(ids(out), ['moved a']);
  assert.ok(log.includes('the board can be read again'));
  stop.abort();
  await done;
});

test('a refused token ends with 1, on the stream and on a listing', async () => {
  const refusedStream = harness({ plans: [new Response('{"error":"revoked"}', { status: 401 })] });
  assert.equal(await refusedStream.done, 1);
  assert.match(refusedStream.log.join('\n'), /refused the token \(401\)/);
  const stream = openStream();
  const refusedList = harness({ plans: [stream] });
  await refusedList.clock.advance(0);
  refusedList.board.failList = new BackendError('list-tasks: HTTP 401', 401, true);
  stream.push('event: tasks\ndata:\n\n');
  await refusedList.clock.advance(300);
  assert.equal(await refusedList.done, 1);
  assert.match(refusedList.log.join('\n'), /refused the token \(401\)/);
});

test('a CLI older than the board ends with 1; a board without the stream is waited for', async () => {
  const older = new BackendError('this CLI is older than the board server', undefined);
  older.contractMismatch = 'cli-older';
  const tooOld = harness({
    verify: async () => {
      throw older;
    },
  });
  assert.equal(await tooOld.done, 1);
  assert.deepEqual(tooOld.log, ['this CLI is older than the board server']);

  const missing = new BackendError('the board server does not support the event stream yet; update the board server');
  missing.missingFeature = 'events';
  const waiting = harness({
    verify: async () => {
      throw missing;
    },
  });
  await waiting.clock.advance(30_000);
  assert.equal(waiting.log.filter((line) => line.includes('event stream')).length, 1, 'said once per state');
  waiting.stop.abort();
  assert.equal(await waiting.done, 0);
});

test('a closed stdout ends quietly with 0, and nothing is read afterwards', async () => {
  const stream = openStream();
  const { clock, out, board, log, done } = harness({ tasks: [task({ id: 'a' })], plans: [stream] });
  await clock.advance(0);
  board.pipe = true;
  board.tasks = [task({ id: 'a', status: 'running' }), task({ id: 'b' })];
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  assert.equal(await done, 0);
  assert.deepEqual(out, []);
  assert.deepEqual(log, ['connected']);
  const lists = board.lists;
  await clock.advance(EVENTS_OPTIONS.pollMs * 2);
  assert.equal(board.lists, lists);
});

test('an interrupt ends with 0 even in the middle of a refresh', async () => {
  const stream = openStream();
  const { clock, out, board, stop, done } = harness({ tasks: [task({ id: 'a' })], plans: [stream] });
  await clock.advance(0);
  board.hold = () => undefined;
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  stop.abort();
  const release = board.hold;
  board.hold = undefined;
  release?.();
  assert.equal(await done, 0);
  assert.deepEqual(out, []);
});
