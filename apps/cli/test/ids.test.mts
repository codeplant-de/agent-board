import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '../src/cli.mts';
import { resolveScheduleId, resolveTaskId } from '../src/ids.mts';
import { fakeBackend, schedule, task } from './helpers.mts';

function setup() {
  const backend = fakeBackend([
    task({ id: 'Ab3dEf9x', title: 'First' }),
    task({ id: 'Ab3xY9Qz', title: 'Second' }),
    task({ id: 'Zk7mNp2q', title: 'Closed one', closed: true, status: 'done' }),
  ]);
  backend.schedules = [schedule({ id: 'Sc1aBcDe' }), schedule({ id: 'Sc1xYzQq' }), schedule({ id: 'Rq9wErTy' })];
  const calls: string[] = [];
  const listTasks = backend.listTasks;
  backend.listTasks = async (options) => {
    calls.push(`listTasks${options?.all ? ' all' : ''}`);
    return listTasks(options);
  };
  const listSchedules = backend.listSchedules;
  backend.listSchedules = async () => {
    calls.push('listSchedules');
    return listSchedules();
  };
  return { backend, calls };
}

const OUT = { inRun: false };

test('a full id passes through with no request', async () => {
  const { backend, calls } = setup();
  assert.equal(await resolveTaskId(backend, 'Ab3dEf9x', OUT), 'Ab3dEf9x');
  assert.equal(await resolveTaskId(backend, 'ab3def9x', OUT), 'ab3def9x', 'a full-length id is the board to judge');
  assert.equal(await resolveScheduleId(backend, 'Sc1aBcDe', OUT), 'Sc1aBcDe');
  assert.deepEqual(calls, []);
});

test('a prefix of 3 or more characters matches case-insensitively, closed tasks included', async () => {
  const { backend, calls } = setup();
  assert.equal(await resolveTaskId(backend, 'ab3d', OUT), 'Ab3dEf9x');
  assert.equal(await resolveTaskId(backend, 'ZK7', OUT), 'Zk7mNp2q');
  assert.deepEqual(calls, ['listTasks all', 'listTasks all']);
});

test('an ambiguous prefix lists the candidates, an unknown or too short one is refused', async () => {
  const { backend } = setup();
  await assert.rejects(resolveTaskId(backend, 'Ab3', OUT), (error: Error) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /"Ab3" matches 2 tasks:\n {2}Ab3dEf9x {2}First\n {2}Ab3xY9Qz {2}Second/);
    return true;
  });
  await assert.rejects(resolveTaskId(backend, 'nope', OUT), /no task starts with "nope"/);
  await assert.rejects(resolveTaskId(backend, 'Ab', OUT), /too short/);
});

test('a task link yields its id whatever its origin: the board builds links from its public URL', async () => {
  const { backend, calls } = setup();
  assert.equal(await resolveTaskId(backend, 'https://board.example/t/Ab3dEf9x', OUT), 'Ab3dEf9x');
  assert.equal(await resolveTaskId(backend, 'http://localhost:5173/t/Ab3dEf9x/', OUT), 'Ab3dEf9x');
  await assert.rejects(resolveTaskId(backend, 'https://board.example/schedules', OUT), /not a task link/);
  await assert.rejects(resolveTaskId(backend, 'https://board.example/t/a/b', OUT), /not a task link/);
  assert.deepEqual(calls, []);
});

test('an exact-case prefix wins over a case-insensitive one', async () => {
  const backend = fakeBackend([task({ id: 'Ab3dEf9x', title: 'A' }), task({ id: 'aB3zzzzz', title: 'B' })]);
  assert.equal(await resolveTaskId(backend, 'Ab3', OUT), 'Ab3dEf9x');
  assert.equal(await resolveTaskId(backend, 'aB3', OUT), 'aB3zzzzz');
  await assert.rejects(resolveTaskId(backend, 'AB3', OUT), /matches 2 tasks/);
  assert.equal(await resolveTaskId(backend, 'ab3d', OUT), 'Ab3dEf9x');
});

test('schedule ids resolve by prefix the same way', async () => {
  const { backend } = setup();
  assert.equal(await resolveScheduleId(backend, 'rq9', OUT), 'Rq9wErTy');
  await assert.rejects(resolveScheduleId(backend, 'sc1', OUT), /matches 2 schedules/);
  await assert.rejects(resolveScheduleId(backend, 'zzz', OUT), /no schedule starts with/);
});

test('inside a run nothing is resolved: the id is used as given, with no request', async () => {
  const { backend, calls } = setup();
  const inRun = { inRun: true };
  assert.equal(await resolveTaskId(backend, 'Ab3', inRun), 'Ab3');
  assert.equal(
    await resolveTaskId(backend, 'https://board.example/t/Ab3dEf9x', inRun),
    'https://board.example/t/Ab3dEf9x',
  );
  assert.equal(await resolveScheduleId(backend, 'rq9', inRun), 'rq9');
  assert.deepEqual(calls, []);
});

test('an id is 12 characters or, for older tasks, 8: those are whole ids, the lengths between are the start of one', async () => {
  const backend = fakeBackend([task({ id: 'Ab3dEf9xK2mN', title: 'New' }), task({ id: 'Zq8wErTy', title: 'Old' })]);
  const calls: string[] = [];
  const list = backend.listTasks;
  backend.listTasks = async (options) => {
    calls.push('list');
    return list(options);
  };
  assert.equal(await resolveTaskId(backend, 'Ab3dEf9xK2mN', OUT), 'Ab3dEf9xK2mN');
  assert.equal(await resolveTaskId(backend, 'Zq8wErTy', OUT), 'Zq8wErTy');
  assert.deepEqual(calls, [], 'a whole id costs no request');
  assert.equal(await resolveTaskId(backend, 'Ab3dEf9xK2', OUT), 'Ab3dEf9xK2mN');
  assert.equal(await resolveTaskId(backend, 'Ab3dEf9', OUT), 'Ab3dEf9xK2mN');
  assert.deepEqual(calls, ['list', 'list']);
  // Eight characters of a twelve-character id read as a whole, unknown id: the board says so.
  assert.equal(await resolveTaskId(backend, 'Ab3dEf9x', OUT), 'Ab3dEf9x');
});
