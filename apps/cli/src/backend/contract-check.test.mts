import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_VERSION, BASELINE_SERVER_FEATURES, MIN_SERVER } from '@agent-board/shared';
import { BackendError, callServer } from './backend.mts';
import { createWebBackend } from './web-backend.mts';
import { verifyContract } from './contract-check.mts';
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

test('a legacy server answer without api counts its contract as the whole range', async () => {
  const answers = { 'list-tasks': { body: { result: [] } } };
  assert.deepEqual(await board(answers, undefined).backend.listTasks(), []);
  assert.deepEqual(
    await verifyContract(
      config,
      async () => new Response(JSON.stringify({ result: { contract: API_VERSION, owner: 'alice', keyId: null } })),
    ),
    {
      owner: 'alice',
      keyId: null,
      api: { version: API_VERSION, minClient: API_VERSION },
      features: new Set(BASELINE_SERVER_FEATURES),
    },
  );
});

test('only a JSON answer of the API counts as the API speaking: a login page does not make the server old', async () => {
  const html =
    (status: number): Fetch =>
    async () =>
      new Response('<html>log in</html>', { status });
  const api =
    (status: number): Fetch =>
    async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status });
  await assert.rejects(
    callServer(config, 'get-task', {}, html(401)),
    (error: unknown) => error instanceof BackendError && error.status === 401 && !error.fromApi,
  );
  await assert.rejects(
    callServer(config, 'get-task', {}, api(401)),
    (error: unknown) => error instanceof BackendError && error.status === 401 && error.fromApi,
  );
  await assert.rejects(
    verifyContract(config, html(404)),
    (error: unknown) =>
      error instanceof BackendError && /without JSON/.test(error.message) && !/older than/.test(error.message),
  );
  await assert.rejects(
    verifyContract(config, api(404)),
    /the board server is older than this CLI: it does not know the version command/,
  );
});

test('a mismatch says how to fix the older side, for a checkout', async () => {
  const answering =
    (api: { version: number; minClient: number }): Fetch =>
    async () =>
      new Response(JSON.stringify({ result: { contract: 9, owner: 'alice', keyId: null, api } }));
  await assert.rejects(
    verifyContract(config, answering({ version: API_VERSION + 1, minClient: API_VERSION + 1 })),
    /this CLI is older than the board server: it speaks API \d+, the server serves clients from \d+; run "git pull" and "pnpm install" in the checkout/,
  );
  await assert.rejects(
    verifyContract(config, answering({ version: MIN_SERVER - 1, minClient: 1 })),
    /the board server is older than this CLI: .*; update the board server/,
  );
  assert.deepEqual(await verifyContract(config, answering({ version: API_VERSION, minClient: API_VERSION })), {
    owner: 'alice',
    keyId: null,
    api: { version: API_VERSION, minClient: API_VERSION },
    features: new Set(BASELINE_SERVER_FEATURES),
  });
});

test('the newest CLI the server advertises is part of what verifyContract returns, and a bad one is ignored', async () => {
  const answering =
    (cli: unknown): Fetch =>
    async () =>
      new Response(JSON.stringify({ result: { contract: API_VERSION, owner: 'alice', keyId: null, cli } }));
  assert.equal((await verifyContract(config, answering('0.7.0'))).cli, '0.7.0');
  for (const bad of ['next', '0.7', '0.7.0-dev', 7, null, undefined])
    assert.equal('cli' in (await verifyContract(config, answering(bad))), false, String(bad));
});
