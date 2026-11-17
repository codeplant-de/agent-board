import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractError, parseWireTask, parseWireWatches, parseWireWatchStopAck, SEALED_LIMITS } from './contract.mts';
import { deriveKeys, generateDataKey, open, seal } from './crypto.mts';
import { openWatches, sealWatches, watchesBinding } from './sealing.mts';
import type { Opener, Sealer } from './sealing.mts';
import {
  isWatchId,
  isWatchName,
  MAX_TASK_WATCHES,
  parseTaskWatch,
  parseTaskWatches,
  parseWatchIds,
  taskWatchesJson,
} from './watches.mts';
import type { TaskWatch } from './watches.mts';

const keys = await deriveKeys(generateDataKey(), 'alice', { index: true });
const seals: Sealer = async ({ field, context }, text) => seal(keys, field, context, text);
const opens: Opener = async ({ field, context }, value) => {
  try {
    return await open(keys, field, context, value);
  } catch {
    return undefined;
  }
};

const TASK = 'Ab3dEf9x';
const hex = (n: number): string => n.toString(16).padStart(16, '0');

const watch = (overrides: Partial<TaskWatch> = {}): TaskWatch => ({
  id: hex(1),
  name: 'ci',
  kind: 'ci',
  label: 'CI #116',
  status: '4 of 7 passed, 3 running',
  deadline: '2026-11-17T14:20:00.000Z',
  lastAttemptAt: '2026-11-17T13:20:00.000Z',
  ...overrides,
});

test('a watch id is 16 lowercase hex digits and a watch name the CLI’s name shape', () => {
  assert.equal(isWatchId('0123456789abcdef'), true);
  for (const bad of ['0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', '', 5, null, '0123456789abcdeg'])
    assert.equal(isWatchId(bad), false, String(bad));
  assert.equal(isWatchName('ci'), true);
  assert.equal(isWatchName('a'.repeat(32)), true);
  for (const bad of ['', 'CI', '-ci', 'a'.repeat(33), 'a b', 'a/b']) assert.equal(isWatchName(bad), false, bad);
});

test('a watch of the documented shape is read as it is, and the optional look is optional', () => {
  assert.deepEqual(parseTaskWatch(watch()), watch());
  const { lastAttemptAt: _look, ...unlooked } = watch({ kind: 'timer', label: 'timer', status: 'fires at 14:20' });
  assert.deepEqual(parseTaskWatch(unlooked), unlooked);
  assert.deepEqual(parseTaskWatch({ ...watch(), command: 'rm -rf /', extra: 1 }), watch());
  const merge = watch({ name: 'pr-merged', kind: 'pr', label: 'merge of #116', status: 'still open' });
  assert.deepEqual(parseTaskWatch(merge), merge);
});

test('a watch of any other shape is refused', () => {
  const bad: Record<string, unknown>[] = [
    { id: 'nope' },
    { name: 'Not Valid' },
    { kind: 'cron' },
    { label: '' },
    { label: 'x'.repeat(121) },
    { label: 'two\nlines' },
    { status: 'x'.repeat(201) },
    { status: 'two\nlines' },
    { status: 'bell\u0007' },
    { status: 5 },
    { deadline: 'tomorrow' },
    { deadline: '2026-13-45T99:00:00Z' },
    { deadline: undefined },
    { lastAttemptAt: 'yesterday' },
  ];
  for (const change of bad) assert.equal(parseTaskWatch({ ...watch(), ...change }), undefined, JSON.stringify(change));
  assert.equal(parseTaskWatch('ci'), undefined);
  assert.equal(parseTaskWatch(null), undefined);
  assert.deepEqual(
    parseTaskWatch(watch({ label: 'x'.repeat(120), status: '' })),
    watch({ label: 'x'.repeat(120), status: '' }),
  );
});

test('a list keeps the entries that fit, once per id, and is unreadable when it is not the document or holds too many', () => {
  const kept = parseTaskWatches({
    watches: [watch(), { id: 'bad' }, watch({ name: 'again' }), watch({ id: hex(2), name: 'b' })],
  });
  assert.deepEqual(kept, { watches: [watch(), watch({ id: hex(2), name: 'b' })], pendingEvents: 0 });
  assert.deepEqual(parseTaskWatches({ watches: [], pendingEvents: 3 }), { watches: [], pendingEvents: 3 });
  for (const bad of [
    null,
    [],
    'x',
    {},
    { watches: 'x' },
    { watches: {} },
    { watches: [], pendingEvents: -1 },
    { watches: [], pendingEvents: 1.5 },
    { watches: [], pendingEvents: '2' },
  ])
    assert.equal(parseTaskWatches(bad), undefined, JSON.stringify(bad));
  const many = (n: number) => ({
    watches: Array.from({ length: n }, (_, i) => watch({ id: hex(i + 1), name: `w${i}` })),
  });
  assert.equal(parseTaskWatches(many(MAX_TASK_WATCHES))?.watches.length, MAX_TASK_WATCHES);
  assert.equal(parseTaskWatches(many(MAX_TASK_WATCHES + 1)), undefined);
});

test('the document of a list holds the documented keys only', () => {
  const json = JSON.parse(taskWatchesJson([{ ...watch(), command: 'secret' } as TaskWatch], 2));
  assert.deepEqual(json, { watches: [watch()], pendingEvents: 2 });
  assert.deepEqual(JSON.parse(taskWatchesJson([], 0)), { watches: [], pendingEvents: 0 });
});

