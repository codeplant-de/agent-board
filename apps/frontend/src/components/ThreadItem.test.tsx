import { UNREADABLE_TEXT } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ThreadNote } from '../lib/trpc';
import { ThreadItem } from './ThreadItem';

const note = (overrides: Partial<ThreadNote>): ThreadNote => ({
  id: 'n1',
  text: '',
  createdAt: new Date().toISOString(),
  author: 'agent',
  kind: 'comment',
  by: null,
  unreadable: false,
  ...overrides,
});

const renderNote = (n: ThreadNote) =>
  render(
    <MantineProvider>
      <ThreadItem note={n} thread={[n]} />
    </MantineProvider>,
  );

describe('ThreadItem', () => {
  it('shows a system event as text', () => {
    renderNote(note({ author: 'system', kind: 'event', text: 'Marked done.' }));
    expect(screen.getByText(/Marked done\./)).toBeInTheDocument();
    expect(screen.queryByTestId('board-event')).not.toBeInTheDocument();
  });

  it('sets an event of the board server apart from the notes of the user’s machines', () => {
    renderNote(note({ author: 'server', kind: 'event', text: 'Marked done.' }));
    const event = screen.getByTestId('board-event');
    expect(event).toHaveTextContent('Board');
    expect(event).toHaveTextContent('Marked done.');
    expect(event.querySelector('[title]')?.getAttribute('title')).toMatch(/board server itself/);
  });

  it('shows the reply the agent suggested under its comment', () => {
    renderNote(note({ text: 'Ready.', suggestion: 'Yes, open the PR.' }));
    expect(screen.getByText(/Suggested reply: Yes, open the PR\./)).toBeInTheDocument();
  });

  it('says why a note whose id the board repeated is not shown', () => {
    renderNote(note({ unreadable: true, duplicateId: true, text: '' }));
    expect(screen.getByText(/several notes with this id/)).toBeInTheDocument();
  });

  it.each(['agent', 'user', 'system'] as const)(
    'shows an unreadable note by the %s as a placeholder, never as text',
    (author) => {
      renderNote(note({ author, unreadable: true, text: '' }));
      expect(screen.getByText(UNREADABLE_TEXT)).toBeInTheDocument();
    },
  );

  it('marks a message the running agent has not received yet', () => {
    renderNote(note({ author: 'user', text: 'try again', pending: true }));
    expect(screen.getByText('Waiting for the agent')).toBeInTheDocument();
    expect(screen.queryByText(/Delivered/)).not.toBeInTheDocument();
  });

  it('marks a message that was delivered', () => {
    renderNote(note({ author: 'user', text: 'try again', deliveredAt: new Date().toISOString() }));
    expect(screen.getByText(/Delivered/)).toBeInTheDocument();
    expect(screen.queryByText('Waiting for the agent')).not.toBeInTheDocument();
  });

  it('shows no delivery state on an ordinary note', () => {
    renderNote(note({ author: 'user', text: 'plain' }));
    expect(screen.queryByText(/Delivered|Waiting for the agent/)).not.toBeInTheDocument();
  });
});
