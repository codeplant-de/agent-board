import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BoardTask, ThreadNote } from '../lib/trpc';
import { stamp } from '../lib/time';
import { ActionPanel } from './ActionPanel';

const takeBack = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const setNotBefore = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const answer = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const move = vi.hoisted(() => vi.fn(async (_: unknown) => null));

vi.mock('../lib/trpc', () => {
  const procedure = (mutationFn: (variables: unknown) => Promise<unknown>) => ({
    mutationOptions: () => ({ mutationFn }),
  });
  const idle = procedure(async () => null);
  return {
    useTRPC: () => ({
      tasks: {
        answer: procedure(answer),
        reply: idle,
        done: idle,
        rerun: idle,
        setClosed: idle,
        move: procedure(move),
        takeBack: procedure(takeBack),
        setNotBefore: procedure(setNotBefore),
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
    notBefore: null,
    scheduleId: null,
    proposed: false,
    invalid: [],
    unreadable: [],
    parentId: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(1),
    ...overrides,
  } as BoardTask;
}

function renderPanel(task: BoardTask, thread: ThreadNote[] = []) {
  return render(
    <MemoryRouter>
      <MantineProvider>
        <ModalsProvider>
          <QueryClientProvider client={new QueryClient()}>
            <ActionPanel task={task} thread={thread} />
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>
    </MemoryRouter>,
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

  it('starts it with the proposal as shown, so that the prompt can be sealed again as the user’s', async () => {
    move.mockClear();
    const proposal = running({
      status: 'needs-me',
      proposed: true,
      createdBy: 'agent',
      input: 'do Y',
      sessionId: null,
    });
    renderPanel(proposal, []);
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(move).toHaveBeenCalled());
    expect(move.mock.calls[0]?.[0]).toEqual({ id: 'abc12345', status: 'todo', task: proposal });
    expect(screen.getByRole('button', { name: 'Send & run' })).toBeDisabled();
  });

  it('is judged by its creator, which the prompt is sealed for, not by the flag the board sends', () => {
    renderPanel(running({ status: 'needs-me', proposed: false, createdBy: 'agent' }), []);
    expect(screen.getByText('Proposed by an agent')).toBeInTheDocument();
    renderPanel(running({ status: 'needs-me', proposed: true, createdBy: 'user' }), []);
    expect(screen.getAllByText('Proposed by an agent')).toHaveLength(1);
  });
});

describe('ActionPanel of an open question', () => {
  const questions = [
    {
      header: 'Tests',
      question: 'Add a regression test for the fix?',
      multiSelect: false,
      options: [
        { label: 'Yes', description: '' },
        { label: 'No', description: '' },
      ],
    },
  ];
  const asking = (overrides: Partial<ThreadNote>): ThreadNote =>
    ({
      id: 'q-new',
      kind: 'question',
      author: 'agent',
      text: '',
      createdAt: new Date().toISOString(),
      by: 'laptop',
      unreadable: false,
      questions,
      ...overrides,
    }) as ThreadNote;

  it('answers with the questions it showed, the ones to be sealed with the answers', async () => {
    answer.mockClear();
    renderPanel(running({ status: 'needs-me', openQuestion: true }), [asking({})]);
    await userEvent.click(screen.getByText('Yes'));
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    await waitFor(() => expect(answer).toHaveBeenCalled());
    expect(answer.mock.calls[0]?.[0]).toEqual({
      id: 'abc12345',
      questionNoteId: 'q-new',
      questions,
      answers: [{ selected: ['Yes'] }],
      message: '',
    });
  });

  it('offers no question when the board sent the open question’s note twice', () => {
    const duplicate = asking({ unreadable: true, duplicateId: true, text: '', questions: undefined });
    renderPanel(running({ status: 'needs-me', openQuestion: true }), [duplicate, duplicate]);
    expect(screen.queryByRole('button', { name: /Answer & continue/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Add a regression test for the fix?')).not.toBeInTheDocument();
  });
});

describe('ActionPanel of a backlog task', () => {
  it('says it is parked and offers Move to Todo and a comment box', () => {
    renderPanel(running({ status: 'backlog' }), []);
    expect(screen.getByText(/Parked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to Todo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument();
  });
});

describe('ActionPanel of a delayed task', () => {
  it('says when it starts and Run now clears the delay', async () => {
    setNotBefore.mockClear();
    const notBefore = new Date(Date.now() + 3_600_000).toISOString();
    renderPanel(running({ status: 'todo', machine: null, sessionId: null, notBefore }), []);
    expect(screen.getByText(`Waiting until ${stamp(notBefore)}.`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(setNotBefore).toHaveBeenCalled());
    expect(setNotBefore.mock.calls[0]?.[0]).toEqual({ id: 'abc12345', notBefore: null });
  });

  it('says a waiting card of a schedule is its next run, with a link to the Schedules page', () => {
    const notBefore = new Date(Date.now() + 3_600_000).toISOString();
    renderPanel(running({ status: 'todo', sessionId: null, notBefore, scheduleId: 'sch1' }), []);
    expect(screen.getByText(/the next run of a repeating schedule/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Schedules' })).toHaveAttribute('href', '/schedules');
  });

  it('does not call an ordinary delayed card a schedule run', () => {
    const notBefore = new Date(Date.now() + 3_600_000).toISOString();
    renderPanel(running({ status: 'todo', sessionId: null, notBefore }), []);
    expect(screen.queryByText(/repeating schedule/)).not.toBeInTheDocument();
  });

  it('shows neither once the task is due', () => {
    const notBefore = new Date(Date.now() - 1000).toISOString();
    renderPanel(running({ status: 'todo', notBefore }), []);
    expect(screen.queryByText(/Waiting until/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
  });
});
