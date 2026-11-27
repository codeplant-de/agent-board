import { DESKTOP_NOTIFICATIONS_PREFERENCE_KEY } from './desktopNotifications';
import { TODO_SHOW_ALL_PREFERENCE_KEY } from './todoToday';

/** The browser preferences an export carries and an import restores; a new preference is one more line here. */
export const BOARD_PREF_KEYS: readonly string[] = [DESKTOP_NOTIFICATIONS_PREFERENCE_KEY, TODO_SHOW_ALL_PREFERENCE_KEY];

type PrefStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Runs `work` against the browser's storage; where storage is blocked there are no preferences to move. */
function withStorage<T>(storage: PrefStorage | undefined, fallback: T, work: (storage: PrefStorage) => T): T {
  try {
    return work(storage ?? localStorage);
  } catch {
    return fallback;
  }
}

export const readBoardPrefs = (storage?: PrefStorage): Record<string, string> =>
  withStorage(storage, {}, (target) =>
    Object.fromEntries(
      BOARD_PREF_KEYS.flatMap((key) => {
        const value = target.getItem(key);
        return value === null ? [] : [[key, value]];
      }),
    ),
  );

/** Writes the preferences of an export whose key this app knows; any other key in the file is ignored. */
export function restoreBoardPrefs(prefs: Record<string, string>, storage?: PrefStorage): void {
  withStorage(storage, undefined, (target) => {
    for (const key of BOARD_PREF_KEYS) {
      const value = prefs[key];
      if (value !== undefined) target.setItem(key, value);
    }
  });
}

export function clearBoardPrefs(storage?: PrefStorage): void {
  withStorage(storage, undefined, (target) => {
    for (const key of BOARD_PREF_KEYS) target.removeItem(key);
  });
}
