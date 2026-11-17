import type { MachineUsage } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { clock } from './time';
import {
  activeHold,
  describeHolding,
  describeLimits,
  describeReadings,
  describeResets,
  heldTask,
  HOLD_FRESH_MS,
  isFresh,
} from './usageHold';

const NOW = new Date('2026-11-17T12:00:00.000Z').getTime();
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const status = (overrides: Partial<MachineUsage> = {}): MachineUsage => ({
  limits: { fiveHour: 80, sevenDay: 50, priority: 'urgent' },
  windows: {
    fiveHour: { percent: 85, resetsAt: at(125), seenAt: at(-5) },
    sevenDay: { percent: 40, resetsAt: at(60 * 48), seenAt: at(-5) },
  },
  reached: ['fiveHour'],
  held: ['t1'],
  open: [],
  ...overrides,
});

const machine = (
  shown: string,
  usage: MachineUsage | null,
  overrides: { usageUpdatedAt?: string | null; revokedAt?: string | null } = {},
) => ({ shown, usage, usageUpdatedAt: at(-1), revokedAt: null, ...overrides });

const todo = { id: 't1', status: 'todo' };

describe('activeHold', () => {
  it('lists the reached windows that have not reset, and holds until the latest reset', () => {
    const hold = activeHold(
      {
        usage: status({
          reached: ['fiveHour', 'sevenDay'],
          windows: { ...status().windows, sevenDay: { percent: 60, resetsAt: at(30), seenAt: at(-1) } },
        }),
      },
      NOW,
    );
    expect(hold?.priority).toBe('urgent');
    expect(hold?.windows.map(({ window, percent, threshold }) => [window, percent, threshold])).toEqual([
      ['fiveHour', 85, 80],
      ['sevenDay', 60, 50],
    ]);
    expect(hold?.until.toISOString()).toBe(at(125));
  });

  it('drops a window whose reset is past, as the dispatcher does', () => {
    const usage = status({
      reached: ['fiveHour', 'sevenDay'],
      windows: { ...status().windows, sevenDay: { percent: 60, resetsAt: at(-1), seenAt: at(-100) } },
    });
    expect(activeHold({ usage }, NOW)?.windows.map(({ window }) => window)).toEqual(['fiveHour']);
    expect(
      activeHold({ usage: status({ windows: { fiveHour: { percent: 85, resetsAt: at(0), seenAt: at(-5) } } }) }, NOW),
    ).toBeUndefined();
  });

  it('is none without a status, without limits, without reached windows, or when a reached window cannot be described', () => {
    expect(activeHold({ usage: null }, NOW)).toBeUndefined();
    const { limits: _limits, ...withoutLimits } = status();
    expect(activeHold({ usage: withoutLimits }, NOW)).toBeUndefined();
    expect(activeHold({ usage: status({ reached: [] }) }, NOW)).toBeUndefined();
    expect(activeHold({ usage: status({ limits: { sevenDay: 50, priority: 'urgent' } }) }, NOW)).toBeUndefined();
    expect(activeHold({ usage: status({ windows: {} }) }, NOW)).toBeUndefined();
  });
});

describe('isFresh', () => {
  it('needs a machine that is not revoked and sent its status within ten minutes', () => {
    expect(isFresh({ revokedAt: null, usageUpdatedAt: at(-10) }, NOW)).toBe(true);
    expect(HOLD_FRESH_MS).toBe(600_000);
    expect(isFresh({ revokedAt: null, usageUpdatedAt: at(-11) }, NOW)).toBe(false);
    expect(isFresh({ revokedAt: null, usageUpdatedAt: null }, NOW)).toBe(false);
    expect(isFresh({ revokedAt: at(-1), usageUpdatedAt: at(-1) }, NOW)).toBe(false);
  });
});

