import type { Status } from '@agent-board/shared';

export const STATUS_LABEL: Record<Status, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  running: 'Running',
  'needs-me': 'Needs me',
  done: 'Done',
};

export const STATUS_COLOR: Record<Status, string> = {
  backlog: 'violet',
  todo: 'gray',
  running: 'blue',
  'needs-me': 'orange',
  done: 'teal',
};
