import { Badge, Group } from '@mantine/core';
import { IconArrowsExchange, IconDeviceDesktop, IconMessageQuestion, IconPlayerPause, IconPlayerTrackNext, IconSparkles } from '@tabler/icons-react';
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
      {task.paused && (
        <Badge size="sm" color="yellow" variant="light" leftSection={<IconPlayerPause size={12} />}>
          Paused
        </Badge>
      )}
      {task.status === 'todo' && task.next === 'resume' && !task.paused && (
        <Badge size="sm" color="indigo" variant="light" leftSection={<IconPlayerTrackNext size={12} />}>
          Resume
        </Badge>
      )}
      {task.status === 'running' && task.machine && (
        <Badge size="sm" color="blue" variant="light" tt="none" leftSection={<IconDeviceDesktop size={12} />}>
          {task.lane ? `${task.machine} · ${task.lane}` : task.machine}
        </Badge>
      )}
      {task.status === 'running' && task.borrowed && (
        <Badge size="sm" color="grape" variant="light" tt="none" leftSection={<IconArrowsExchange size={12} />} title="Running in another lane's slot; it may be paused when that lane gets work of its own">
          borrowed
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
