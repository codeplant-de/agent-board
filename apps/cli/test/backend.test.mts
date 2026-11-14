import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTRACT_VERSION,
  deriveKeys,
  encodeDataKey,
  generateDataKey,
  serializeSchedule,
  serializeTask,
} from '@agent-board/shared';
import {
  BackendError,
  callServer,
  checkBoardUrl,
  createWebBackend,
  dryRunBackend,
  parseWebConfig,
  verifyContract,
} from '../src/backend.mts';
import type { Fetch } from '../src/backend.mts';
import { createSealedBackend } from '../src/sealing.mts';
import { DATA_KEY, KEYS, OWNER, wireSchedule, wireTask } from './helpers.mts';

const config = { url: 'https://board.example', token: 'TOKEN-123', dataKey: DATA_KEY };
const ENV = { AGENT_BOARD_TOKEN: 't', AGENT_BOARD_DATA_KEY: encodeDataKey(DATA_KEY) };
const noteInput = { body: 'abe1.body', preview: 'abe1.preview' };

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
  version: number = CONTRACT_VERSION,
  served: { owner?: string; keyId?: string | null } = {},
) {
  const seen: Seen[] = [];
  const fetcher: Fetch = async (url, init) => {
    const command = url.slice(`${config.url}/api/machine/`.length);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ command, body, headers: new Headers(init.headers) });
    const answer =
      command === 'version'
        ? { body: { result: { contract: version, owner: OWNER, keyId: KEYS.keyId, ...served } } }
        : answers[command];
    if (answer === undefined)
      return new Response(JSON.stringify({ error: `unknown command ${command}` }), { status: 404 });
    const { status = 200, body: payload } = typeof answer === 'function' ? answer(body) : answer;
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status });
  };
  return { seen, fetcher, backend: createWebBackend({ loadConfig: () => config, fetch: fetcher }) };
}

const taskJson = async (id: string) => serializeTask(await wireTask({ id }));

test('the config needs a URL, https away from localhost, the token and the data key', () => {
  assert.deepEqual(parseWebConfig({ url: 'https://board.example/' }, ENV), {
    url: 'https://board.example',
    token: 't',
    dataKey: DATA_KEY,
  });
  assert.equal(parseWebConfig({ url: 'http://localhost:4000' }, ENV).url, 'http://localhost:4000');
  assert.throws(() => parseWebConfig({ url: 'http://board.example' }, ENV), /https/);
  assert.throws(() => parseWebConfig({ url: 'https://board.example' }, {}), /AGENT_BOARD_TOKEN/);
  assert.throws(() => parseWebConfig({}, ENV), /url/);
});

