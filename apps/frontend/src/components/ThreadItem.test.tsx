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

const renderNote = (n: ThreadNote, openQuestionId?: string) =>
  render(
    <MantineProvider>
      <ThreadItem note={n} thread={[n]} openQuestionId={openQuestionId} />
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

  it('draws a watch event note as a compact row with the fenced text behind a disclosure', () => {
    renderNote(note({ text: 'agent-board: watch "ci" reported.\n\n```\n4 of 7 passed\n```' }));
    const row = screen.getByTestId('watch-event');
    expect(row).toHaveTextContent('Watch "ci" reported');
    expect(row).toHaveTextContent(/· \d\d:\d\d/);
    expect(screen.getByText(/4 of 7 passed/)).toBeInTheDocument();
  });

  it('gives a watch note with an odd first line a plain title', () => {
    renderNote(note({ text: 'agent-board: watch "<img src=x>" reported.\n\nbody' }));
    expect(screen.getByTestId('watch-event')).toHaveTextContent('Watch reported');
    expect(screen.queryByText(/img/)).not.toBeInTheDocument();
  });

  it('does not draw a note of the user, or an ordinary agent comment, as a watch event', () => {
    renderNote(note({ author: 'user', text: 'agent-board: watch "ci" reported.' }));
    expect(screen.queryByTestId('watch-event')).not.toBeInTheDocument();
    renderNote(note({ text: 'Ready.' }));
    expect(screen.queryByTestId('watch-event')).not.toBeInTheDocument();
  });

  it('draws an agent comment with a suggestion as a normal comment even when it starts with the marker', () => {
    renderNote(note({ text: 'agent-board: watch "ci" reported.\n\nbody', suggestion: 'Reply with this' }));
    expect(screen.queryByTestId('watch-event')).not.toBeInTheDocument();
    expect(screen.getByText(/Suggested reply: Reply with this/)).toBeInTheDocument();
  });

  describe('an unanswered question', () => {
    const asked = note({
      id: 'q1',
      kind: 'question',
      questions: [
        {
          header: 'Scope',
          question: 'How far?',
          multiSelect: false,
          options: [
            { label: 'Narrow', description: '' },
            { label: 'Wide', description: '' },
          ],
        },
      ],
    });

    it('is open, with the pointer to the panel, when the task waits on it', () => {
      renderNote(asked, 'q1');
      expect(screen.getByText('open')).toBeInTheDocument();
      expect(screen.getByText(/Scope: answer below\./)).toBeInTheDocument();
      expect(screen.queryByText('not answered')).not.toBeInTheDocument();
    });

    it('is marked not answered, with its questions listed, once the task no longer waits on it', () => {
      renderNote(asked);
      expect(screen.getByText('not answered')).toBeInTheDocument();
      expect(screen.queryByText('open')).not.toBeInTheDocument();
      expect(screen.queryByText(/answer below/)).not.toBeInTheDocument();
      expect(screen.getByText('How far?')).toBeInTheDocument();
      expect(screen.getByText('Narrow')).toBeInTheDocument();
      expect(screen.getByText('Wide')).toBeInTheDocument();
    });

    it('is not answered when the task waits on a later question', () => {
      renderNote(asked, 'q2');
      expect(screen.getByText('not answered')).toBeInTheDocument();
    });
  });
});
