import type { ListedTask } from './opening';

const PREFERENCE_KEY = 'agent-board.desktopNotifications';
const PREFERENCE_EVENT = 'agent-board:desktop-notifications';

export type NotifiableTask = Pick<ListedTask, 'id' | 'status' | 'closed'>;

const needsMe = (task: NotifiableTask): boolean => task.status === 'needs-me' && !task.closed;

export const idsNeedingMe = (tasks: readonly NotifiableTask[]): Set<string> =>
  new Set(tasks.filter(needsMe).map(({ id }) => id));

/** The tasks that entered Needs me since `previous`; `null` is the first load, which reports none. */
export function newlyNeedingMe<T extends NotifiableTask>(
  previous: ReadonlySet<string> | null,
  tasks: readonly T[],
): T[] {
  if (previous === null) return [];
  return tasks.filter((task) => needsMe(task) && !previous.has(task.id));
}

export const isNotificationSupported = (): boolean => typeof Notification !== 'undefined';

export const readDesktopNotificationsPreference = (): boolean => {
  try {
    return localStorage.getItem(PREFERENCE_KEY) === 'on';
  } catch {
    return false;
  }
};

export function writeDesktopNotificationsPreference(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREFERENCE_KEY, 'on');
    else localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // Storage is blocked: the preference only lasts until the page closes, which the subscribers below still see.
  }
  window.dispatchEvent(new Event(PREFERENCE_EVENT));
}

/** Calls `listener` when the preference changes here or in another tab. */
export function subscribeToDesktopNotificationsPreference(listener: () => void): () => void {
  window.addEventListener(PREFERENCE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(PREFERENCE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}
