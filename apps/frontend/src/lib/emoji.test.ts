import { isEmojiIcon } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import {
  loadEmojiGroups,
  MAX_RECENT_EMOJIS,
  readEmojiGroups,
  readRecentEmojis,
  RECENT_EMOJIS_KEY,
  rememberRecentEmoji,
  searchEmojis,
} from './emoji';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

const blocked = {
  getItem: (): string | null => {
    throw new Error('SecurityError');
  },
  setItem: (): void => {
    throw new Error('SecurityError');
  },
};

describe('the emoji list', () => {
  it('has every group but the components, in Unicode order, and only emojis a task can carry', async () => {
    const groups = await loadEmojiGroups();
    expect(groups.map(({ label }) => label)).toEqual([
      'Smileys & emotion',
      'People & body',
      'Animals & nature',
      'Food & drink',
      'Travel & places',
      'Activities',
      'Objects',
      'Symbols',
      'Flags',
    ]);
    const all = groups.flatMap(({ emojis }) => emojis);
    expect(all.length).toBeGreaterThan(1500);
    expect(all.every(({ emoji }) => isEmojiIcon(emoji))).toBe(true);
    expect(all.some(({ emoji }) => emoji === '🏻')).toBe(false);
    expect(groups[0]?.emojis[0]?.emoji).toBe('😀');
  });

  it('leaves out an emoji the system font cannot draw', async () => {
    const groups = await readEmojiGroups((emoji) => emoji !== '🫠');
    const all = groups.flatMap(({ emojis }) => emojis.map(({ emoji }) => emoji));
    expect(all).not.toContain('🫠');
    expect(all).toContain('😀');
  });

  it('finds an emoji by every word of its name or tags', async () => {
    const groups = await loadEmojiGroups();
    expect(searchEmojis(groups, 'rocket').map(({ emoji }) => emoji)).toContain('🚀');
    expect(searchEmojis(groups, 'THUMBS up').map(({ emoji }) => emoji)).toContain('👍');
    expect(searchEmojis(groups, '  ')).toEqual([]);
    expect(searchEmojis(groups, 'zzqqxx')).toEqual([]);
  });
});

describe('recently used emojis', () => {
  it('keeps the last ones first, once each, up to the limit', () => {
    const storage = memoryStorage();
    let recent = readRecentEmojis(storage);
    for (const emoji of ['🚀', '🐛', '🚀']) recent = rememberRecentEmoji(emoji, recent, storage);
    expect(recent).toEqual(['🚀', '🐛']);
    expect(readRecentEmojis(storage)).toEqual(['🚀', '🐛']);
    const many = Array.from({ length: 30 }, (_, i) => String.fromCodePoint(0x1f600 + i));
    for (const emoji of many) recent = rememberRecentEmoji(emoji, recent, storage);
    expect(readRecentEmojis(storage)).toHaveLength(MAX_RECENT_EMOJIS);
    expect(readRecentEmojis(storage)[0]).toBe(many.at(-1));
  });

  it('drops what is not an emoji, and reads none from a stored value of another shape', () => {
    expect(readRecentEmojis(memoryStorage({ [RECENT_EMOJIS_KEY]: '["🚀","<b>",5]' }))).toEqual(['🚀']);
    expect(readRecentEmojis(memoryStorage({ [RECENT_EMOJIS_KEY]: '{"a":1}' }))).toEqual([]);
    expect(readRecentEmojis(memoryStorage({ [RECENT_EMOJIS_KEY]: 'not json' }))).toEqual([]);
  });

  it('works without storage', () => {
    expect(readRecentEmojis(blocked)).toEqual([]);
    expect(rememberRecentEmoji('🚀', ['🐛'], blocked)).toEqual(['🚀', '🐛']);
  });
});
