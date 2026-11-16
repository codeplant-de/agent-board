import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_VERSION, CLIENT_FEATURES_HEADER, MIN_SERVER } from '@agent-board/shared';
import { requireFeature, verifyContract } from '../src/backend/backend.mts';
import type { Fetch } from '../src/backend/backend.mts';
import {
  backoffMs,
  createSseParser,
  createTicker,
  LISTENER_OPTIONS,
  runListener,
  tickCommand,
} from '../src/dispatch/listen.mts';
import type { SseEvent, Timers } from '../src/dispatch/listen.mts';

// A clock that only moves when the test says so.
class FakeClock implements Timers {
  time = 0;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];

  now = (): number => this.time;
  after = (ms: number, fn: () => void): (() => void) => {
    const timer = { at: this.time + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  // Runs everything that falls due in the next `ms`, in order, letting promises settle after each.
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    await settle();
    for (;;) {
      const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.fn();
      await settle();
    }
    this.time = end;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function parse(chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  chunks.forEach(parser.push);
  return events;
}

test('the SSE parser reads events however the chunks fall, and ignores comments', () => {
  const stream = ': connected\n\nevent: tasks\ndata:\n\n: ping\n\nevent: tasks\ndata:\n\n';
  const whole = parse([stream]);
  assert.deepEqual(whole, [
    { event: 'tasks', data: '' },
    { event: 'tasks', data: '' },
  ]);
  assert.deepEqual(parse(stream.split('')), whole);
  assert.deepEqual(parse([': conn', 'ected\n', '\nevent: ta', 'sks\nda', 'ta:\n', '\n']), [
    { event: 'tasks', data: '' },
  ]);
});

test('the SSE parser takes CRLF and CR line ends, also when a CRLF is split, and joins data lines', () => {
  assert.deepEqual(parse(['event: tasks\r\ndata: a\r\ndata: b\r\n\r\n']), [{ event: 'tasks', data: 'a\nb' }]);
  assert.deepEqual(parse(['event: tasks\r', '\ndata:\r', '\n\r', '\n']), [{ event: 'tasks', data: '' }]);
  assert.deepEqual(parse(['data: x\r\r', 'data: y\n\n']), [
    { event: 'message', data: 'x' },
    { event: 'message', data: 'y' },
  ]);
});

function ticker(codes: number[] = []) {
  const clock = new FakeClock();
  const log: string[] = [];
  const started: number[] = [];
  const release: (() => void)[] = [];
  const t = createTicker({
    timers: clock,
    log: (line) => log.push(line),
    debounceMs: 1000,
    retryMs: 5000,
    run: () =>
      new Promise<number>((resolve) => {
        started.push(clock.now());
        release.push(() => resolve(codes.shift() ?? 0));
      }),
  });
  return { clock, log, started, release, t };
}

test('a burst of events gives one tick, a second after the last', async () => {
  const { clock, started, t } = ticker();
  t.soon();
  await clock.advance(600);
  t.soon();
  await clock.advance(999);
  assert.deepEqual(started, []);
  await clock.advance(1);
  assert.deepEqual(started, [1600]);
});

test('an event during a tick sets one dirty flag: exactly one more tick runs afterwards', async () => {
  const { clock, started, release, t } = ticker();
  t.now();
  await clock.advance(0);
  assert.equal(started.length, 1);
  t.soon();
  t.soon();
  t.now();
  await clock.advance(5000);
  assert.equal(started.length, 1, 'no overlapping tick');
  release[0]?.();
  await clock.advance(0);
  assert.equal(started.length, 2);
  release[1]?.();
  await clock.advance(10_000);
  assert.equal(started.length, 2, 'the flag was spent');
});

test('exit 75 means the timer holds the lock: the tick is retried after five seconds', async () => {
  const { clock, log, started, release, t } = ticker([75, 1, 0]);
  t.now();
  await clock.advance(0);
  release[0]?.();
  await clock.advance(4999);
  assert.equal(started.length, 1);
  await clock.advance(1);
  assert.equal(started.length, 2);
  release[1]?.();
  await clock.advance(10_000);
  assert.equal(started.length, 2, 'another failure is logged and not retried');
  assert.match(log.join('\n'), /holds the lock, retrying in 5 s/);
  assert.match(log.join('\n'), /tick: exit 1 after/);
});

test('a tick that cannot start is logged and the next event still ticks', async () => {
  const clock = new FakeClock();
  const log: string[] = [];
  let calls = 0;
  const t = createTicker({
    timers: clock,
    log: (line) => log.push(line),
    debounceMs: 1000,
    retryMs: 5000,
    run: () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('spawn flock ENOENT')) : Promise.resolve(0);
    },
  });
  t.now();
  await clock.advance(0);
  t.soon();
  await clock.advance(1000);
  assert.equal(calls, 2);
  assert.match(log[0] ?? '', /tick could not start: spawn flock ENOENT/);
});

