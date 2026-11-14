import type { Status } from '@agent-board/shared';
import { Alert, Code, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { startsProposal, type Proposal } from '../lib/sealing';

/**
 * Asks the user to confirm starting an agent's proposal, showing its whole prompt as plain text: starting seals exactly this
 * text as theirs, and a worker then runs it with their permissions.
 */
export function confirmStart(proposal: Proposal, onConfirm: () => void): void {
  const unreadable = proposal.unreadable.includes('input');
  modals.openConfirmModal({
    title: 'Start this agent’s proposal as yours?',
    size: 'lg',
    children: unreadable ? (
      <Alert color="red">This proposal’s prompt cannot be read, so it cannot be started here.</Alert>
    ) : (
      <>
        <Text size="sm" mb="xs">
          A worker will run this prompt as if you had written it, with your permissions. Read all of it first.
        </Text>
        <Code
          block
          data-testid="proposal-prompt"
          style={{ maxHeight: '50vh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {proposal.input}
        </Code>
      </>
    ),
    labels: { confirm: 'Start as mine', cancel: 'Cancel' },
    confirmProps: { color: 'grape', disabled: unreadable },
    onConfirm,
  });
}

/** Runs `move`, after a confirmation that shows the prompt when the move starts an agent's proposal. */
export function moveConfirmed(proposal: Proposal, to: Status, move: () => void): void {
  if (startsProposal(proposal, to)) confirmStart(proposal, move);
  else move();
}
