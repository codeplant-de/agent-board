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

/** The PR a task works on: the first GitHub PR URL in its prompt's first line. */
export function prUrl(input: string): string | null {
  const first = input.split('\n')[0] ?? '';
  return /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.exec(first)?.[0] ?? null;
}

/** The prompt as the agent gets it: without intake's `head: <sha>` line. */
export function promptText(input: string): string {
  return input
    .split('\n')
    .filter((line) => !/^\s*head:\s*[0-9a-f]{7,40}\s*$/i.test(line))
    .join('\n')
    .trim();
}
