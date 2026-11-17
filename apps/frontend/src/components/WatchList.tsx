import type { TaskWatch } from '@agent-board/shared';
import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import { ago, stamp } from '../lib/time';

interface Props {
  watches: TaskWatch[];
  /** The ids of the watches you asked to stop that the machine has not acknowledged. */
  stopping: string[];
  onStop: (watchId: string) => void;
}

/** What the task's machine watches for it. Every string is the agent's text: shown as plain text, never as markdown or a link. */
export function WatchList({ watches, stopping, onStop }: Props) {
  return (
    <Paper withBorder p="sm">
      <Text size="xs" c="dimmed" fw={600} mb={4} tt="uppercase">
        Watches
      </Text>
      <Stack gap="xs">
        {watches.length === 0 && (
          <Text size="sm" c="dimmed">
            Stop requested; waiting for the machine.
          </Text>
        )}
        {watches.map((watch) => {
          const isStopping = stopping.includes(watch.id);
          return (
            <Group key={watch.id} gap="xs" wrap="nowrap" align="flex-start" justify="space-between">
              <Stack gap={0} style={{ minWidth: 0 }}>
                <Text size="sm" className="wrap-anywhere">
                  <Text span fw={600}>
                    {watch.name}
                  </Text>{' '}
                  · {watch.label}
                </Text>
                <Text size="xs" c="dimmed" className="wrap-anywhere">
                  {watch.status}
                </Text>
                <Text size="xs" c="dimmed">
                  <span title={stamp(watch.deadline)}>until {stamp(watch.deadline)}</span>
                  {watch.lastAttemptAt !== undefined && (
                    <span title={stamp(watch.lastAttemptAt)}> · looked {ago(watch.lastAttemptAt)}</span>
                  )}
                  {watch.pendingEvents > 0 && (
                    <span>
                      {' '}
                      · {watch.pendingEvents} {watch.pendingEvents === 1 ? 'event' : 'events'} waiting
                    </span>
                  )}
                </Text>
              </Stack>
              <Button
                variant="default"
                size="compact-xs"
                color="red"
                disabled={isStopping}
                aria-label={`${isStopping ? 'Stopping' : 'Stop'} ${watch.name}`}
                onClick={() => onStop(watch.id)}
              >
                {isStopping ? 'Stopping…' : 'Stop'}
              </Button>
            </Group>
          );
        })}
      </Stack>
    </Paper>
  );
}
