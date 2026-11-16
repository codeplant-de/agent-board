import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Changes } from './changes';

describe('Changes', () => {
  let changes: Changes;
  const heard = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    heard.mockReset();
    changes = new Changes(100);
    changes.subscribe('jascha', heard);
  });

  afterEach(() => {
    changes.close();
    vi.useRealTimers();
  });

  it('gives one event for a burst, the window after its last call', () => {
    changes.notify('jascha');
    vi.advanceTimersByTime(60);
    changes.notify('jascha');
    vi.advanceTimersByTime(60);
    changes.notify('jascha');
    vi.advanceTimersByTime(99);
    expect(heard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(heard).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('gives one event per call when the calls are further apart than the window', () => {
    changes.notify('jascha');
    vi.advanceTimersByTime(100);
    changes.notify('jascha');
    vi.advanceTimersByTime(100);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("debounces each owner on its own, and tells only that owner's listeners", () => {
    const carol = vi.fn();
    changes.subscribe('carol', carol);
    changes.notify('jascha');
    vi.advanceTimersByTime(60);
    changes.notify('carol');
    vi.advanceTimersByTime(40);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(carol).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(carol).toHaveBeenCalledTimes(1);
  });

  it('drops a pending event on close', () => {
    changes.notify('jascha');
    changes.close();
    vi.advanceTimersByTime(1000);
    expect(heard).not.toHaveBeenCalled();
  });
});
