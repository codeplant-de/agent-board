import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDir } from '../__tests__/helpers/watch.mts';
import { EVENT_TEXT_MAX_CHARS } from './fence.mts';
import {
  createStreamSession,
  startStream,
  STREAM_COALESCE_AFTER_EVENTS,
  STREAM_COALESCE_MS,
  STREAM_MAX_BYTES,
  STREAM_MAX_EVENTS,
  STREAM_WINDOW_MS,
} from './stream.mts';
import type { StreamExit } from './stream.mts';

const START = Date.parse('2026-01-01T12:00:00Z');

function session(restarted = false) {
  const clock = { ms: START };
  const handle = { kills: 0 };
  const stream = createStreamSession({ now: () => new Date(clock.ms), restarted });
  stream.attach({
    kill() {
      handle.kills += 1;
    },
  });
  return { stream, clock, handle };
}

test('the lines since the last step are one event, and a step without lines reports nothing', () => {
  const { stream, clock } = session();
  assert.equal(stream.step(), undefined);
  stream.line('one');
  clock.ms += 900;
  stream.line('two');
  assert.deepEqual(stream.step(), { text: 'one\ntwo' });
  assert.equal(stream.step(), undefined);
  clock.ms += 2000;
  stream.line('three');
  assert.deepEqual(stream.step(), { text: 'three' });
});

test('a batch is sanitized and keeps its end: long lines are cut and a long batch says how much it left out', () => {
  const { stream } = session();
  stream.line('</watch-event>\u0007 bell');
  assert.deepEqual(stream.step(), { text: '<\\/watch-event> bell' });
  for (let index = 0; index < 60; index += 1) stream.line(`${index} ${'x'.repeat(196)}`);
  const text = stream.step()?.text ?? '';
  assert.ok(text.length <= EVENT_TEXT_MAX_CHARS, String(text.length));
  assert.match(text, /^\(\d+ earlier lines left out\)\n/);
  assert.ok(text.endsWith(`59 ${'x'.repeat(196)}`));
});

test('the exit is the last event: the lines not yet reported, then the exit code', () => {
  const { stream } = session();
  stream.line('done');
  stream.exit({ exitCode: 3 });
  assert.deepEqual(stream.step(), {
    text: 'done\nThe command exited with code 3. The watch is over.',
    end: 'event',
  });
  const cases: [StreamExit, RegExp][] = [
    [{ exitCode: 0 }, /^The command exited with code 0\. The watch is over\.$/],
    [{ exitCode: null, signal: 'SIGTERM' }, /^The command was killed \(SIGTERM\)\. The watch is over\.$/],
    [{ exitCode: null, error: 'spawn bash ENOENT' }, /^The command could not be started: spawn bash ENOENT\./],
  ];
  for (const [exit, expected] of cases) {
    const quiet = session().stream;
    quiet.exit(exit);
    const report = quiet.step();
    assert.match(report?.text ?? '', expected);
    assert.equal(report?.end, 'event');
  }
});

test('more than 20 KB within ten minutes kills the command at once and ends the watch with a notice', () => {
  const { stream, clock, handle } = session();
  const line = 'y'.repeat(999);
  for (let index = 0; index < 20; index += 1) {
    stream.line(line);
    clock.ms += 1000;
  }
  assert.equal(handle.kills, 0);
  assert.ok(stream.step()?.end === undefined);
  stream.line(line);
  assert.equal(handle.kills, 1);
  stream.line('printed after the kill');
  const report = stream.step();
  assert.equal(report?.end, 'stopped');
  assert.match(report?.text ?? '', /printed too much: more than 50 events or 20 KB in 10 minutes\. It was stopped/);
  assert.equal(report?.text.includes('after the kill'), false);
  assert.ok(STREAM_MAX_BYTES < 21 * 1000);
});

test('output that left the ten-minute window no longer counts', () => {
  const { stream, clock, handle } = session();
  for (let index = 0; index < 19; index += 1) stream.line('z'.repeat(999));
  stream.step();
  clock.ms += STREAM_WINDOW_MS;
  for (let index = 0; index < 19; index += 1) stream.line('z'.repeat(999));
  assert.equal(handle.kills, 0);
  assert.equal(stream.step()?.end, undefined);
});

