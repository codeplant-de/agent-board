import { Button, Group, Paper, Stack, Switch, Text, Title } from '@mantine/core';
import { useState, useSyncExternalStore } from 'react';
import {
  isNotificationSupported,
  readDesktopNotificationsPreference,
  subscribeToDesktopNotificationsPreference,
  writeDesktopNotificationsPreference,
} from '../../lib/desktopNotifications';

export function NotificationsSettings() {
  const on = useSyncExternalStore(subscribeToDesktopNotificationsPreference, readDesktopNotificationsPreference);
  const supported = isNotificationSupported();
  const [permission, setPermission] = useState(() => (supported ? Notification.permission : 'denied'));
  const blocked = supported && permission === 'denied';

  // The permission prompt needs the click that calls this.
  const toggle = async (next: boolean) => {
    if (!next) return writeDesktopNotificationsPreference(false);
    const result = await Notification.requestPermission();
    setPermission(result);
    writeDesktopNotificationsPreference(result === 'granted');
  };

  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Desktop notifications</Title>
          <Text size="sm" c="dimmed">
            Get a notification when a task needs you. It works while a board tab is open, in the background too.
          </Text>
        </div>
        <Switch
          label="Notify me when a task needs me"
          checked={on && permission === 'granted'}
          disabled={!supported || blocked}
          onChange={(event) => void toggle(event.currentTarget.checked)}
        />
        {!supported && (
          <Text size="sm" c="dimmed">
            This browser does not offer notifications here. They need https or localhost.
          </Text>
        )}
        {blocked && (
          <Text size="sm" c="red">
            The browser blocks notifications for this site. Allow them in the site settings, then reload the page.
          </Text>
        )}
        {on && permission === 'granted' && (
          <Group>
            <Button
              size="xs"
              variant="default"
              onClick={() => new Notification('Agent Board', { body: 'Notifications work.', icon: '/favicon.svg' })}
            >
              Send a test
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