test('the backoff doubles from a second to a minute and is cut by jitter', () => {
  const seconds = (random: number) =>
    [0, 1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => backoffMs(attempt, LISTENER_OPTIONS, random) / 1000);
  assert.deepEqual(seconds(1), [1, 2, 4, 8, 16, 32, 60, 60, 60]);
  assert.deepEqual(seconds(0), [0.5, 1, 2, 4, 8, 16, 30, 30, 30]);
});

// A stream the test writes to.
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

type Plan = ReturnType<typeof openStream> | Response | Error;

function listener(plans: Plan[], verify?: () => Promise<{ url: string; token: string }>) {
  const clock = new FakeClock();
  const log: string[] = [];
  const requests: { url: string; authorization: string | undefined; features: string | undefined }[] = [];
  const ticks: number[] = [];
  const stop = new AbortController();
  let verified = 0;
  const done = runListener({
    timers: clock,
    random: () => 1,
    log: (line) => log.push(line),
    signal: stop.signal,
    verify:
      verify ??
      (async () => {
        verified += 1;
        return { url: 'https://board.example', token: 'abm_x' };
      }),
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      requests.push({
        url,
        authorization: headers.get('authorization') ?? undefined,
        features: headers.get(CLIENT_FEATURES_HEADER) ?? undefined,
      });
      const next = plans.shift();
      if (next === undefined) throw new Error('no more plans');
      if (next instanceof Error) throw next;
      return 'response' in next ? next.response : next;
    },
    runTick: async () => {
      ticks.push(clock.now());
      return 0;
    },
  });
  return { clock, log, requests, ticks, stop, done, verified: () => verified };
}

test('it verifies the contract, opens the stream with the token and ticks once connected', async () => {
  const stream = openStream();
  const { clock, requests, ticks, log, verified, stop, done } = listener([stream]);
  await clock.advance(0);
  assert.equal(verified(), 1);
  assert.deepEqual(requests, [
    { url: 'https://board.example/api/machine/events', authorization: 'Bearer abm_x', features: '' },
  ]);
  assert.deepEqual(ticks, [0]);
  assert.equal(log[0], 'connected');
  stream.push(': connected\n\n');
  await clock.advance(5000);
  assert.deepEqual(ticks, [0], 'a comment does not tick');
  stop.abort();
  assert.equal(await done, 0);
});

test('a tasks event ticks a second later; a burst shares one tick', async () => {
  const stream = openStream();
  const { clock, ticks, stop, done } = listener([stream]);
  await clock.advance(0);
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(400);
  stream.push('event: tasks\ndata:\n\nevent: tasks\ndata:\n\n');
  await clock.advance(1000);
  assert.deepEqual(ticks, [0, 1400]);
  stop.abort();
  await done;
});

