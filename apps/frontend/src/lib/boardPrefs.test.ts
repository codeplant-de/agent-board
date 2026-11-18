import { describe, expect, it } from 'vitest';
import { BOARD_PREF_KEYS, clearBoardPrefs, readBoardPrefs, restoreBoardPrefs } from './boardPrefs';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};

const [KNOWN = ''] = BOARD_PREF_KEYS;

describe('board preferences', () => {
  it('reads only the known keys', () => {
    expect(readBoardPrefs(memoryStorage({ [KNOWN]: 'on', other: 'x' }))).toEqual({ [KNOWN]: 'on' });
  });

  it('restores only the known keys', () => {
    const storage = memoryStorage();
    restoreBoardPrefs({ [KNOWN]: 'on', other: 'x' }, storage);
    expect([...storage.data.keys()]).toEqual([KNOWN]);
  });

  it('clears the known keys and leaves the rest', () => {
    const storage = memoryStorage({ [KNOWN]: 'on', other: 'x' });
    clearBoardPrefs(storage);
    expect([...storage.data.keys()]).toEqual(['other']);
  });
});