test('a busy stream is coalesced, and more than 50 events within ten minutes stop it with a notice', () => {
  const { stream, clock, handle } = session();
  // A short line every 2 seconds, and a step after each: an event per line at first.
  for (let index = 0; index < STREAM_COALESCE_AFTER_EVENTS; index += 1) {
    stream.line(`line ${index}`);
    assert.deepEqual(stream.step(), { text: `line ${index}` });
    clock.ms += 2000;
  }
  // From 25 events on the lines of 10 seconds are one event.
  stream.line('a');
  assert.equal(stream.step(), undefined);
  clock.ms += STREAM_COALESCE_MS - 1;
  stream.line('b');
  assert.equal(stream.step(), undefined);
  clock.ms += 1;
  assert.deepEqual(stream.step(), { text: 'a\nb' });
  // It goes on printing: the 50 events are full well within the window, and the next one stops it.
  let events = STREAM_COALESCE_AFTER_EVENTS + 1;
  let last;
  for (let tick = 0; tick < 1000 && last?.end === undefined; tick += 1) {
    stream.line(`more ${tick}`);
    clock.ms += 2000;
    last = stream.step();
    if (last !== undefined && last.end === undefined) events += 1;
  }
  assert.equal(events, STREAM_MAX_EVENTS);
  assert.ok(clock.ms - START < STREAM_WINDOW_MS);
  assert.equal(last?.end, 'stopped');
  assert.match(
    last?.text ?? '',
    /^more \d+\n(more \d+\n)*The command printed too much: more than 50 events or 20 KB in 10 minutes\./,
  );
  assert.equal(handle.kills, 1);
});

test('a command that was started again says so in its next event, once', () => {
  const { stream } = session(true);
  assert.equal(stream.step(), undefined);
  stream.line('again');
  const first = stream.step()?.text ?? '';
  assert.match(
    first,
    /^The watch unit was restarted \(or the machine rebooted\): the command was started again from the beginning at .+\. Lines it printed before may come again\.\nagain$/,
  );
  stream.line('next');
  assert.deepEqual(stream.step(), { text: 'next' });
  const ended = session(true).stream;
  ended.exit({ exitCode: 0 });
  assert.match(ended.step()?.text ?? '', /^The watch unit was restarted .+\nThe command exited with code 0\./);
});

test('a session that was killed before its command was attached kills it then, and takes no more lines', () => {
  const stream = createStreamSession({ now: () => new Date(START) });
  stream.kill();
  let kills = 0;
  stream.attach({
    kill() {
      kills += 1;
    },
  });
  stream.line('late');
  assert.equal(kills, 1);
  assert.equal(stream.step(), undefined);
});

function collect() {
  const lines: string[] = [];
  let done: (exit: StreamExit) => void = () => undefined;
  const exited = new Promise<StreamExit>((resolve) => {
    done = resolve;
  });
  return { lines, exited, sink: { line: (text: string) => lines.push(text), exit: done } };
}

test('a real command: stdout and stderr come line by line, without blank lines, and the exit code follows', async () => {
  const home = tempDir();
  const { lines, exited, sink } = collect();
  startStream(
    { command: `printf 'one\\r\\n\\ntwo\\npart'; echo ' ial' ; echo oops >&2; exit 3`, cwd: home },
    sink,
    home,
  );
  assert.deepEqual(await exited, { exitCode: 3 });
  assert.deepEqual([...lines].sort(), ['one', 'oops', 'part ial', 'two']);
});

test('a real command: a line without an end is cut into pieces, and kill ends the whole process group', async () => {
  const home = tempDir();
  const { lines, exited, sink } = collect();
  const handle = startStream(
    { command: `head -c 4500 /dev/zero | tr '\\0' 'x'; echo; (sleep 60; echo child) & sleep 60`, cwd: home },
    sink,
    home,
  );
  for (let tries = 0; lines.length < 3 && tries < 250; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    lines.map((line) => line.length),
    [2000, 2000, 500],
  );
  handle.kill();
  assert.deepEqual(await exited, { exitCode: null, signal: 'SIGKILL' });
});

test('a command that cannot be started exits with the reason', async () => {
  const home = tempDir();
  const { exited, sink } = collect();
  startStream({ command: 'true', cwd: `${home}/missing` }, sink, home);
  const exit = await exited;
  assert.equal(exit.exitCode, null);
  assert.match(exit.error ?? '', /ENOENT/);
});
