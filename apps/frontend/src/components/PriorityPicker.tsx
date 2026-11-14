import { PRIORITIES, type Priority } from '@agent-board/shared';
import { Badge, Menu, UnstyledButton } from '@mantine/core';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import { PRIORITY_COLOR, PRIORITY_ICON, PRIORITY_LABEL } from '../lib/priority';

export function PriorityBadge({ priority, withChevron = false }: { priority: Priority; withChevron?: boolean }) {
  const Icon = PRIORITY_ICON[priority];
  return (
    <Badge
      size="sm"
      tt="none"
      color={PRIORITY_COLOR[priority]}
      variant={priority === 'urgent' ? 'filled' : priority === 'normal' ? 'default' : 'light'}
      leftSection={<Icon size={12} />}
      rightSection={withChevron ? <IconChevronDown size={12} /> : undefined}
    >
      {PRIORITY_LABEL[priority]}
    </Badge>
  );
}

/** The task's priority as a badge that opens a menu of the four levels. */
export function PriorityPicker({ value, onChange, disabled }: { value: Priority; onChange: (p: Priority) => void; disabled?: boolean }) {
  return (
    <Menu position="bottom-start" disabled={disabled}>
      <Menu.Target>
        <UnstyledButton aria-label={`Priority: ${PRIORITY_LABEL[value]}`} title="Change priority">
          <PriorityBadge priority={value} withChevron={!disabled} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Priority</Menu.Label>
        {PRIORITIES.map((p) => {
          const Icon = PRIORITY_ICON[p];
          return (
            <Menu.Item
              key={p}
              leftSection={<Icon size={14} color={`var(--mantine-color-${PRIORITY_COLOR[p]}-6)`} />}
              rightSection={p === value ? <IconCheck size={14} /> : undefined}
              onClick={() => p !== value && onChange(p)}
            >
              {PRIORITY_LABEL[p]}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}
