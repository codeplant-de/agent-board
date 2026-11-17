import { Text } from '@mantine/core';
import { modals } from '@mantine/modals';

/**
 * Asks the user to confirm moving a task that has a Claude session: a session cannot be resumed from another directory, so the
 * move drops it and the next run starts fresh, reading the thread.
 */
export function confirmPlace(options: { to: string }, onConfirm: () => void): void {
  modals.openConfirmModal({
    title: 'Move this task and drop its session?',
    children: (
      <Text size="sm">
        A session cannot be resumed from another directory. The task’s session is dropped, and its next run starts fresh{' '}
        {options.to}, reading the thread.
      </Text>
    ),
    labels: { confirm: 'Move and drop the session', cancel: 'Cancel' },
    confirmProps: { color: 'red' },
    onConfirm,
  });
}
