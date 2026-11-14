import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BoardTask, ThreadNote } from '../lib/trpc';
import { ActionPanel } from './ActionPanel';

const takeBack = vi.hoisted(() => vi.fn(async (_: unknown) => null));

vi.mock('../lib/trpc', () => {
  const procedure = (mutationFn: (variables: unknown) => Promise<unknown>) => ({
    mutationOptions: () => ({ mutationFn }),
  });
  const idle = procedure(async () => null);
  return {
    useTRPC: () => ({
      tasks: {
        answer: idle,
        reply: idle,
        done: idle,
        rerun: idle,
        setClosed: idle,
        move: idle,
        takeBack: procedure(takeBack),
      },
    }),
  };
});

// The board sends dates as ISO strings.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function running(overrides: Partial<BoardTask>): BoardTask {
  return {
    id: 'abc12345',
    title: 't',
    input: 'do it',
    labels: [],
    status: 'running',
    priority: 'normal',
    url: 'https://board.test/t/abc12345',
    closed: false,
    machine: 'laptop',
    sessionId: 's',
    workdir: null,
    next: 'fresh',
    head: null,
    openQuestion: false,
    createdBy: 'user',
    lane: null,
    borrowed: false,
    lastActiveAt: minutesAgo(1),
    runStartedAt: minutesAgo(30),
    paused: false,
    proposed: false,
    parentId: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(1),
    ...overrides,
  } as BoardTask;
}

function renderPanel(task: BoardTask, thread: ThreadNote[] = []) {
  return render(
    <MantineProvider>
      <ModalsProvider>
        <QueryClientProvider client={new QueryClient()}>
          <ActionPanel task={task} thread={thread} />
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
}

describe('ActionPanel of a running task', () => {
  it('says since when it runs, from the task, and offers no take-back while the agent is active', () => {
    renderPanel(running({}));
    expect(screen.getByText(/since 30 minutes ago/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take back' })).not.toBeInTheDocument();
  });

  it('offers no take-back while the quiet is only red, before 20 minutes', () => {
    renderPanel(running({ lastActiveAt: minutesAgo(12) }));
    expect(screen.queryByRole('button', { name: 'Take back' })).not.toBeInTheDocument();
  });

  it('offers the take-back once the agent has been quiet for 20 minutes, after a confirmation', async () => {
    takeBack.mockClear();
    renderPanel(running({ lastActiveAt: minutesAgo(21) }));
    await userEvent.click(screen.getByRole('button', { name: 'Take back' }));
    expect(takeBack).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Take back' }));
    await waitFor(() => expect(takeBack).toHaveBeenCalled());
    expect(takeBack.mock.calls[0]?.[0]).toEqual({ id: 'abc12345' });
  });
});

describe('ActionPanel of a proposal', () => {
  const asked = {
    id: 'q1',
    kind: 'question',
    author: 'agent',
    text: '',
    createdAt: new Date().toISOString(),
    by: 'laptop',
    questions: [
      {
        header: 'Scope',
        question: 'Go?',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'y' },
          { label: 'No', description: 'n' },
        ],
      },
    ],
  } as ThreadNote;

  it('shows the proposal alert, not a question panel, even when a question is open', () => {
    renderPanel(running({ status: 'needs-me', proposed: true, openQuestion: true, createdBy: 'agent' }), [asked]);
    expect(screen.getByText('Proposed by an agent')).toBeInTheDocument();
    expect(screen.queryByText('Go?')).not.toBeInTheDocument();
  });
});