describe('heldTask', () => {
  it('is held by a fresh machine that lists it with an active hold, with the machine, windows and time', () => {
    const hold = heldTask(todo, [machine('laptop', status())], NOW);
    expect(hold?.until.toISOString()).toBe(at(125));
    expect(hold?.machines.map(({ name }) => name)).toEqual(['laptop']);
    expect(describeHolding(hold!.machines[0]!, NOW)).toBe(
      `laptop holds tasks below urgent: 5-hour usage 85% (limit 80%) until ${clock(at(125), NOW)}`,
    );
  });

  it('is only for a Todo task', () => {
    for (const status_ of ['backlog', 'running', 'waiting', 'needs-me', 'done'])
      expect(heldTask({ id: 't1', status: status_ }, [machine('laptop', status())], NOW)).toBeUndefined();
  });

  it('is not held when a fresh machine could still run it', () => {
    const other = machine('desktop', status({ held: [], open: ['t1'], reached: [] }));
    expect(heldTask(todo, [machine('laptop', status()), other], NOW)).toBeUndefined();
  });

  it('is held by every machine that holds it, until the earliest of them', () => {
    const sooner = status({ windows: { fiveHour: { percent: 90, resetsAt: at(20), seenAt: at(-1) } } });
    const hold = heldTask(todo, [machine('laptop', status()), machine('desktop', sooner)], NOW);
    expect(hold?.machines.map(({ name }) => name)).toEqual(['laptop', 'desktop']);
    expect(hold?.until.toISOString()).toBe(at(20));
  });

  it('ignores machines that are stale, revoked or not holding', () => {
    expect(heldTask(todo, [machine('laptop', status(), { usageUpdatedAt: at(-30) })], NOW)).toBeUndefined();
    expect(heldTask(todo, [machine('laptop', status(), { revokedAt: at(-1) })], NOW)).toBeUndefined();
    expect(heldTask(todo, [machine('laptop', status({ reached: [] }))], NOW)).toBeUndefined();
    expect(heldTask(todo, [machine('laptop', null)], NOW)).toBeUndefined();
    expect(heldTask({ id: 'other', status: 'todo' }, [machine('laptop', status())], NOW)).toBeUndefined();
  });

  it('a stale machine that lists the task as open does not keep it from being held', () => {
    const staleOpen = machine('old', status({ held: [], open: ['t1'], reached: [] }), { usageUpdatedAt: at(-60) });
    expect(heldTask(todo, [machine('laptop', status()), staleOpen], NOW)?.machines).toHaveLength(1);
  });

  it('is not held when the reset has passed', () => {
    const gone = status({ windows: { fiveHour: { percent: 85, resetsAt: at(-1), seenAt: at(-100) } } });
    expect(heldTask(todo, [machine('laptop', gone)], NOW)).toBeUndefined();
  });
});

describe('the lines of a status', () => {
  it('say the readings, the limits and the resets', () => {
    expect(describeReadings({ usage: status() }, NOW)).toBe('5-hour 85% · 7-day 40%');
    expect(describeLimits({ usage: status() })).toBe('5-hour 80% · 7-day 50% · holds below urgent');
    expect(describeResets({ usage: status() }, NOW)).toBe(
      `5-hour resets ${clock(at(125), NOW)}; 7-day resets ${clock(at(60 * 48), NOW)}`,
    );
  });

  it('leave out a window whose reset has passed', () => {
    const usage = status({
      windows: { ...status().windows, sevenDay: { percent: 40, resetsAt: at(-1), seenAt: at(-100) } },
    });
    expect(describeReadings({ usage }, NOW)).toBe('5-hour 85%');
    expect(describeResets({ usage }, NOW)).toBe(`5-hour resets ${clock(at(125), NOW)}`);
  });

  it('are empty without a status, readings or limits', () => {
    expect(describeReadings({ usage: null }, NOW)).toBe('');
    expect(describeLimits({ usage: status({ limits: undefined as never }) })).toBe('');
    expect(describeResets({ usage: null }, NOW)).toBe('');
    expect(describeReadings({ usage: status({ windows: {} }) }, NOW)).toBe('');
  });
});
