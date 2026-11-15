import type { PrState } from '@agent-board/shared';
import { Tooltip } from '@mantine/core';
import { IconBrandGithub, IconGitMerge, IconGitPullRequestClosed } from '@tabler/icons-react';

interface Props {
  state: PrState | null;
  size?: number;
}

/** The task's PR: purple once merged, red once closed without a merge, else the GitHub mark. */
export function PrStateIcon({ state, size = 16 }: Props) {
  if (state === 'merged')
    return (
      <Tooltip label="PR merged">
        <IconGitMerge
          size={size}
          aria-label="PR merged"
          style={{ flexShrink: 0, color: 'var(--mantine-color-grape-6)' }}
        />
      </Tooltip>
    );
  if (state === 'closed')
    return (
      <Tooltip label="PR closed">
        <IconGitPullRequestClosed
          size={size}
          aria-label="PR closed"
          style={{ flexShrink: 0, color: 'var(--mantine-color-red-6)' }}
        />
      </Tooltip>
    );
  return <IconBrandGithub size={size} style={{ flexShrink: 0 }} />;
}
