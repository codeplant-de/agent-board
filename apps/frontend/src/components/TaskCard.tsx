import { Card, Group, Stack, Text } from '@mantine/core';
import { IconBrandGithub } from '@tabler/icons-react';
import type { DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { prUrl } from '../lib/status';
import { ago } from '../lib/time';
import type { BoardTask, RouterOutputs } from '../lib/trpc';
import { TaskBadges } from './TaskBadges';

type Activity = RouterOutputs['tasks']['activity'][string];

/** The latest note as one line: who said what, how long ago. */
function activityLine(activity: Activity | undefined, task: BoardTask): string {
  if (!activity) return `created ${ago(task.createdAt)}`;
  const text =
    activity.kind === 'question'
      ? 'asked a question'
      : activity.kind === 'answer'
        ? 'answered'
        : activity.body.replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
  return `${activity.author}: ${text} · ${ago(activity.createdAt)}`;
}

interface Props {
  task: BoardTask;
  activity: Activity | undefined;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent) => void;
}

export function TaskCard({ task, activity, draggable, dragging, onDragStart, onDragEnd, onDragOver }: Props) {
  const pr = prUrl(task.input);
  return (
    <Card
      component={Link}
      to={`/t/${task.id}`}
      withBorder
      padding="sm"
      className="task-card"
      data-dragging={dragging}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      style={{
        cursor: draggable ? 'grab' : 'pointer',
        borderLeft: task.openQuestion ? '3px solid var(--mantine-color-orange-6)' : undefined,
      }}
    >
      <Stack gap={6}>
        <Group gap={6} wrap="nowrap" align="flex-start">
          {pr && <IconBrandGithub size={16} style={{ flexShrink: 0, marginTop: 2 }} />}
          <Text size="sm" fw={500} lineClamp={2}>
            {task.title}
          </Text>
        </Group>
        <TaskBadges task={task} />
        <Text size="xs" c="dimmed" lineClamp={1}>
          {activityLine(activity, task)}
        </Text>
      </Stack>
    </Card>
  );
}
