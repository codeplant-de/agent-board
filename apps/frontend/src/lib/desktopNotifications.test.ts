import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  idsNeedingMe,
  newlyNeedingMe,
  resetNotificationWorkerForTests,
  showNotification,
  subscribeToNotificationClicks,
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

describe('showNotification', () => {
  const stubServiceWorker = (value: unknown) => vi.stubGlobal('navigator', { serviceWorker: value });

  beforeEach(() => resetNotificationWorkerForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('shows through the service worker with the path and the tag', async () => {
    const show = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker({ register: vi.fn().mockResolvedValue({}), ready: Promise.resolve({ showNotification: show }) });
    await showNotification('Title', { body: 'Needs you', tag: 'a', path: '/t/a' });
    expect(show).toHaveBeenCalledWith('Title', {
      body: 'Needs you',
      tag: 'a',
      icon: '/favicon.svg',
      data: { path: '/t/a' },
    });
  });

  it('falls back to the constructor without a service worker, and a click opens the path', async () => {
    const instance: { onclick?: () => void; close: () => void } = { close: vi.fn() };
    const constructor = vi.fn(function () {
      return instance;
    });
    vi.stubGlobal('Notification', constructor);
    stubServiceWorker(undefined);
    vi.stubGlobal('navigator', {});
    const open = vi.fn();
    await showNotification('Title', { body: 'Needs you', tag: 'a', path: '/t/a', open });
    expect(constructor).toHaveBeenCalledWith('Title', { body: 'Needs you', tag: 'a', icon: '/favicon.svg' });
    instance.onclick?.();
    expect(open).toHaveBeenCalledWith('/t/a');
    expect(instance.close).toHaveBeenCalled();
  });

  it('falls back when the worker fails to register', async () => {
    const constructor = vi.fn(function () {
      return { close: vi.fn() };
    });
    vi.stubGlobal('Notification', constructor);
    stubServiceWorker({
      register: vi.fn().mockRejectedValue(new Error('refused')),
      ready: new Promise(() => undefined),
    });
    await showNotification('Title', { body: 'Needs you' });
    expect(constructor).toHaveBeenCalledOnce();
  });
});

describe('subscribeToNotificationClicks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens a valid path, ignores anything else, and stops after unsubscribing', () => {
    const target = new EventTarget();
    vi.stubGlobal('navigator', { serviceWorker: target });
    const open = vi.fn();
    const unsubscribe = subscribeToNotificationClicks(open);
    const send = (data: unknown) => target.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'agent-board:open', path: '/t/abc_1' });
    send({ type: 'agent-board:open', path: '/settings' });
    send({ type: 'agent-board:open', path: 'https://evil.example/t/a' });
    send({ type: 'other', path: '/t/abc' });
    send('/t/abc');
    send(null);
    expect(open.mock.calls).toEqual([['/t/abc_1']]);
    unsubscribe();
    send({ type: 'agent-board:open', path: '/t/abc' });
    expect(open).toHaveBeenCalledOnce();
  });

  it('does nothing without a service worker', () => {
    vi.stubGlobal('navigator', {});
    expect(subscribeToNotificationClicks(vi.fn())()).toBeUndefined();
  });
});