test('no bytes for a minute is a dead connection: it reconnects and ticks again', async () => {
  const first = openStream();
  const second = openStream();
  const { clock, ticks, log, requests, verified, stop, done } = listener([first, second]);
  await clock.advance(0);
  first.push(': ping\n\n');
  await clock.advance(59_000);
  assert.equal(requests.length, 1);
  first.push(': ping\n\n');
  await clock.advance(59_000);
  assert.equal(requests.length, 1, 'a ping keeps it alive');
  await clock.advance(1000);
  assert.match(log.join('\n'), /disconnected: .*took longer than 60 s/);
  await clock.advance(1000);
  assert.equal(requests.length, 2);
  assert.equal(verified(), 2, 'the contract is checked on every connect');
  assert.equal(ticks.length, 2, 'events may have been missed meanwhile');
  stop.abort();
  await done;
});

test('the board closing the stream reconnects', async () => {
  const first = openStream();
  const second = openStream();
  const { clock, requests, log, stop, done } = listener([first, second]);
  await clock.advance(0);
  first.end();
  await clock.advance(1000);
  assert.match(log.join('\n'), /disconnected: the board closed the stream/);
  assert.equal(requests.length, 2);
  stop.abort();
  await done;
});

test('failed connects back off 1, 2, 4 ... up to 60 s', async () => {
  const { clock, log, stop, done } = listener(Array.from({ length: 10 }, () => new Error('connect ECONNREFUSED')));
  await clock.advance(200_000);
  const delays = log.filter((line) => line.startsWith('reconnecting')).map((line) => /in ([\d.]+) s/.exec(line)?.[1]);
  assert.deepEqual(delays.slice(0, 8), ['1.0', '2.0', '4.0', '8.0', '16.0', '32.0', '60.0', '60.0']);
  stop.abort();
  await done;
});

test('a connection that stayed up resets the backoff, a short one does not', async () => {
  const first = openStream();
  const second = openStream();
  const { clock, log, stop, done } = listener([
    new Error('refused'),
    new Error('refused'),
    first,
    second,
    new Error('refused'),
  ]);
  await clock.advance(1000 + 2000);
  // Connected at 3000, healthy after 30 s.
  await clock.advance(31_000);
  first.end();
  await clock.advance(1000);
  // Closed after 5 s: the backoff goes on from where it was reset, 1 s.
  second.end();
  await clock.advance(1000);
  const delays = log.filter((line) => line.startsWith('reconnecting')).map((line) => /in ([\d.]+) s/.exec(line)?.[1]);
  assert.deepEqual(delays, ['1.0', '2.0', '1.0', '2.0']);
  stop.abort();
  await done;
});

test('a 401 is logged clearly and backs off like any failure', async () => {
  const { clock, log, requests, stop, done } = listener([
    new Response('{"error":"unknown or revoked machine token"}', { status: 401 }),
    new Response('{"error":"unknown or revoked machine token"}', { status: 401 }),
  ]);
  await clock.advance(2000);
  assert.equal(requests.length, 2);
  assert.match(log[0] ?? '', /refused the token \(401\)/);
  assert.equal(log[1], 'reconnecting in 1.0 s');
  assert.equal(log[3], 'reconnecting in 2.0 s');
  stop.abort();
  await done;
});

const servedApi =
  (api: { version: number; minClient: number }): Fetch =>
  async () =>
    new Response(JSON.stringify({ result: { contract: 9, owner: 'alice', keyId: null, api } }));
const verifyAgainst = (fetcher: Fetch) => () =>
  verifyContract({ url: 'https://board.example', token: 'abm_x' }, fetcher).then(() => ({
    url: 'https://board.example',
    token: 'abm_x',
  }));

test('a server that no longer serves this CLI is logged and ends the listener with a failure', async () => {
  const { clock, log, requests, done } = listener(
    [],
    verifyAgainst(servedApi({ version: API_VERSION + 1, minClient: API_VERSION + 1 })),
  );
  assert.equal(await done, 1);
  assert.equal(requests.length, 0);
  assert.match(log.join('\n'), /this CLI is older than the board server/);
  await clock.advance(100_000);
  assert.equal(requests.length, 0);
});

