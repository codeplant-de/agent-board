import { isEmojiIcon } from '@agent-board/shared';

export interface EmojiEntry {
  emoji: string;
  label: string;
  tags: string[];
}

export interface EmojiGroup {
  key: string;
  label: string;
  emojis: EmojiEntry[];
}

const GROUP_LABELS: Record<string, string> = {
  'smileys-emotion': 'Smileys & emotion',
  'people-body': 'People & body',
  'animals-nature': 'Animals & nature',
  'food-drink': 'Food & drink',
  'travel-places': 'Travel & places',
  activities: 'Activities',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags',
};

/** The component group (skin tones, hair) is left out: those are parts of an emoji, not one a task can carry. */
export async function loadEmojiGroups(): Promise<EmojiGroup[]> {
  const [{ default: emojis }, { default: meta }] = await Promise.all([
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/meta/groups.json'),
  ]);
  const groups = new Map<number, EmojiGroup>();
  for (const [index, key] of Object.entries(meta.groups)) {
    const label = GROUP_LABELS[key];
    if (label !== undefined) groups.set(Number(index), { key, label, emojis: [] });
  }
  for (const entry of [...emojis].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const group = entry.group === undefined ? undefined : groups.get(entry.group);
    if (group !== undefined && isEmojiIcon(entry.unicode))
      group.emojis.push({ emoji: entry.unicode, label: entry.label, tags: entry.tags ?? [] });
  }
  return [...groups.values()].filter((group) => group.emojis.length > 0);
}

export function searchEmojis(groups: readonly EmojiGroup[], query: string): EmojiEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return groups
    .flatMap((group) => group.emojis)
    .filter(({ label, tags }) => {
      const haystack = [label.toLowerCase(), ...tags];
      return words.every((word) => haystack.some((text) => text.includes(word)));
    });
}

export const RECENT_EMOJIS_KEY = 'agent-board.recentEmojis';
export const MAX_RECENT_EMOJIS = 24;

type RecentStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readRecentEmojis(storage?: RecentStorage): string[] {
  try {
    const parsed: unknown = JSON.parse((storage ?? localStorage).getItem(RECENT_EMOJIS_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === 'string' && isEmojiIcon(item))
          .slice(0, MAX_RECENT_EMOJIS)
      : [];
  } catch {
    return [];
  }
}

export function rememberRecentEmoji(emoji: string, recent: readonly string[], storage?: RecentStorage): string[] {
  const next = [emoji, ...recent.filter((item) => item !== emoji)].slice(0, MAX_RECENT_EMOJIS);
  try {
    (storage ?? localStorage).setItem(RECENT_EMOJIS_KEY, JSON.stringify(next));
  } catch {
    // Storage is blocked: the list lasts as long as the page that holds it.
  }
  return next;
}
