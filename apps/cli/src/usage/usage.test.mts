import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildMachineUsage,
  createUsageStore,
  describeReached,
  earliestReset,
  isBelowPriority,
  rateLimitIn,
  reachedWindows,
  sameReading,
} from './usage.mts';
import type { StoredUsage } from './usage.mts';

const REAL_LINE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1794925200,"rateLimitType":"five_hour","overageStatus":"allowed","overageResetsAt":1796083200,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.28,"resetsAt":1794925200,"status":"allowed"},"seven_day":{"utilization":0.18,"resetsAt":1795136400,"status":"allowed"}}},"uuid":"u","session_id":"s"}';

const event = (info: unknown): string => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });

test('the rate limit event of a run gives both windows', () => {
  assert.deepEqual(rateLimitIn(REAL_LINE), {
    fiveHour: { utilization: 0.28, resetsAt: new Date(1794925200 * 1000) },
    sevenDay: { utilization: 0.18, resetsAt: new Date(1795136400 * 1000) },
  });
});

test('without unifiedWindows the top-level window and number count', () => {
  assert.deepEqual(rateLimitIn(event({ rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 1795136400 })), {
    sevenDay: { utilization: 0.5, resetsAt: new Date(1795136400 * 1000) },
  });
});

test('a rejected window without a number is full', () => {
  assert.deepEqual(rateLimitIn(event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1794925200 })), {
    fiveHour: { utilization: 1, resetsAt: new Date(1794925200 * 1000) },
  });
  assert.equal(rateLimitIn(event({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1794925200 })), undefined);
});

test('a window without a usable reset time or number is ignored, and so is any other shape', () => {
  const windows = {
    five_hour: { utilization: 0.4 },
    seven_day: { utilization: 0.4, resetsAt: 1795136400 },
  };
  assert.deepEqual(rateLimitIn(event({ unifiedWindows: windows })), {
    sevenDay: { utilization: 0.4, resetsAt: new Date(1795136400 * 1000) },
  });
  const junk = [
    '',
    'not json',
    '{"type":"rate_limit_event"',
    '{"type":"assistant","text":"rate_limit_event"}',
    '{"type":"rate_limit_event"}',
    event('x'),
    event({ unifiedWindows: { five_hour: { utilization: -1, resetsAt: 1794925200 } } }),
    event({ unifiedWindows: { five_hour: { utilization: '0.4', resetsAt: 1794925200 } } }),
    event({ unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 0 } } }),
    event({ unifiedWindows: { five_hour: { utilization: null, resetsAt: 1794925200 } } }),
    event({ rateLimitType: 'overage', utilization: 0.5, resetsAt: 1794925200 }),
  ];
  for (const line of junk) assert.equal(rateLimitIn(line), undefined, line);
});

test('two readings are the same when every window agrees', () => {
  const a = rateLimitIn(REAL_LINE)!;
  assert.ok(sameReading(a, rateLimitIn(REAL_LINE)!));
  assert.ok(!sameReading(a, { fiveHour: a.fiveHour! }));
  assert.ok(!sameReading(a, { ...a, fiveHour: { ...a.fiveHour!, utilization: 0.3 } }));
});

function inTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the store keeps what other windows said and replaces the ones a reading has', () => {
  inTempDir((dir) => {
    const store = createUsageStore(join(dir, 'state', 'usage.json'));
    assert.deepEqual(store.read(), {});
    const first = new Date('2026-11-17T10:00:00Z');
    const second = new Date('2026-11-17T11:00:00Z');
    store.record(rateLimitIn(REAL_LINE)!, first);
    store.record({ fiveHour: { utilization: 0.9, resetsAt: new Date(1794925200 * 1000) } }, second);
    assert.deepEqual(store.read(), {
      fiveHour: { utilization: 0.9, resetsAt: new Date(1794925200 * 1000).toISOString(), seenAt: second.toISOString() },
      sevenDay: { utilization: 0.18, resetsAt: new Date(1795136400 * 1000).toISOString(), seenAt: first.toISOString() },
    });
    assert.deepEqual(readdirSync(join(dir, 'state')), ['usage.json'], 'no temp file is left');
  });
});

test('a missing or malformed file reads as nothing, and the next record replaces it', () => {
  inTempDir((dir) => {
    const file = join(dir, 'usage.json');
    const store = createUsageStore(file);
    writeFileSync(file, '{not json');
    assert.deepEqual(store.read(), {});
    writeFileSync(file, JSON.stringify({ fiveHour: { utilization: 'x' }, sevenDay: 3, other: {} }));
    assert.deepEqual(store.read(), {});
    store.record(rateLimitIn(REAL_LINE)!, new Date('2026-11-17T10:00:00Z'));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['fiveHour', 'sevenDay']);
  });
});

const NOW = new Date('2026-11-17T12:00:00Z');
const stored = (utilization: number, resetsAt: string): StoredUsage['fiveHour'] => ({
  utilization,
  resetsAt,
  seenAt: '2026-11-17T11:00:00.000Z',
});
const SOON = '2026-11-17T15:00:00.000Z';
const LATER = '2026-11-20T15:00:00.000Z';

