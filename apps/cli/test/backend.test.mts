import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, serializeSchedule, serializeTask } from '@agent-board/shared';
import { BackendError, callServer, createWebBackend, dryRunBackend, parseWebConfig } from '../src/backend.mts';
import type { Fetch } from '../src/backend.mts';
import { schedule, task } from './helpers.mts';

const config = { url: 'https://board.example', token: 'TOKEN-123' };

interface Seen {
  command: string;
  body: Record<string, unknown>;
  headers: Headers;
}

type Answer =
  { status?: number; body: unknown } | ((body: Record<string, unknown>) => { status?: number; body: unknown });

// Answers per command, with `version` defaulting to this CLI's own. `seen` lists the requests in order.
function board(answers: Record<string, Answer>, version: number = CONTRACT_VERSION) {
  const seen: Seen[] = [];
  const fetcher: Fetch = async (url, init) => {
    const command = url.slice(`${config.url}/api/machine/`.length);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ command, body, headers: new Headers(init.headers) });
    const answer = command === 'version' ? { body: { result: { contract: version } } } : answers[command];
    if (answer === undefined)
      return new Response(JSON.stringify({ error: `unknown command ${command}` }), { status: 404 });
    const { status = 200, body: payload } = typeof answer === 'function' ? answer(body) : answer;
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status });
  };
  return { seen, backend: createWebBackend({ loadConfig: () => config, fetch: fetcher }) };
}

const taskJson = (id: string) => serializeTask(task({ id }));

test('the config needs a URL, https away from localhost, and the token', () => {
  assert.deepEqual(parseWebConfig({ url: 'https://board.example/' }, { AGENT_BOARD_TOKEN: 't' }), {
    url: 'https://board.example',
    token: 't',
  });
  assert.equal(
    parseWebConfig({ url: 'http://localhost:4000' }, { AGENT_BOARD_TOKEN: 't' }).url,
    'http://localhost:4000',
  );
  assert.throws(() => parseWebConfig({ url: 'http://board.example' }, { AGENT_BOARD_TOKEN: 't' }), /https/);
  assert.throws(() => parseWebConfig({ url: 'https://board.example' }, {}), /AGENT_BOARD_TOKEN/);
  assert.throws(() => parseWebConfig({}, { AGENT_BOARD_TOKEN: 't' }), /url/);
});

test('one POST per call with the bearer token; the answer is parsed', async () => {
  const { seen, backend } = board({ 'get-task': { body: { result: taskJson('abc') } } });
  const found = await backend.getTask('abc');
  assert.equal(found.id, 'abc');
  const call = seen.find((request) => request.command === 'get-task');
  assert.deepEqual(call?.body, { id: 'abc' });
  assert.equal(call?.headers.get('authorization'), 'Bearer TOKEN-123');
});

test('every command sends the body the server expects', async () => {
  const ok = { body: { result: null } };
  const { seen, backend } = board({
    'list-tasks': { body: { result: [taskJson('a')] } },
    'add-task': { body: { result: { task: taskJson('a'), created: true } } },
    'update-task': { body: { result: taskJson('a') } },
    'claim-task': { body: { result: taskJson('a') } },
    'add-note': ok,
    heartbeat: ok,
    pause: { body: { result: taskJson('a') } },
    fail: { body: { result: { applied: false, task: taskJson('a') } } },
  });
  await backend.listTasks({ all: true });
  await backend.addTask({ title: 't', input: 'i', labels: [], status: 'todo' });
  await backend.updateTask('a', { next: 'fresh' });
  await backend.claimTask('a', 'laptop');
  await backend.addNote('a', 'hi', { author: 'system' });
  await backend.heartbeat('a', { lane: 'general', borrowed: false });
  await backend.pause('a', 'why');
  assert.equal((await backend.fail('a', 'it broke')).applied, false);
  assert.deepEqual(
    seen.slice(1).map(({ command, body }) => [command, body]),
    [
      ['list-tasks', { all: true }],
      ['add-task', { body: { title: 't', input: 'i', labels: [], status: 'todo' } }],
      ['update-task', { id: 'a', body: { next: 'fresh' } }],
      ['claim-task', { id: 'a', machine: 'laptop' }],
      ['add-note', { id: 'a', author: 'system', body: 'hi' }],
      ['heartbeat', { id: 'a', body: { lane: 'general', borrowed: false } }],
      ['pause', { id: 'a', body: 'why' }],
      ['fail', { id: 'a', body: 'it broke' }],
    ],
  );
});

test('the schedule commands send the body the server expects and parse its answers', async () => {
  const scheduleJson = serializeSchedule(schedule({ id: 'sch1' }));
  const { seen, backend } = board({
    'add-schedule': { body: { result: { schedule: scheduleJson, task: taskJson('a') } } },
    'list-schedules': { body: { result: [scheduleJson] } },
    'update-schedule': { body: { result: scheduleJson } },
    'remove-schedule': { body: { result: null } },
  });
  const draft = { title: 't', input: 'i', everyMs: 7_200_000, startAt: new Date('2027-01-01T08:00:00Z') };
  assert.equal((await backend.addSchedule(draft)).schedule.id, 'sch1');
  assert.equal((await backend.listSchedules())[0]?.everyMs, 7_200_000);
  assert.equal((await backend.updateSchedule('sch1', { paused: true })).id, 'sch1');
  await backend.removeSchedule('sch1');
  assert.deepEqual(
    seen.slice(1).map(({ command, body }) => [command, body]),
    [
      ['add-schedule', { body: { title: 't', input: 'i', everyMs: 7_200_000, startAt: '2027-01-01T08:00:00.000Z' } }],
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
  await assert.rejects(backend.addNote('dispatch', 'x'), /not a valid task id/);
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
    return new Response(JSON.stringify({ result: url.endsWith('/version') ? { contract: CONTRACT_VERSION } : [] }));
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
  const { seen, backend } = board({ 'get-task': { body: { result: taskJson('a') } } });
  const lines: string[] = [];
  const dry = dryRunBackend(backend, (line) => lines.push(line));
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