test('the watches of a task are bound to the task and its agent, and open as a list', async () => {
  assert.deepEqual(watchesBinding(TASK), { field: 'watches', context: `task:${TASK}:agent` });
  const sealed = await sealWatches(seals, TASK, [watch(), watch({ id: hex(2), name: 'b', kind: 'command' })], 2);
  assert.deepEqual(await openWatches(opens, TASK, sealed), {
    watches: [watch(), watch({ id: hex(2), name: 'b', kind: 'command' })],
    pendingEvents: 2,
    unreadable: false,
  });
  assert.deepEqual(await openWatches(opens, TASK, null), { watches: null, pendingEvents: 0, unreadable: false });
  assert.deepEqual(await openWatches(opens, TASK, undefined), {
    watches: null,
    pendingEvents: 0,
    unreadable: false,
  });
  assert.deepEqual(await openWatches(opens, TASK, await sealWatches(seals, TASK, [], 0)), {
    watches: [],
    pendingEvents: 0,
    unreadable: false,
  });
});

test('watches that do not open under exactly the task’s binding are unreadable', async () => {
  const unreadable = { watches: null, pendingEvents: 0, unreadable: true };
  const json = taskWatchesJson([watch()], 0);
  const sealed = await sealWatches(seals, TASK, [watch()], 0);
  assert.deepEqual(await openWatches(opens, 'Zz9dEf9x', sealed), unreadable);
  for (const other of [
    await seal(keys, 'watches', `task:${TASK}:user`, json),
    await seal(keys, 'pr', watchesBinding(TASK).context, json),
    await seal(keys, 'watches', watchesBinding(TASK).context, 'not json'),
    await seal(keys, 'watches', watchesBinding(TASK).context, '{"watches":"x"}'),
    json,
  ])
    assert.deepEqual(await openWatches(opens, TASK, other), unreadable);
});

test('watches are sealed only as at most 32 well-formed entries within the limit', async () => {
  await assert.rejects(sealWatches(seals, TASK, [watch({ name: 'Bad Name' })], 0), ContractError);
  await assert.rejects(sealWatches(seals, TASK, [watch(), watch()], 0), ContractError);
  const many = Array.from({ length: MAX_TASK_WATCHES + 1 }, (_, i) => watch({ id: hex(i + 1), name: `w${i}` }));
  await assert.rejects(sealWatches(seals, TASK, many, 0), /at most 32/);
  assert.equal(SEALED_LIMITS.watches, 32 * 1024);
  // 32 entries of the longest label and status fit the limit.
  const full = Array.from({ length: MAX_TASK_WATCHES }, (_, i) =>
    watch({ id: hex(i + 1), name: `w${i}`, label: 'é'.repeat(120), status: 'é'.repeat(200) }),
  );
  await sealWatches(seals, TASK, full, 0);
});

test('the set-watches body is a sealed document or null, and nothing else', async () => {
  const sealed = await sealWatches(seals, TASK, [watch()], 0);
  assert.deepEqual(parseWireWatches({ watches: sealed }), { watches: sealed });
  assert.deepEqual(parseWireWatches({ watches: null }), { watches: null });
  assert.throws(() => parseWireWatches({ watches: '{"watches":[]}' }), /must be encrypted/);
  assert.throws(() => parseWireWatches({ watches: sealed, extra: 1 }), /unknown key "extra"/);
  assert.throws(() => parseWireWatches({}), /watches/);
  assert.throws(() => parseWireWatches('x'), /JSON object/);
  assert.throws(() => parseWireWatches({ watches: `abe1.${'A'.repeat(50_000)}` }), /too long/);
});

test('the ack-watch-stops body is at most 32 watch ids', () => {
  assert.deepEqual(parseWireWatchStopAck({ ids: [hex(1), hex(2)] }), { ids: [hex(1), hex(2)] });
  assert.deepEqual(parseWireWatchStopAck({ ids: [] }), { ids: [] });
  for (const bad of [
    {},
    { ids: 'x' },
    { ids: ['nope'] },
    { ids: [5] },
    { ids: [hex(1)], extra: 1 },
    { ids: Array(33).fill(hex(1)) },
  ])
    assert.throws(() => parseWireWatchStopAck(bad), ContractError, JSON.stringify(bad).slice(0, 40));
  assert.deepEqual(parseWatchIds([hex(1)]), [hex(1)]);
  assert.equal(parseWatchIds([hex(1), 'x']), undefined);
});

test('a task carries its sealed watches and its stop requests, and a server without task.watches leaves both out', async () => {
  const wire = {
    id: TASK,
    title: await seal(keys, 'title', '', 't'),
    input: await seal(keys, 'input', '', 'i'),
    status: 'waiting',
    priority: 'normal',
    model: null,
    closed: false,
    machine: 'laptop',
    sessionId: null,
    workdir: null,
    next: 'resume',
    head: null,
    openQuestion: false,
    createdBy: 'user',
    lane: null,
    borrowed: false,
    lastActiveAt: null,
    runStartedAt: null,
    paused: false,
    notBefore: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
  };
  const older = parseWireTask(wire);
  assert.equal(older.watches, undefined);
  assert.equal(older.watchStops, undefined);
  const sealed = await sealWatches(seals, TASK, [watch()], 0);
  const newer = parseWireTask({ ...wire, watches: sealed, watchStops: [hex(1), 'junk', hex(2)] });
  assert.equal(newer.watches, sealed);
  assert.deepEqual(newer.watchStops, [hex(1), hex(2)]);
  assert.equal(parseWireTask({ ...wire, watches: null, watchStops: [] }).watches, null);
  assert.throws(() => parseWireTask({ ...wire, watches: 5 }), /watches must be a string or null/);
  assert.throws(() => parseWireTask({ ...wire, watchStops: 'x' }), /watchStops must be a list/);
  assert.equal(parseWireTask({ ...wire, watchStops: Array(40).fill(hex(1)) }).watchStops?.length, MAX_TASK_WATCHES);
});