test('a window is reached at its threshold and over it, not under it', () => {
  const limits = { fiveHour: 80, priority: 'urgent' } as const;
  const reached = (utilization: number) =>
    reachedWindows({ limits, usage: { fiveHour: stored(utilization, SOON) }, now: NOW });
  assert.deepEqual(reached(0.79), []);
  assert.deepEqual(reached(0.8), [{ window: 'fiveHour', percent: 80, threshold: 80, resetsAt: new Date(SOON) }]);
  assert.equal(reached(0.97).length, 1);
  assert.equal(
    reachedWindows({ limits: { fiveHour: 29, priority: 'urgent' }, usage: { fiveHour: stored(0.29, SOON) }, now: NOW })
      .length,
    1,
  );
});

test('a reading whose window has reset is void', () => {
  const limits = { fiveHour: 80, priority: 'urgent' } as const;
  const usage = { fiveHour: stored(0.95, '2026-11-17T12:00:00.000Z') };
  assert.deepEqual(reachedWindows({ limits, usage, now: NOW }), []);
});

test('a reading whose reset is further off than any window lasts is not believed', () => {
  const limits = { sevenDay: 80, priority: 'urgent' } as const;
  const usage = { sevenDay: stored(0.95, '2026-11-27T12:00:00.000Z') };
  assert.deepEqual(reachedWindows({ limits, usage, now: NOW }), []);
});

test('only a window with a threshold counts', () => {
  const usage: StoredUsage = { fiveHour: stored(0.99, SOON), sevenDay: stored(0.95, LATER) };
  const reached = reachedWindows({ limits: { sevenDay: 90, priority: 'high' }, usage, now: NOW });
  assert.deepEqual(
    reached.map(({ window }) => window),
    ['sevenDay'],
  );
  assert.deepEqual(reachedWindows({ limits: { priority: 'high' }, usage, now: NOW }), []);
});

test('the reached windows are described and the earliest reset is found', () => {
  const reached = reachedWindows({
    limits: { fiveHour: 80, sevenDay: 90, priority: 'urgent' },
    usage: { fiveHour: stored(0.85, SOON), sevenDay: stored(0.91, LATER) },
    now: NOW,
  });
  assert.equal(
    describeReached(reached),
    `5-hour usage 85% (limit 80%, resets ${SOON}); 7-day usage 91% (limit 90%, resets ${LATER})`,
  );
  assert.equal(earliestReset(reached)?.toISOString(), SOON);
  assert.equal(earliestReset([]), undefined);
});

test('a priority is below the lowest one that may start when it ranks after it', () => {
  assert.ok(isBelowPriority('high', 'urgent'));
  assert.ok(isBelowPriority('low', 'normal'));
  assert.ok(!isBelowPriority('urgent', 'urgent'));
  assert.ok(!isBelowPriority('high', 'normal'));
});

test('the usage status carries the limits, the readings as whole percents, the reached windows and sorted task ids', () => {
  const stored: StoredUsage = {
    fiveHour: { utilization: 0.29, resetsAt: '2026-11-17T14:05:00.000Z', seenAt: '2026-11-17T12:00:00.000Z' },
  };
  const reached = [
    { window: 'fiveHour' as const, percent: 29, threshold: 20, resetsAt: new Date('2026-11-17T14:05:00.000Z') },
  ];
  assert.deepEqual(
    buildMachineUsage({
      limits: { fiveHour: 20, priority: 'high' },
      stored,
      reached,
      heldIds: ['taskB', 'taskA', 'taskB'],
      openIds: ['taskC'],
    }),
    {
      limits: { fiveHour: 20, priority: 'high' },
      windows: { fiveHour: { percent: 29, resetsAt: '2026-11-17T14:05:00.000Z', seenAt: '2026-11-17T12:00:00.000Z' } },
      reached: ['fiveHour'],
      held: ['taskA', 'taskB'],
      open: ['taskC'],
    },
  );
});

test('a machine without limits sends no limits key, and no reading is no window', () => {
  assert.deepEqual(buildMachineUsage({ limits: undefined, stored: {}, reached: [], heldIds: [], openIds: ['t1'] }), {
    windows: {},
    reached: [],
    held: [],
    open: ['t1'],
  });
});

test('the task lists are cut at the cap and an id that is no task id is left out', () => {
  const ids = Array.from({ length: 600 }, (_, index) => `t${String(index).padStart(4, '0')}`);
  const status = buildMachineUsage({
    limits: undefined,
    stored: {},
    reached: [],
    heldIds: [...ids, 'bad id'],
    openIds: [],
  });
  assert.equal(status.held.length, 500);
  assert.equal(status.held[0], 't0000');
  assert.ok(!status.held.includes('bad id'));
});

test('a utilization beyond what the board takes is clamped', () => {
  const stored: StoredUsage = {
    sevenDay: { utilization: 50, resetsAt: '2026-11-17T14:05:00.000Z', seenAt: '2026-11-17T12:00:00.000Z' },
  };
  assert.equal(
    buildMachineUsage({ limits: undefined, stored, reached: [], heldIds: [], openIds: [] }).windows.sevenDay?.percent,
    1000,
  );
});
