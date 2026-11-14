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
  });

  it.each(['agent', 'user', 'system'] as const)(
    'shows an unreadable note by the %s as a placeholder, never as text',
    (author) => {
      renderNote(note({ author, unreadable: true, text: '' }));
      expect(screen.getByText(UNREADABLE_TEXT)).toBeInTheDocument();
    },
  );
});
