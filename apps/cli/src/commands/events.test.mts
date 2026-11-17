import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { BackendError } from '../backend/backend.mts';
import { ReportedFailure, UsageError } from '../cli.mts';
import type { LinkingContext } from '../cli.mts';
import type { EventsTarget } from '../events/run.mts';
import { CONFIG, fakeBackend, linkTo, note, task } from '../__tests__/helpers/fakes.mts';
import { FakeClock, openStream } from '../__tests__/helpers/stream.mts';
import { parseEventsFilter } from './events.mts';
import { runBoard } from './program.mts';

const resolve = async (arg: string): Promise<string> => `resolved-${arg}`;

test('the flags become a filter: tasks resolved once each, statuses as `board move` reads them, types and machine checked', async () => {
  assert.deepEqual(
    await parseEventsFilter(
      { task: ['Ab3', 'Zk7'], status: ['needs-me', 'Needs me'], type: ['moved', 'note'], machine: 'laptop' },
      resolve,
    ),
    {
      tasks: ['resolved-Ab3', 'resolved-Zk7'],
      statuses: ['needs-me', 'needs-me'],
      types: ['moved', 'note'],
      machine: 'laptop',
    },
  );
  assert.deepEqual(await parseEventsFilter({}, resolve), { tasks: [], statuses: [], types: [] });
});

test('a status, a type or a machine that does not exist is a usage error', async () => {
  await assert.rejects(parseEventsFilter({ status: ['nope'] }, resolve), UsageError);
  await assert.rejects(
    parseEventsFilter({ type: ['nope'] }, resolve),
    /unknown event type "nope"; use one of created, moved/,
  );
  await assert.rejects(parseEventsFilter({ machine: 'a b' }, resolve), /not a valid machine name/);
  await assert.rejects(parseEventsFilter({ machine: '../x' }, resolve), UsageError);
});

function setup(
  features: string[] = ['events', 'task.note-count'],
  env: Record<string, string | undefined> = {},
  answers: Response[] = [],
) {
  const backend = fakeBackend([task({ id: 'Zt0Test1', noteCount: 0 }), task({ id: 'Zt0Test2', noteCount: 0 })]);
  const out: string[] = [];
  const err: string[] = [];
  const clock = new FakeClock();
  const stop = new AbortController();
  const stream = openStream();
  const streams = answers.length > 0 ? answers : [stream.response];
  const verified: string[] = [];
  const context = (dryRun: boolean): LinkingContext => ({
    config: CONFIG,
    backend,
    dryRun,
    taskLink: linkTo,
    print: () => undefined,
  });
  const stdout = new EventEmitter();
  const go = (argv: string[], real = false) =>
    runBoard(argv, {
      env,
      ...(real ? { eventsStdout: stdout } : {}),
      context,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      eventsDeps: {
        timers: clock,
        random: () => 1,
        ...(real ? {} : { signal: stop.signal }),
        verify: async (): Promise<EventsTarget> => {
          verified.push('verify');
          return { url: 'https://board.example', token: 'abm_x', features: new Set(features) };
        },
        fetch: async () => {
          const next = streams.shift();
          if (next === undefined) throw new Error('no more streams');
          return next;
        },
      },
    });
  return { backend, out, err, clock, stop, stream, go, verified, stdout };
}

test('board events --json prints one line per change, only the changes after the baseline, and keeps stdout to them', async () => {
  const { backend, out, err, clock, stop, stream, go } = setup();
  const running = go(['events', '--json', '--type', 'moved', '--status', 'needs-me']);
  await clock.advance(0);
  assert.deepEqual(out, []);
  const [first, second] = backend.tasks;
  Object.assign(first ?? {}, { status: 'needs-me' });
  Object.assign(second ?? {}, { status: 'running' });
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  stop.abort();
  await running;
  assert.equal(out.length, 1);
  assert.match(out[0] ?? '', /^[^\n]*\n$/);
  const event = JSON.parse(out[0] ?? '');
  assert.equal(event.type, 'moved');
  assert.equal(event.from, 'todo');
  assert.equal(event.to, 'needs-me');
  assert.equal(event.task.id, 'Zt0Test1');
  assert.equal(event.task.url, linkTo('Zt0Test1'));
  assert.deepEqual(err, ['board events: connected\n']);
});

