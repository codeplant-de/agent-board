import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSystem, parseUnitState, parseUnixTimestamp, parseWorkerUnits, SystemError } from '../src/system.mts';

test('only known unit states answer; anything else throws', () => {
  for (const state of ['active\n', 'activating', 'deactivating']) assert.equal(parseUnitState(state), true);
  for (const state of ['inactive\n', 'failed']) assert.equal(parseUnitState(state), false);
  for (const state of ['', 'Failed to connect to bus: No medium found', 'unknown']) {
    assert.throws(() => parseUnitState(state), SystemError);
  }
});

test('only units running `internal worker <id>` for their own id are workers', () => {
  const out = [
    'agent-board-abc12345.service loaded active running /home/u/.local/bin/board internal worker abc12345',
    '● agent-board-Xy_9-z.service loaded activating start /usr/bin/node /opt/board/apps/cli/src/main.mts internal worker Xy_9-z',
    'agent-board-dispatch.service loaded active running agent-board dispatcher: one tick',
    'agent-board-intake.service loaded active running agent-board intake: review requests to tasks',
    'agent-board-listen.service loaded active running agent-board listener: dispatch as soon as the board says tasks changed',
    'agent-board-foo.service loaded active running a unit the user made',
    'agent-board-server.service loaded active running /usr/bin/node server.js',
    'agent-board-other1.service loaded active running /home/u/.local/bin/board internal worker abc12345',
    'agent-board-listen.service loaded active running /home/u/.local/bin/board internal worker listen',
    'other.service loaded active running /home/u/.local/bin/board internal worker other',
  ].join('\n');
  assert.deepEqual(parseWorkerUnits(out), ['abc12345', 'Xy_9-z']);
  assert.deepEqual(parseWorkerUnits(''), []);
});

test('the unit start time is read from a unix timestamp', () => {
  assert.equal(parseUnixTimestamp('@1794468224\n')?.toISOString(), '2026-11-12T07:23:44.000Z');
  assert.equal(parseUnixTimestamp(''), undefined);
  assert.equal(parseUnixTimestamp('@0'), undefined);
});

test('a worker unit is started only for a task id of the safe shape, so no argument or unit name can be injected', async () => {
  const lines: string[] = [];
  const system = createSystem({ dryRun: true, print: (line) => void lines.push(line) });
  for (const hostile of [
    '--property=ExecStart=/bin/sh',
    '../x',
    'a b',
    'dispatch',
    'intake',
    'listen',
    '',
    'x'.repeat(65),
  ])
    await assert.rejects(system.startWorker(hostile), SystemError, hostile);
  assert.deepEqual(lines, []);
  await system.startWorker('Ab3dEf9x');
  assert.match(lines[0] ?? '', /--unit=agent-board-Ab3dEf9x .* -- \S+ \S+\/src\/main\.mts internal worker Ab3dEf9x$/);
});
