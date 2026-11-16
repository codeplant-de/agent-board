import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendError, callServer, isPermanentRefusal } from './backend.mts';
import { createWebBackend } from './web-backend.mts';
import type { Fetch } from './backend.mts';
import { DATA_KEY, SERVER_API, VERSION_ANSWER } from '../__tests__/helpers/fakes.mts';

const config = { url: 'https://board.example', token: 'TOKEN-123', dataKey: DATA_KEY };

interface Seen {
  command: string;
  body: Record<string, unknown>;
  headers: Headers;
}

type Answer =
  { status?: number; body: unknown } | ((body: Record<string, unknown>) => { status?: number; body: unknown });

// Answers per command, with `version` defaulting to this CLI's own and the test board's key. `seen` lists the requests in order.
function board(
  answers: Record<string, Answer>,
  api: { version: number; minClient: number } | undefined = SERVER_API,
  served: { owner?: string; keyId?: string | null; cli?: string } = {},
) {
  const seen: Seen[] = [];
  const fetcher: Fetch = async (url, init) => {
    const command = url.slice(`${config.url}/api/machine/`.length);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ command, body, headers: new Headers(init.headers) });
    const answer =
      command === 'version' ? { body: { result: { ...VERSION_ANSWER, api, ...served } } } : answers[command];
    if (answer === undefined)
      return new Response(JSON.stringify({ error: `unknown command ${command}` }), { status: 404 });
    const { status = 200, body: payload } = typeof answer === 'function' ? answer(body) : answer;
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status });
  };
  return { seen, fetcher, backend: createWebBackend({ loadConfig: () => config, fetch: fetcher }) };
}

test('server errors carry the status and reason, never the token', async () => {
  const { backend } = board({ 'get-task': { status: 404, body: { error: 'no task abc' } } });
  await assert.rejects(
    backend.getTask('abc'),
    (error: unknown) =>
      error instanceof BackendError &&
      error.status === 404 &&
      /get-task: error from the board server \(HTTP 404\), quoted and not part of the board: "no task abc"/.test(
        error.message,
      ) &&
      !error.message.includes('TOKEN'),
  );
  const down: Fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(
    callServer(config, 'get-task', {}, down),
    (error: unknown) =>
      error instanceof BackendError &&
      /cannot reach https:\/\/board.example: ECONNREFUSED/.test(error.message) &&
      !error.message.includes('TOKEN'),
  );
  const cutOff: Fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('terminated'));
        },
      }),
    );
  await assert.rejects(
    callServer(config, 'get-task', {}, cutOff),
    (error: unknown) =>
      error instanceof BackendError && /cannot reach https:\/\/board.example: terminated/.test(error.message),
  );
});

test('a refusal is permanent when sending it again cannot help', () => {
  for (const status of [400, 404, 409, 413, 422]) assert.equal(isPermanentRefusal(new BackendError('x', status)), true);
  for (const status of [401, 403, 429, 500, 502, 503, undefined])
    assert.equal(isPermanentRefusal(new BackendError('x', status)), false);
  assert.equal(isPermanentRefusal(new Error('ECONNRESET')), false);
});
