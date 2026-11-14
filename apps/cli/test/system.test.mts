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

test('worker units are listed by short link, the dispatcher and intake units are not', () => {
  const out = [
    'agent-board-abc12345.service loaded active running agent-board-abc12345.service',
    'agent-board-dispatch.service loaded active running agent-board dispatcher: one tick',
    'agent-board-intake.service loaded active running intake',
    'other.service loaded active running other',
  ].join('\n');
  assert.deepEqual(parseWorkerUnits(out), ['abc12345']);
  assert.deepEqual(parseWorkerUnits(''), []);
});

test('the unit start time is read from a unix timestamp', () => {
  assert.equal(parseUnixTimestamp('@1794468224\n')?.toISOString(), '2026-11-12T07:23:44.000Z');
  assert.equal(parseUnixTimestamp(''), undefined);
  assert.equal(parseUnixTimestamp('@0'), undefined);
});

test('a worker unit is started only for a task id of the safe shape, so no argument or unit name can be injected', async () => {
  const lines: string[] = [];
  const system = createSystem({ workerScript: '/w.mts', dryRun: true, print: (line) => void lines.push(line) });
  for (const hostile of ['--property=ExecStart=/bin/sh', '../x', 'a b', 'dispatch', 'intake', '', 'x'.repeat(65)])
    await assert.rejects(system.startWorker(hostile), SystemError, hostile);
  assert.deepEqual(lines, []);
  await system.startWorker('Ab3dEf9x');
  assert.match(lines[0] ?? '', /--unit=agent-board-Ab3dEf9x .* -- \S+ \/w\.mts Ab3dEf9x$/);
});
