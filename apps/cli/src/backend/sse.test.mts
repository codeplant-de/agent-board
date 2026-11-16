import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSseParser } from './sse.mts';
import type { SseEvent } from './sse.mts';

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