test('a missing or malformed data key is refused with a pointer to Settings, never echoing the key', () => {
  const url = { url: 'https://board.example' };
  assert.throws(
    () => parseWebConfig(url, { AGENT_BOARD_TOKEN: 't' }),
    /AGENT_BOARD_DATA_KEY \(copy it from the board's Settings page, then run "board init"\)/,
  );
  const secret = `${encodeDataKey(generateDataKey())}-damaged`;
  assert.throws(
    () => parseWebConfig(url, { AGENT_BOARD_TOKEN: 't', AGENT_BOARD_DATA_KEY: secret }),
    (error: unknown) =>
      error instanceof Error && /not a data key/.test(error.message) && !error.message.includes(secret.slice(5)),
  );
  assert.throws(
    () => parseWebConfig(url, { AGENT_BOARD_TOKEN: 't', AGENT_BOARD_DATA_KEY: 'abk1_short' }),
    /not a data key/,
  );
});

test('one POST per call with the bearer token; the answer is parsed', async () => {
  const { seen, backend } = board({ 'get-task': { body: { result: await taskJson('abc') } } });
  const found = await backend.getTask('abc');
  assert.equal(found.id, 'abc');
  const call = seen.find((request) => request.command === 'get-task');
  assert.deepEqual(call?.body, { id: 'abc' });
  assert.equal(call?.headers.get('authorization'), 'Bearer TOKEN-123');
});

test('every command sends the body the server expects', async () => {
  const ok = { body: { result: null } };
  const a = await taskJson('a');
  const { seen, backend } = board({
    'list-tasks': { body: { result: [a] } },
    'add-task': { body: { result: { task: a, created: true } } },
    'update-task': { body: { result: a } },
    'claim-task': { body: { result: a } },
    'add-note': ok,
    ask: ok,
    heartbeat: ok,
    pause: { body: { result: a } },
    fail: { body: { result: { applied: false, task: a } } },
  });
  await backend.listTasks({ all: true });
  await backend.addTask({ title: 'abe1.t', input: 'abe1.i', status: 'todo' });
  await backend.updateTask('a', { next: 'fresh' });
  await backend.claimTask('a', 'laptop');
  await backend.addNote('a', noteInput, { author: 'system' });
  await backend.ask('a', { body: 'abe1.b', questions: 'abe1.q' });
  await backend.heartbeat('a', { lane: 'general', borrowed: false });
  await backend.pause('a', noteInput);
  assert.equal((await backend.fail('a', noteInput)).applied, false);
  assert.deepEqual(
    seen.slice(1).map(({ command, body }) => [command, body]),
    [
      ['list-tasks', { all: true }],
      ['add-task', { body: { title: 'abe1.t', input: 'abe1.i', status: 'todo' } }],
      ['update-task', { id: 'a', body: { next: 'fresh' } }],
      ['claim-task', { id: 'a', machine: 'laptop' }],
      ['add-note', { id: 'a', author: 'system', body: noteInput }],
      ['ask', { id: 'a', body: { body: 'abe1.b', questions: 'abe1.q' } }],
      ['heartbeat', { id: 'a', body: { lane: 'general', borrowed: false } }],
      ['pause', { id: 'a', body: noteInput }],
      ['fail', { id: 'a', body: noteInput }],
    ],
  );
});

test('the schedule commands send the body the server expects and parse its answers', async () => {
  const scheduleJson = serializeSchedule(await wireSchedule({ id: 'sch1' }));
  const { seen, backend } = board({
    'add-schedule': { body: { result: { schedule: scheduleJson, task: await taskJson('a') } } },
    'list-schedules': { body: { result: [scheduleJson] } },
    'update-schedule': { body: { result: scheduleJson } },
    'remove-schedule': { body: { result: null } },
  });
  const draft = { title: 'abe1.t', input: 'abe1.i', everyMs: 7_200_000, startAt: new Date('2027-01-01T08:00:00Z') };
  assert.equal((await backend.addSchedule(draft)).schedule.id, 'sch1');
  assert.equal((await backend.listSchedules())[0]?.everyMs, 7_200_000);
  assert.equal((await backend.updateSchedule('sch1', { paused: true })).id, 'sch1');
  await backend.removeSchedule('sch1');
  assert.deepEqual(
    seen.slice(1).map(({ command, body }) => [command, body]),
    [
      [
        'add-schedule',
        { body: { title: 'abe1.t', input: 'abe1.i', everyMs: 7_200_000, startAt: '2027-01-01T08:00:00.000Z' } },
      ],
      ['list-schedules', {}],
      ['update-schedule', { id: 'sch1', body: { paused: true } }],
      ['remove-schedule', { id: 'sch1' }],
    ],
  );
  await assert.rejects(backend.removeSchedule('bad id'), /not a valid schedule id/);
});

test('server errors carry the status and reason, never the token', async () => {
  const { backend } = board({ 'get-task': { status: 404, body: { error: 'no task abc' } } });
  await assert.rejects(
    backend.getTask('abc'),
    (error: unknown) =>
      error instanceof BackendError &&
      error.status === 404 &&
      /get-task: no task abc/.test(error.message) &&
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
});

test('an answer that is not JSON, or not a task, is a one-line failure', async () => {
  const { backend } = board({
    'get-task': { body: '<html>login</html>' },
    'read-notes': { body: { result: [{ id: 1 }] } },
  });
  await assert.rejects(
    backend.getTask('abc'),
    (error: unknown) =>
      error instanceof BackendError && /without JSON/.test(error.message) && !error.message.includes('TOKEN'),
  );
  await assert.rejects(
    backend.readNotes('abc'),
    (error: unknown) =>
      error instanceof BackendError && /read-notes: note.createdAt must be a string/.test(error.message),
  );
});

test('a lost claim is undefined; other failures still throw', async () => {
  const lost = board({ 'claim-task': { status: 409, body: { error: 'the task is not free for this machine' } } });
  assert.equal(await lost.backend.claimTask('abc', 'laptop'), undefined);
  const removed = board({ 'claim-task': { status: 404, body: { error: 'no task abc' } } });
  assert.equal(await removed.backend.claimTask('abc', 'laptop'), undefined);
  const forbidden = board({ 'claim-task': { status: 403, body: { error: 'wrong machine' } } });
  await assert.rejects(forbidden.backend.claimTask('abc', 'laptop'), /wrong machine/);
});

test('unsafe ids and machine names are refused before any request', async () => {
  const { seen, backend } = board({});
  await assert.rejects(backend.getTask('../x'), /not a valid task id/);
  await assert.rejects(backend.addNote('dispatch', noteInput), /not a valid task id/);
  await assert.rejects(backend.claimTask('abc', 'a b'), /not a valid machine name/);
  assert.deepEqual(seen, []);
});

test('a server on another contract version is refused, saying which side is older', async () => {
  const older = board({ 'list-tasks': { body: { result: [] } } }, CONTRACT_VERSION - 1);
  await assert.rejects(
    older.backend.listTasks(),
    new RegExp(`server is older than this CLI.*speaks contract ${CONTRACT_VERSION - 1}`),
  );
  assert.deepEqual(
    older.seen.map((request) => request.command),
    ['version'],
  );
  const newer = board({ 'list-tasks': { body: { result: [] } } }, CONTRACT_VERSION + 1);
  await assert.rejects(newer.backend.listTasks(), /this CLI is older than the board server/);
});

test('a server without the version command counts as older', async () => {
  const fetcher: Fetch = async () =>
    new Response(JSON.stringify({ error: 'unknown command version' }), { status: 404 });
  const backend = createWebBackend({ loadConfig: () => config, fetch: fetcher });
  await assert.rejects(backend.listTasks(), /server is older than this CLI/);
});

test('the version is checked once per process, and the config is loaded only on the first call', async () => {
  let loads = 0;
  const commands: string[] = [];
  const fetcher: Fetch = async (url) => {
    commands.push(url.slice(`${config.url}/api/machine/`.length));
    return new Response(
      JSON.stringify({
        result: url.endsWith('/version') ? { contract: CONTRACT_VERSION, owner: OWNER, keyId: KEYS.keyId } : [],
      }),
    );
  };
  const backend = createWebBackend({ loadConfig: () => ((loads += 1), config), fetch: fetcher });
  assert.equal(loads, 0);
  await backend.listTasks();
  await backend.listTasks({ all: true });
  assert.equal(loads, 1);
  assert.deepEqual(commands, ['version', 'list-tasks', 'list-tasks']);
});

test('a missing config fails the first call, not the construction', async () => {
  const backend = createWebBackend({
    loadConfig: () => {
      throw new Error('web.json missing');
    },
  });
  await assert.rejects(backend.listTasks(), /web.json missing/);
});

test('a dry run reads through and prints every write instead of sending it', async () => {
  const { seen, fetcher } = board({ 'get-task': { body: { result: await taskJson('a') } } });
  const lines: string[] = [];
  const dry = dryRunBackend(createSealedBackend({ loadConfig: () => config, fetch: fetcher }), (line) =>
    lines.push(line),
  );
  await dry.updateTask('a', { next: 'fresh' });
  await dry.addNote('a', 'hi', { author: 'system' });
  assert.equal((await dry.claimTask('a', 'laptop'))?.status, 'running');
  const added = await dry.addSchedule({ title: 't', input: 'i', cron: '0 9 * * *', timezone: 'UTC', times: 3 });
  assert.deepEqual([added.schedule.cron, added.schedule.remaining, added.task.scheduleId], ['0 9 * * *', 2, 'dry']);
  await dry.removeSchedule('sch1');
  assert.deepEqual(
    lines.map((line) => line.split(' ').slice(0, 2).join(' ')),
    ['DRY update-task', 'DRY add-note', 'DRY claim-task', 'DRY add-schedule', 'DRY remove-schedule'],
  );
  assert.deepEqual([...new Set(seen.map((request) => request.command))], ['version', 'get-task']);
});

test('a board without a data key yet is refused, saying to set up encryption in the browser', async () => {
  const { backend, seen } = board({ 'list-tasks': { body: { result: [] } } }, CONTRACT_VERSION, { keyId: null });
  await assert.rejects(backend.listTasks(), /set up encryption in the browser first/);
  assert.deepEqual(
    seen.map((request) => request.command),
    ['version'],
  );
});

test('a data key that is not the board’s is refused, naming both key ids and never the key', async () => {
  const other = await deriveKeys(generateDataKey(), OWNER);
  const { backend, seen } = board({ 'list-tasks': { body: { result: [] } } }, CONTRACT_VERSION, {
    keyId: other.keyId,
  });
  await assert.rejects(
    backend.listTasks(),
    (error: unknown) =>
      error instanceof BackendError &&
      error.message.includes(`this machine holds a different data key (id ${KEYS.keyId})`) &&
      error.message.includes(`the board's (id ${other.keyId})`) &&
      !error.message.includes(encodeDataKey(DATA_KEY)),
  );
  assert.deepEqual(
    seen.map((request) => request.command),
    ['version'],
  );
});

test('the keys are derived for the owner the server names, with the blind index key', async () => {
  const { backend } = board({}, CONTRACT_VERSION, { owner: 'bob' });
  const keys = await backend.keys();
  assert.equal(keys.owner, 'bob');
  assert.equal(keys.keyId, KEYS.keyId);
  assert.ok(keys.index, 'the blind index key is derived');
});

test('an old server answer without owner and key id is a one-line failure', async () => {
  const fetcher: Fetch = async () => new Response(JSON.stringify({ result: { contract: CONTRACT_VERSION } }));
  const backend = createWebBackend({ loadConfig: () => config, fetch: fetcher });
  await assert.rejects(backend.listTasks(), /version: version.owner must be a string/);
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

test('a board URL with whitespace anywhere is refused', () => {
  assert.equal(checkBoardUrl('https://board.example.com/'), 'https://board.example.com');
  for (const url of [
    'https://board.example.com ',
    ' https://board.example.com',
    'https://board example.com',
    'https://board.example.com/a b',
  ])
    assert.throws(() => checkBoardUrl(url), /http\(s\) URL/, JSON.stringify(url));
});