test('a server older than the CLI keeps the listener reconnecting, saying so once', async () => {
  let api = { version: MIN_SERVER - 1, minClient: 1 };
  const stream = openStream();
  const { clock, log, requests, stop, done } = listener([stream], () => verifyAgainst(servedApi(api))());
  await clock.advance(100_000);
  assert.equal(requests.length, 0);
  const older = log.filter((line) => /the board server is older than this CLI/.test(line));
  assert.equal(older.length, 1, log.join('\n'));
  assert.ok(log.filter((line) => line.startsWith('reconnecting in')).length > 2);
  assert.ok(!log.some((line) => line.startsWith('disconnected')));
  api = { version: API_VERSION, minClient: API_VERSION };
  await clock.advance(100_000);
  assert.ok(requests.length > 0);
  assert.ok(log.includes('connected'));
  stop.abort();
  await done;
});

test('a server without the event stream keeps the listener reconnecting, saying so once', async () => {
  let features = new Set<string>(['wait']);
  const stream = openStream();
  const { clock, log, requests, stop, done } = listener([stream], async () => {
    requireFeature(features, 'events');
    return { url: 'https://board.example', token: 'abm_x' };
  });
  await clock.advance(100_000);
  assert.equal(requests.length, 0);
  assert.deepEqual(
    log.filter((line) => /does not support/.test(line)),
    ['the board server does not support the event stream yet; update the board server'],
  );
  assert.ok(log.filter((line) => line.startsWith('reconnecting in')).length > 2);
  features = new Set(['events']);
  await clock.advance(100_000);
  assert.ok(log.includes('connected'));
  stop.abort();
  await done;
});

test('SIGTERM stops the reconnecting and the pending tick, and exits 0', async () => {
  const stream = openStream();
  const { clock, ticks, stop, done } = listener([stream, openStream()]);
  await clock.advance(0);
  stream.push('event: tasks\ndata:\n\n');
  await clock.advance(100);
  stop.abort();
  assert.equal(await done, 0);
  await clock.advance(10_000);
  assert.deepEqual(ticks, [0], 'the debounced tick never ran');
});

test("a tick runs the dispatch command under the unit's lock and its time limit", () => {
  const dispatch = ['/opt/node/bin/node', '/opt/board/main.mts', 'internal', 'dispatch'];
  assert.deepEqual(tickCommand({ XDG_RUNTIME_DIR: '/run/user/1000' }, dispatch), [
    'timeout',
    '-k',
    '10',
    '110',
    'flock',
    '-n',
    '-E',
    '75',
    '/run/user/1000/agent-board-dispatch.lock',
    ...dispatch,
  ]);
  assert.equal(tickCommand({}, dispatch)[8], '/tmp/agent-board-dispatch.lock');
});

test('a tick that timeout stopped is logged as a failure and not retried like a held lock', async () => {
  const { clock, log, started, release, t } = ticker([124, 137]);
  t.now();
  await clock.advance(0);
  release[0]?.();
  await clock.advance(10_000);
  assert.equal(started.length, 1);
  assert.match(log.join('\n'), /tick: stopped after 110 s \(exit 124\)/);
});

test('SIGTERM waits for the running tick before the listener exits', async () => {
  const stream = openStream();
  const clock = new FakeClock();
  const stop = new AbortController();
  let finish: () => void = () => undefined;
  const done = runListener({
    timers: clock,
    random: () => 1,
    log: () => undefined,
    signal: stop.signal,
    verify: async () => ({ url: 'https://board.example', token: 'abm_x' }),
    fetch: async () => stream.response,
    runTick: () =>
      new Promise<number>((resolve) => {
        finish = () => resolve(0);
      }),
  });
  let exited = false;
  void done.then(() => {
    exited = true;
  });
  await clock.advance(0);
  stop.abort();
  await clock.advance(5000);
  assert.equal(exited, false, 'the tick is still running');
  finish();
  assert.equal(await done, 0);
});
