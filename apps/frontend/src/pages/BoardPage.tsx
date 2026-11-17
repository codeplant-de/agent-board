import { statePrOf, type Status } from '@agent-board/shared';
import { Badge, Button, Group, Paper, ScrollArea, Stack, Text } from '@mantine/core';
import { IconGitMerge } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type DragEvent } from 'react';
import { moveConfirmed } from '../components/confirmStart';
import { IncompatibleMachinesBanner } from '../components/IncompatibleMachinesBanner';
import { QueryStatus } from '../components/QueryStatus';
import { SlackInbox } from '../components/SlackInbox';
import { TaskCard } from '../components/TaskCard';
import { usePolish } from '../components/usePolish';
import { beforeIdOver, dropNeighbors } from '../lib/dropPosition';
import { canPolish, isOpenPolishOf } from '../lib/polish';
import { STATUS_COLOR, STATUS_LABEL } from '../lib/status';
import { POLL_MS, useTRPC, type ListedTask } from '../lib/trpc';

const HINT: Record<Status, string> = {
  backlog: 'Parked; no worker takes these',
  todo: 'By priority; top runs first',
  running: 'On a worker machine',
  waiting: 'On CI and the like; back to Todo by itself',
  'needs-me': 'Waiting for you',
  done: '',
};

interface DropTarget {
  status: Status;
  /** The card the dragged one lands above; none means the bottom. */
  beforeId?: string;
}

/** Only a worker moves a task into or out of Running, and only a running agent puts one in Waiting (a drag out ends the wait). */
const canDrag = (task: ListedTask) => task.status !== 'running';
const canDrop = (status: Status) => status !== 'running' && status !== 'waiting';

/** A task of the user's whose PR has been merged and that asks nothing: it can go to Done. */
const hasMergedPr = (task: ListedTask) =>
  task.prState === 'merged' && statePrOf(task) !== undefined && !task.proposed && !task.openQuestion;

/** The board's cells in order; Waiting sits above Todo in one cell, so a wait never takes a column of its own. */
const CELLS: Status[][] = [['backlog'], ['waiting', 'todo'], ['running'], ['needs-me'], ['done']];

/**
 * How tall a column's cards may grow before it scrolls. Waiting is capped at under a third of the viewport, and Todo below it
 * gets what Waiting leaves: the rest of a full column less Waiting's box at its cap, or less only its empty box (~110px).
 */
const scrollMaxHeight = (status: Status, waitingEmpty: boolean): string => {
  if (status === 'waiting') return '30vh';
  if (status === 'todo') return waitingEmpty ? 'calc(100vh - 270px)' : 'calc(70vh - 230px)';
  return 'calc(100vh - 160px)';
};

/** Narrow on a wide screen until hovered, then they float over their neighbors at full width. */
const COLLAPSIBLE = new Set<Status>(['backlog', 'done']);

export function BoardPage() {
  const trpc = useTRPC();
  const tasks = useQuery({ ...trpc.tasks.list.queryOptions(), refetchInterval: POLL_MS });
  const move = useMutation(trpc.tasks.move.mutationOptions());
  const done = useMutation(trpc.tasks.done.mutationOptions());
  const polish = usePolish();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);

  const byStatus = (status: Status) => (tasks.data ?? []).filter((t) => t.status === status);

  const moveMergedToDone = async () => {
    for (const { id } of byStatus('needs-me').filter(hasMergedPr))
      await done.mutateAsync({ id }).catch(() => undefined);
  };

  const drop = (status: Status) => {
    if (!dragId || !canDrop(status)) return;
    const ids = byStatus(status).map((t) => t.id);
    const neighbors = dropNeighbors(ids, dragId, over?.status === status ? over.beforeId : undefined);
    const task = tasks.data?.find((t) => t.id === dragId);
    const run = () => move.mutate({ id: dragId, status, ...neighbors, task });
    if (task === undefined) run();
    else moveConfirmed(task, status, run);
    setDragId(null);
    setOver(null);
  };

  const renderColumn = (status: Status) => {
    const column = byStatus(status);
    return (
      <Paper
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
          // Cards stop their own dragover, so this is the gap or the space below them: the bottom.
          if (over?.status !== status || over.beforeId !== undefined) setOver({ status });
        }}
        onDragLeave={(event: DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
        }}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          drop(status);
        }}
      >
        <div className="board-column-content">
          <Group justify="space-between" mb="sm" wrap="nowrap">
            <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
              <Badge color={STATUS_COLOR[status]} variant="light">
                {STATUS_LABEL[status]}
              </Badge>
              <Text size="sm" c="dimmed">
                {column.length}
              </Text>
            </Group>
            <Text size="xs" c="dimmed" ta="right" className="wrap-anywhere">
              {HINT[status]}
            </Text>
          </Group>
          {status === 'needs-me' && column.some(hasMergedPr) && (
            <Button
              size="compact-xs"
              variant="light"
              color="grape"
              mb="xs"
              leftSection={<IconGitMerge size={14} />}
              loading={done.isPending}
              onClick={() => void moveMergedToDone()}
            >
              Move merged to Done ({column.filter(hasMergedPr).length})
            </Button>
          )}
          <ScrollArea.Autosize mah={scrollMaxHeight(status, byStatus('waiting').length === 0)} offsetScrollbars>
            <Stack gap="xs" mih={status === 'waiting' ? undefined : 60}>
              {column.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  draggable={canDrag(task)}
                  dragging={dragId === task.id}
                  {...(canPolish(task) ? { onPolish: () => polish.polish(task) } : {})}
                  polishDisabled={
                    polish.isPending || (tasks.data ?? []).some((child) => isOpenPolishOf(child, task.id))
                  }
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    setDragId(task.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOver(null);
                  }}
                  onDragOver={(event) => {
                    if (!dragId || !canDrop(status)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    const ids = column.map((t) => t.id);
                    const beforeId = beforeIdOver(ids, dragId, task.id, event.clientY < rect.top + rect.height / 2);
                    if (over?.status !== status || over.beforeId !== beforeId) setOver({ status, beforeId });
                  }}
                />
              ))}
              {column.length === 0 && tasks.data !== undefined && (
                <Text size="sm" c="dimmed" ta="center" py={status === 'waiting' ? 'xs' : 'lg'}>
                  {status === 'needs-me' ? 'Nothing waiting for you' : 'Empty'}
                </Text>
              )}
            </Stack>
          </ScrollArea.Autosize>
        </div>
      </Paper>
    );
  };

  return (
    <Stack gap="md">
      <IncompatibleMachinesBanner />
      <SlackInbox />
      <QueryStatus query={tasks} what="the board" />
      <div className="board">
        {CELLS.map((statuses) => (
          <div
            key={statuses.join()}
            className="board-cell"
            data-collapsible={statuses.length === 1 && COLLAPSIBLE.has(statuses[0]!)}
            data-status={statuses.join(' ')}
          >
            {statuses.map(renderColumn)}
          </div>
        ))}
      </div>
    </Stack>
  );
}