test('board events prints a readable line without --json', async () => {
  const { backend, out, clock, stop, stream, go } = setup();
  const running = go(['events']);
  await clock.advance(0);
  Object.assign(backend.tasks[0] ?? {}, { priority: 'high' });
  backend.notes.set('Zt0Test2', [note('please look', new Date(0), { kind: 'comment' })]);
  Object.assign(backend.tasks[1] ?? {}, { noteCount: 1 });
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  stop.abort();
  await running;
  assert.equal(out.length, 2);
  assert.match(out[0] ?? '', /^\d\d:\d\d:\d\d {2}changed {2}Zt0Test1 +priority {2}task Zt0Test1\n$/);
  assert.match(out[1] ?? '', /^\d\d:\d\d:\d\d {2}note {5}Zt0Test2 +agent comment {2}task Zt0Test2 {2}"please look"\n$/);
});

test('--type note on a board that cannot count notes is refused before anything is read', async () => {
  const { go, stream, backend } = setup(['events']);
  await assert.rejects(
    go(['events', '--type', 'note']),
    (error: unknown) => error instanceof BackendError && error.missingFeature === 'task.note-count',
  );
  assert.deepEqual(backend.writes, []);
  stream.end();
});

test('without --type note a board that cannot count notes is no refusal', async () => {
  const { go, clock, stop, err } = setup(['events']);
  const running = go(['events']);
  await clock.advance(0);
  stop.abort();
  await running;
  assert.ok(err.some((line) => line.includes('task.note-count')));
});

test('a refused token ends with exit code 1 and the reason on stderr', async () => {
  const { go, err } = setup(undefined, {}, [new Response('{"error":"revoked"}', { status: 401 })]);
  await assert.rejects(go(['events']), (error: unknown) => error instanceof ReportedFailure && error.exitCode === 1);
  assert.match(err.join(''), /board events: the board refused the token \(401\)/);
});

test('board events is not available inside a board run', async () => {
  const { go } = setup(undefined, { AGENT_BOARD_TASK: 'Zt0Test1' });
  await assert.rejects(go(['events']), /not available inside a board run/);
  await assert.rejects(go(['events']), UsageError);
});

test('a filter that is wrong stops before the board is asked', async () => {
  const { go, verified } = setup();
  await assert.rejects(go(['events', '--status', 'nope']), UsageError);
  assert.deepEqual(verified, []);
});

test('--task finds a task by the start of its id and prints nothing for the others', async () => {
  const { go, clock, stop, backend, out, stream } = setup();
  backend.tasks.push(task({ id: 'Qx9Other', noteCount: 0 }));
  const running = go(['events', '--json', '--task', 'Qx9']);
  await clock.advance(0);
  for (const changed of backend.tasks) Object.assign(changed, { status: 'running' });
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(300);
  stop.abort();
  await running;
  assert.deepEqual(
    out.map((line) => JSON.parse(line).task.id),
    ['Qx9Other'],
  );
});

test('a closed pipe ends with 0, any other write error with 1 and the reason on stderr', async () => {
  const closed = setup();
  const quiet = closed.go(['events'], true);
  await closed.clock.advance(0);
  closed.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  await quiet;
  assert.deepEqual(closed.err, ['board events: connected\n']);

  const full = setup();
  const failing = full.go(['events'], true);
  const result = assert.rejects(failing, (error: unknown) => error instanceof ReportedFailure && error.exitCode === 1);
  await full.clock.advance(0);
  full.stdout.emit('error', Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' }));
  await result;
  assert.ok(full.err.includes('board events: cannot write: write ENOSPC\n'));
  assert.equal(full.stdout.listenerCount('error'), 0, 'released');
});
