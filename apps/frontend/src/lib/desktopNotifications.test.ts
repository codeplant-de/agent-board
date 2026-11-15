import { beforeEach, describe, expect, it } from 'vitest';
import {
  idsNeedingMe,
  newlyNeedingMe,
  readDesktopNotificationsPreference,
  subscribeToDesktopNotificationsPreference,
  writeDesktopNotificationsPreference,
  type NotifiableTask,
} from './desktopNotifications';

const task = (id: string, status: NotifiableTask['status'], closed = false): NotifiableTask => ({ id, status, closed });

describe('newlyNeedingMe', () => {
  it('reports none on the first load, however many tasks already wait', () => {
    expect(newlyNeedingMe(null, [task('a', 'needs-me'), task('b', 'needs-me')])).toEqual([]);
  });

  it('reports a task that entered Needs me since the previous poll', () => {
    const tasks = [task('a', 'needs-me'), task('b', 'needs-me'), task('c', 'todo')];
    expect(newlyNeedingMe(new Set(['a']), tasks).map(({ id }) => id)).toEqual(['b']);
  });

  it('reports a task again once it left Needs me and came back', () => {
    const away = idsNeedingMe([task('a', 'todo')]);
    expect(newlyNeedingMe(away, [task('a', 'needs-me')]).map(({ id }) => id)).toEqual(['a']);
  });

  it('ignores a closed task', () => {
    expect(newlyNeedingMe(new Set(), [task('a', 'needs-me', true)])).toEqual([]);
    expect([...idsNeedingMe([task('a', 'needs-me', true)])]).toEqual([]);
  });
});

describe('the preference', () => {
  beforeEach(() => localStorage.clear());

  it('is off by default and remembers what was written', () => {
    expect(readDesktopNotificationsPreference()).toBe(false);
    writeDesktopNotificationsPreference(true);
    expect(readDesktopNotificationsPreference()).toBe(true);
    writeDesktopNotificationsPreference(false);
    expect(readDesktopNotificationsPreference()).toBe(false);
  });

  it('tells subscribers about a change until they unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeToDesktopNotificationsPreference(() => {
      calls += 1;
    });
    writeDesktopNotificationsPreference(true);
    expect(calls).toBe(1);
    unsubscribe();
    writeDesktopNotificationsPreference(false);
    expect(calls).toBe(1);
  });
});
