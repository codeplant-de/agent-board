import type { Polish } from '@agent-board/shared';
import { Code, Text } from '@mantine/core';
import { modals } from '@mantine/modals';

/**
 * Asks the user to confirm applying an agent's polished title and prompt, showing both whole as plain text: applying seals
 * exactly this text as theirs, and a worker then runs it with their permissions.
 */
export function confirmApply(
  options: { targetTitle: string; rewrite: Pick<Polish, 'title' | 'prompt'> },
  onConfirm: () => void,
): void {
  const { targetTitle, rewrite } = options;
  modals.openConfirmModal({
    title: 'Replace this task’s title and prompt?',
    size: 'lg',
    children: (
      <>
        <Text size="sm" mb="xs">
          “{targetTitle}” gets this title and prompt as if you had written them, and a worker runs the prompt with your
          permissions. What it says now stays in a note on the task. Read all of it first.
        </Text>
        <Text size="xs" c="dimmed" fw={600} tt="uppercase">
          Title
        </Text>
        <Code block data-testid="polish-title" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {rewrite.title}
        </Code>
        <Text size="xs" c="dimmed" fw={600} tt="uppercase" mt="xs">
          Prompt
        </Text>
        <Code
          block
          data-testid="polish-prompt"
          style={{ maxHeight: '50vh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {rewrite.prompt}
        </Code>
      </>
    ),
    labels: { confirm: 'Apply as mine', cancel: 'Cancel' },
    confirmProps: { color: 'grape' },
    onConfirm,
  });
}
