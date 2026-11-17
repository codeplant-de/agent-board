import assert from 'node:assert/strict';
import { test } from 'node:test';
import { machineUsageJson, MAX_USAGE_TASKS, parseMachineUsage, usageProblem } from './machineUsage.mts';
import type { MachineUsage } from './machineUsage.mts';

const WINDOW = { percent: 85, resetsAt: '2026-11-17T14:05:00.000Z', seenAt: '2026-11-17T12:00:00.000Z' };

const USAGE: MachineUsage = {
  limits: { fiveHour: 80, sevenDay: 50, priority: 'high' },
  windows: { fiveHour: WINDOW, sevenDay: { ...WINDOW, percent: 40 } },
  reached: ['fiveHour'],
  held: ['taskA', 'taskB'],
  open: ['taskC'],
};

test('a usage status survives its own document', () => {
  assert.deepEqual(parseMachineUsage(JSON.parse(machineUsageJson(USAGE))), USAGE);
  assert.equal(usageProblem(USAGE), undefined);
});

test('the document has a fixed order and no unknown fields', () => {
  const shuffled = {
    open: ['taskC'],
    held: ['taskA', 'taskB'],
    reached: ['fiveHour'],
    windows: {
      sevenDay: { seenAt: WINDOW.seenAt, resetsAt: WINDOW.resetsAt, percent: 40, extra: 1 },
      fiveHour: WINDOW,
    },
    limits: { priority: 'high', sevenDay: 50, fiveHour: 80 },
    extra: 1,
  };
  const parsed = parseMachineUsage(shuffled);
  assert.ok(parsed);
  assert.equal(machineUsageJson(parsed), machineUsageJson(USAGE));
});

test('a status without limits, windows or tasks is readable', () => {
  assert.deepEqual(parseMachineUsage({}), { windows: {}, reached: [], held: [], open: [] });
  assert.equal(
    machineUsageJson({ windows: {}, reached: [], held: [], open: [] }),
    '{"windows":{},"reached":[],"held":[],"open":[]}',
  );
});

test('anything that is not a usage document is unreadable', () => {
  for (const bad of [null, 'x', 3, [], { windows: 'x' }, { reached: 'x' }, { held: 'x' }, { open: {} }])
    assert.equal(parseMachineUsage(bad), undefined, JSON.stringify(bad));
});

test('more task ids than the cap make the document unreadable', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `t${index}`);
  assert.equal(parseMachineUsage({ held: ids(MAX_USAGE_TASKS + 1) }), undefined);
  assert.equal(parseMachineUsage({ open: ids(MAX_USAGE_TASKS + 1) }), undefined);
  assert.equal(parseMachineUsage({ held: ids(MAX_USAGE_TASKS) })?.held.length, MAX_USAGE_TASKS);
});

test('an entry of the wrong shape is dropped and the rest is kept', () => {
  const parsed = parseMachineUsage({
    limits: { fiveHour: 0, sevenDay: 101, priority: 'urgent' },
    windows: {
      fiveHour: { ...WINDOW, percent: -1 },
      sevenDay: { ...WINDOW, percent: 1001 },
    },
    reached: ['fiveHour', 'monthly', 3, 'sevenDay'],
    held: ['good', 'has space', 7, '../x', 'dispatch'],
    open: ['ok_1'],
  });
  assert.deepEqual(parsed, {
    limits: { priority: 'urgent' },
    windows: {},
    reached: ['fiveHour', 'sevenDay'],
    held: ['good'],
    open: ['ok_1'],
  });
});

test('limits need a priority, windows need numbers and times', () => {
  assert.equal(parseMachineUsage({ limits: { fiveHour: 80, priority: 'soon' } })?.limits, undefined);
  assert.equal(parseMachineUsage({ limits: { fiveHour: 80 } })?.limits, undefined);
  assert.equal(parseMachineUsage({ limits: { fiveHour: 80.5, priority: 'low' } })?.limits?.fiveHour, undefined);
  const windows = (window: unknown) => parseMachineUsage({ windows: { fiveHour: window } })?.windows;
  assert.deepEqual(windows({ ...WINDOW, resetsAt: 'tomorrow' }), {});
  assert.deepEqual(windows({ ...WINDOW, seenAt: 5 }), {});
  assert.deepEqual(windows({ ...WINDOW, percent: Number.NaN }), {});
  assert.deepEqual(windows({ ...WINDOW, percent: '85' }), {});
  assert.deepEqual(windows({ ...WINDOW, resetsAt: `2026-11-17T14:05:00.000Z${' '.repeat(50)}` }), {});
  assert.deepEqual(windows(WINDOW), { fiveHour: WINDOW });
});

test('the problem check names what the board would drop', () => {
  assert.match(usageProblem({ ...USAGE, held: ['a b'] }) ?? '', /not of its shape/);
  assert.match(
    usageProblem({ ...USAGE, open: Array.from({ length: 501 }, (_, i) => `t${i}`) }) ?? '',
    /more than 500 open/,
  );
  assert.match(
    usageProblem({ ...USAGE, held: Array.from({ length: 501 }, (_, i) => `t${i}`) }) ?? '',
    /more than 500 held/,
  );
  assert.match(
    usageProblem({ ...USAGE, windows: { fiveHour: { ...WINDOW, percent: 2000 } } }) ?? '',
    /not of its shape/,
  );
});
