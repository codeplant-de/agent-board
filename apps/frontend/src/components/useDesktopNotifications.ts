import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  idsNeedingMe,
  isNotificationSupported,
  newlyNeedingMe,
  readDesktopNotificationsPreference,
  subscribeToDesktopNotificationsPreference,
} from '../lib/desktopNotifications';
import { POLL_MS, useTRPC, type ListedTask } from '../lib/trpc';

/** The user is looking at the board, which already shows what needs them. */
const isWatchingBoard = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

const canNotify = (): boolean => isNotificationSupported() && Notification.permission === 'granted';

/** Shows an OS notification for each task that newly needs the user, while a board tab is open and the setting is on. */
export function useDesktopNotifications(): void {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const enabled = useSyncExternalStore(subscribeToDesktopNotificationsPreference, readDesktopNotificationsPreference);
  // React Query pauses interval polling in hidden tabs, which is when the user needs the notification. Only a tab that can
  // show one keeps polling there.
  const tasks = useQuery({
    ...trpc.tasks.list.queryOptions(),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: enabled && canNotify(),
  });
  const remembered = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!tasks.data) return;
    const previous = remembered.current;
    remembered.current = idsNeedingMe(tasks.data);
    if (!enabled || !canNotify() || isWatchingBoard()) return;
    newlyNeedingMe(previous, tasks.data).forEach((task) => notify(task, (path) => void navigate(path)));
  }, [tasks.data, enabled, navigate]);
}

function notify({ id, title, openQuestion }: ListedTask, open: (path: string) => void): void {
  const notification = new Notification(title, {
    body: openQuestion ? 'Asked you a question' : 'Needs you',
    tag: id,
    icon: '/favicon.svg',
  });
  notification.onclick = () => {
    window.focus();
    open(`/t/${id}`);
    notification.close();
  };
}
