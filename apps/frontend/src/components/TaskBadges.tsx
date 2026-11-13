import { Badge, Group } from '@mantine/core';
import { IconDeviceDesktop, IconMessageQuestion, IconPlayerTrackNext, IconSparkles } from '@tabler/icons-react';
import type { BoardTask } from '../lib/trpc';
import { PriorityBadge } from './PriorityPicker';

/**
 * What sets a task apart at a glance: its priority (unless normal), an open question, a proposal, a pending
 * resume, where it runs.
 */
export function TaskBadges({ task, withLabels = true, withPriority = true }: { task: BoardTask; withLabels?: boolean; withPriority?: boolean }) {
  return (
    <Group gap={4}>
      {withPriority && task.priority !== 'normal' && <PriorityBadge priority={task.priority} />}
      {task.openQuestion && (
        <Badge size="sm" color="orange" variant="filled" leftSection={<IconMessageQuestion size={12} />}>
          Question
        </Badge>
      )}
      {task.proposed && (
        <Badge size="sm" color="grape" variant="light" leftSection={<IconSparkles size={12} />}>
          Proposed
        </Badge>
      )}
      {task.status === 'todo' && task.next === 'resume' && (
        <Badge size="sm" color="indigo" variant="light" leftSection={<IconPlayerTrackNext size={12} />}>
          Resume
        </Badge>
      )}
      {task.status === 'running' && task.machine && (
        <Badge size="sm" color="blue" variant="dot" leftSection={<IconDeviceDesktop size={12} />}>
          {task.machine}
        </Badge>
      )}
      {withLabels &&
        task.labels.map((label) => (
          <Badge key={label} size="sm" variant="default" tt="none">
            {label}
          </Badge>
        ))}
    </Group>
  );
}
