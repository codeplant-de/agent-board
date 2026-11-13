import type { Status } from '@agent-board/shared';

export const STATUS_LABEL: Record<Status, string> = {
  todo: 'Todo',
  running: 'Running',
  'needs-me': 'Needs me',
  done: 'Done',
};

export const STATUS_COLOR: Record<Status, string> = {
  todo: 'gray',
  running: 'blue',
  'needs-me': 'orange',
  done: 'teal',
};

/** The first line of a review task's input is its PR URL. */
export function prUrl(input: string): string | null {
  const first = input.split('\n')[0]?.trim() ?? '';
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/.test(first) ? first : null;
}
