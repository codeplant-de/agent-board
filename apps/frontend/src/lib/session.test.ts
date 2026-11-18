import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markSessionChanged, SESSION_MARKER_KEY, subscribeToSession } from './session';

beforeEach(() => localStorage.clear());

describe('the session marker', () => {
  it('is a timestamp in localStorage, which other tabs share, and holds no token', () => {
    markSessionChanged();
    expect(Object.keys(localStorage)).toEqual([SESSION_MARKER_KEY]);
    expect(localStorage.getItem(SESSION_MARKER_KEY)).toMatch(/^\d+$/);
    expect(Object.values(sessionStorage)).toEqual([]);
  });

  it('survives storage that refuses to answer', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => markSessionChanged()).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe('noticing another tab', () => {
  const otherTab = (key: string | null) =>
    window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));

  it('reports a sign-in or sign-out elsewhere, and not an unrelated key', () => {
    const changed = vi.fn();
    const stop = subscribeToSession(changed);
    otherTab('agent-board.desktopNotifications');
    expect(changed).not.toHaveBeenCalled();
    otherTab(SESSION_MARKER_KEY);
    otherTab(null);
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    otherTab(SESSION_MARKER_KEY);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('does not report what this tab itself writes', () => {
    const changed = vi.fn();
    const stop = subscribeToSession(changed);
    markSessionChanged();
    expect(changed).not.toHaveBeenCalled();
    stop();
  });
});
