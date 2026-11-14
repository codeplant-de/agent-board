import type { Priority } from '@agent-board/shared';
import { IconArrowDown, IconArrowUp, IconEqual, IconFlame, type Icon } from '@tabler/icons-react';

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export const PRIORITY_COLOR: Record<Priority, string> = {
  urgent: 'red',
  high: 'orange',
  normal: 'gray',
  low: 'gray',
};

export const PRIORITY_ICON: Record<Priority, Icon> = {
  urgent: IconFlame,
  high: IconArrowUp,
  normal: IconEqual,
  low: IconArrowDown,
};
