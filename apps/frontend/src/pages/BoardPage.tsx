import { STATUSES, type Status } from '@agent-board/shared';
import { Badge, Group, Paper, ScrollArea, SimpleGrid, Stack, Text } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type DragEvent } from 'react';
import { moveConfirmed } from '../components/confirmStart';
import { TaskCard } from '../components/TaskCard';
import { STATUS_COLOR, STATUS_LABEL } from '../lib/status';
import { POLL_MS, useTRPC, type ListedTask } from '../lib/trpc';

const HINT: Record<Status, string> = {
  backlog: 'Parked; no worker takes these',
  todo: 'By priority; top runs first',
  running: 'On a worker machine',
  'needs-me': 'Waiting for you',
  done: '',
};

interface DropTarget {
  status: Status;
  /** The card the dragged one lands above; none means the bottom. */
  beforeId?: string;
}

/** Only a worker moves a task into or out of Running. */
const canDrag = (task: ListedTask) => task.status !== 'running';
const canDrop = (status: Status) => status !== 'running';

export function BoardPage() {
  const trpc = useTRPC();
  const tasks = useQuery({ ...trpc.tasks.list.queryOptions(), refetchInterval: POLL_MS });
  const move = useMutation(trpc.tasks.move.mutationOptions());
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);

  const byStatus = (status: Status) => (tasks.data ?? []).filter((t) => t.status === status);

  const drop = (status: Status) => {
    if (!dragId || !canDrop(status)) return;
    const column = byStatus(status).filter((t) => t.id !== dragId);
    const beforeIndex = over?.beforeId ? column.findIndex((t) => t.id === over.beforeId) : -1;
    const beforeId = beforeIndex >= 0 ? column[beforeIndex]?.id : undefined;
    const afterId = beforeIndex > 0 ? column[beforeIndex - 1]?.id : beforeIndex === -1 ? column.at(-1)?.id : undefined;
    const task = tasks.data?.find((t) => t.id === dragId);
    const run = () => move.mutate({ id: dragId, status, beforeId, afterId, task });
    if (task === undefined) run();
    else moveConfirmed(task, status, run);
    setDragId(null);
    setOver(null);
  };

  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} spacing="md">
      {STATUSES.map((status) => {
        const column = byStatus(status);
        return (
          <Paper
            key={status}
            withBorder
            p="sm"
            radius="md"
            className="board-column"
            data-over={dragId !== null && over?.status === status && canDrop(status)}
            bg="var(--mantine-color-default-hover)"
            style={
              status === 'needs-me' && column.length > 0
                ? { borderTop: '3px solid var(--mantine-color-orange-5)' }
                : undefined
            }
            onDragOver={(event: DragEvent) => {
              if (!dragId || !canDrop(status)) return;
              event.preventDefault();
              if (over?.status !== status) setOver({ status });
            }}
            onDragLeave={(event: DragEvent) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(event: DragEvent) => {
              event.preventDefault();
              drop(status);
            }}
          >
            <Group justify="space-between" mb="sm">
              <Group gap={6}>
                <Badge color={STATUS_COLOR[status]} variant="light">
                  {STATUS_LABEL[status]}
                </Badge>
                <Text size="sm" c="dimmed">
                  {column.length}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {HINT[status]}
              </Text>
            </Group>
            <ScrollArea.Autosize mah="calc(100vh - 160px)" offsetScrollbars>
              <Stack gap="xs" mih={60}>
                {column.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    draggable={canDrag(task)}
                    dragging={dragId === task.id}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      setDragId(task.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOver(null);
                    }}
                    onDragOver={(event) => {
                      if (!dragId || !canDrop(status) || task.id === dragId) return;
                      event.preventDefault();
                      event.stopPropagation();
                      // Upper half: above this card; lower half: above the next one.
                      const rect = event.currentTarget.getBoundingClientRect();
                      const index = column.indexOf(task);
                      const beforeId = event.clientY < rect.top + rect.height / 2 ? task.id : column[index + 1]?.id;
                      if (over?.status !== status || over.beforeId !== beforeId) setOver({ status, beforeId });
                    }}
                  />
                ))}
                {column.length === 0 && (
                  <Text size="sm" c="dimmed" ta="center" py="lg">
                    {status === 'needs-me' ? 'Nothing waiting for you' : 'Empty'}
                  </Text>
                )}
              </Stack>
            </ScrollArea.Autosize>
          </Paper>
        );
      })}
    </SimpleGrid>
  );
}
