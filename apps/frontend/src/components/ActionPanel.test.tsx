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
const reply = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const create = vi.hoisted(() => vi.fn(async (_: unknown) => null));

vi.mock('../lib/trpc', () => {
  const procedure = (mutationFn: (variables: unknown) => Promise<unknown>) => ({
    mutationOptions: () => ({ mutationFn }),
  });
  const idle = procedure(async () => null);
  return {
    useTRPC: () => ({
      tasks: {
        answer: procedure(answer),
        reply: procedure(reply),
        done: idle,
        rerun: idle,
        setClosed: idle,
        move: procedure(move),
        create: procedure(create),
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

function renderPanel(task: BoardTask, thread: ThreadNote[] = [], followUps: BoardTask[] = []) {
  return render(
    <MemoryRouter>
      <MantineProvider>
        <ModalsProvider>
          <QueryClientProvider client={new QueryClient()}>
            <ActionPanel task={task} thread={thread} followUps={followUps} />
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
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Start as mine' }));
    await waitFor(() => expect(move).toHaveBeenCalled());
    expect(move.mock.calls[0]?.[0]).toEqual({ id: 'abc12345', status: 'todo', task: proposal });
    expect(screen.getByRole('button', { name: 'Send & run' })).toBeDisabled();
  });

  it('shows the whole prompt and starts nothing until the user confirms', async () => {
    move.mockClear();
    const prompt = `${'long prompt line\n'.repeat(30)}and finally: rm -rf the build directory`;
    const proposal = running({
      status: 'needs-me',
      proposed: true,
      createdBy: 'agent',
      input: prompt,
      sessionId: null,
    });
    renderPanel(proposal, []);
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('proposal-prompt').textContent).toBe(prompt);
    expect(move).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(move).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Start as mine' }));
    await waitFor(() => expect(move).toHaveBeenCalled());
    expect(move.mock.calls[0]?.[0]).toEqual({ id: 'abc12345', status: 'todo', task: proposal });
  });

  it('asks the same of Move to Todo from Backlog, and of nothing else that moves a task of the user', async () => {
    move.mockClear();
    const proposal = running({ status: 'backlog', createdBy: 'agent', input: 'do Y', sessionId: null });
    renderPanel(proposal, []);
    await userEvent.click(screen.getByRole('button', { name: 'Move to Todo' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('proposal-prompt').textContent).toBe('do Y');
    expect(move).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start as mine' }));
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
  });

  it('moves a task of the user to Todo without a question', async () => {
    move.mockClear();
    renderPanel(running({ status: 'backlog', createdBy: 'user', sessionId: null }), []);
    await userEvent.click(screen.getByRole('button', { name: 'Move to Todo' }));
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not say a worker starts a proposal the board put in Todo, since none will', () => {
    renderPanel(running({ status: 'todo', createdBy: 'agent', sessionId: null, next: 'fresh' }), []);
    expect(screen.queryByText(/next free worker starts it/)).not.toBeInTheDocument();
    expect(screen.queryByText('Queued.')).not.toBeInTheDocument();
    expect(screen.getByText(/will not run/)).toBeInTheDocument();
  });

  it('still says a task of the user in Todo is started by the next free worker', () => {
    renderPanel(running({ status: 'todo', createdBy: 'user', sessionId: null, next: 'fresh' }), []);
    expect(screen.getByText(/next free worker starts it/)).toBeInTheDocument();
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

  it('does not seal a question the board swapped in after the pick: it says the question changed and drops the picks', async () => {
    answer.mockClear();
    const task = running({ status: 'needs-me', openQuestion: true });
    const swapped = [
      {
        header: 'Cleanup',
        question: 'Force-push main and delete the release branch?',
        multiSelect: false,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
      },
    ];
    const view = renderPanel(task, [asking({})]);
    await userEvent.click(screen.getByText('Yes'));
    view.rerender(
      <MemoryRouter>
        <MantineProvider>
          <ModalsProvider>
            <QueryClientProvider client={new QueryClient()}>
              <ActionPanel task={task} thread={[asking({ questions: swapped })]} followUps={[]} />
            </QueryClientProvider>
          </ModalsProvider>
        </MantineProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('The question changed')).toBeInTheDocument();
    expect(screen.queryByText('Force-push main and delete the release branch?')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Answer & continue/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show the changed questions' }));
    expect(screen.getByText('Force-push main and delete the release branch?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(answer).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('No'));
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    await waitFor(() => expect(answer).toHaveBeenCalled());
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ questions: swapped, answers: [{ selected: ['No'] }] });
  });

  it('seals the questions it showed even when an unchanged poll re-renders it', async () => {
    answer.mockClear();
    const task = running({ status: 'needs-me', openQuestion: true });
    const view = renderPanel(task, [asking({})]);
    await userEvent.click(screen.getByText('No'));
    view.rerender(
      <MemoryRouter>
        <MantineProvider>
          <ModalsProvider>
            <QueryClientProvider client={new QueryClient()}>
              <ActionPanel task={task} thread={[asking({ questions: structuredClone(questions) })]} followUps={[]} />
            </QueryClientProvider>
          </ModalsProvider>
        </MantineProvider>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    await waitFor(() => expect(answer).toHaveBeenCalled());
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ questions, answers: [{ selected: ['No'] }] });
  });

  it('offers no question when the board sent the open question’s note twice', () => {
    const duplicate = asking({ unreadable: true, duplicateId: true, text: '', questions: undefined });
    renderPanel(running({ status: 'needs-me', openQuestion: true }), [duplicate, duplicate]);
    expect(screen.queryByRole('button', { name: /Answer & continue/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Add a regression test for the fix?')).not.toBeInTheDocument();
  });
});

describe('ActionPanel with a suggested reply', () => {
  const note = (overrides: Partial<ThreadNote>): ThreadNote =>
    ({
      id: 'n1',
      kind: 'comment',
      author: 'agent',
      text: 'Ready for review.',
      createdAt: new Date().toISOString(),
      by: 'laptop',
      unreadable: false,
      ...overrides,
    }) as ThreadNote;
  const suggested = note({ suggestion: 'Yes, open the PR.' });
  const waiting = () => running({ status: 'needs-me' });
  const box = () => screen.getByRole('textbox');

  it('offers it as ghost text in the empty editor and a row above it', () => {
    renderPanel(waiting(), [suggested]);
    const row = screen.getByTestId('suggested-reply');
    expect(within(row).getByText('Suggested reply')).toBeInTheDocument();
    expect(within(row).getByText('Yes, open the PR.')).toBeInTheDocument();
    expect(box()).toHaveAttribute('placeholder', 'Yes, open the PR.');
    expect(box()).toHaveValue('');
  });

  it('fills the editor on Tab, once, and only while it is empty', async () => {
    renderPanel(waiting(), [suggested]);
    await userEvent.click(box());
    await userEvent.tab();
    expect(box()).toHaveValue('Yes, open the PR.');
    await userEvent.clear(box());
    await userEvent.type(box(), 'No');
    await userEvent.keyboard('{Tab}');
    expect(box()).toHaveValue('No');
  });

  it('puts it in the editor for editing with Use', async () => {
    reply.mockClear();
    renderPanel(waiting(), [suggested]);
    await userEvent.click(within(screen.getByTestId('suggested-reply')).getByRole('button', { name: 'Use' }));
    expect(box()).toHaveValue('Yes, open the PR.');
    expect(screen.queryByTestId('suggested-reply')).not.toBeInTheDocument();
    expect(reply).not.toHaveBeenCalled();
  });

  it('sends it in one click and resumes the agent, like Send & continue', async () => {
    reply.mockClear();
    renderPanel(waiting(), [suggested]);
    await userEvent.click(screen.getByRole('button', { name: 'Send suggested reply' }));
    await waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0]?.[0]).toEqual({ id: 'abc12345', message: 'Yes, open the PR.', resume: true });
  });

  it('is not offered once a note of the user follows it', () => {
    const user = note({ id: 'n2', author: 'user', text: 'wait' });
    renderPanel(waiting(), [suggested, user]);
    expect(screen.queryByTestId('suggested-reply')).not.toBeInTheDocument();
    expect(box()).not.toHaveAttribute('placeholder', 'Yes, open the PR.');
  });

  it('is not offered when a newer agent comment has none', () => {
    renderPanel(waiting(), [suggested, note({ id: 'n3', text: 'More news.' })]);
    expect(screen.queryByTestId('suggested-reply')).not.toBeInTheDocument();
  });

  it('is not offered on a done task, whose last agent comment is stale', () => {
    renderPanel(running({ status: 'done' }), [suggested]);
    expect(screen.queryByTestId('suggested-reply')).not.toBeInTheDocument();
  });

  it('is not offered on a proposal', () => {
    renderPanel(running({ status: 'needs-me', createdBy: 'agent', proposed: true }), [suggested]);
    expect(screen.queryByTestId('suggested-reply')).not.toBeInTheDocument();
  });

  it('is not offered with an open question, which has its own options', () => {
    const question = note({
      id: 'q1',
      kind: 'question',
      text: '',
      suggestion: undefined,
      questions: [
        {
          header: 'Go',
          question: 'Go on?',
          multiSelect: false,
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
        },
      ],
    });
    renderPanel(running({ status: 'needs-me', openQuestion: true }), [suggested, question]);
    expect(screen.queryByTestId('suggested-reply')).not.toBeInTheDocument();
  });
});

describe('ActionPanel of a backlog task', () => {
  it('says it is parked and offers Move to Todo and a comment box', () => {
    renderPanel(running({ status: 'backlog' }), []);
    expect(screen.getByText(/Parked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to Todo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument();
  });

  it('queues a polish task under the backlog task, with its priority and a prompt that forbids doing the work', async () => {
    create.mockClear();
    renderPanel(running({ status: 'backlog', title: 'rough idea', priority: 'high', sessionId: null }), []);
    await userEvent.click(screen.getByRole('button', { name: 'Polish prompt' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const sent = create.mock.calls[0]?.[0] as { title: string; input: string; priority: string; parentId: string };
    expect(sent).toMatchObject({ title: 'Polish prompt: rough idea', priority: 'high', parentId: 'abc12345' });
    expect(sent.input).toContain('`board show abc12345`');
    expect(sent.input).toContain('board polish abc12345 --title');
    expect(sent.input).toMatch(/Do not start the work/);
  });

  it('disables the polish button while a polish task of it is still open, and not once it is done', () => {
    const polishing = (overrides: Partial<BoardTask>) =>
      running({ id: 'child1', title: 'Polish prompt: t', parentId: 'abc12345', status: 'todo', ...overrides });
    const backlog = running({ status: 'backlog', sessionId: null });
    const open = renderPanel(backlog, [], [polishing({})]);
    expect(screen.getByRole('button', { name: 'Polish prompt' })).toBeDisabled();
    open.unmount();
    renderPanel(backlog, [], [polishing({ status: 'done' })]);
    expect(screen.getByRole('button', { name: 'Polish prompt' })).toBeEnabled();
  });

  it.each([
    ['one an agent proposed', { createdBy: 'agent' }],
    ['an occurrence of a schedule', { scheduleId: 'sch1' }],
    ['one that cannot be read', { unreadable: ['input'] }],
  ] satisfies [string, Partial<BoardTask>][])('offers no polish for %s', (_name, overrides) => {
    renderPanel(running({ status: 'backlog', sessionId: null, ...overrides }), []);
    expect(screen.queryByRole('button', { name: 'Polish prompt' })).not.toBeInTheDocument();
  });

  it('offers no polish outside the backlog', () => {
    renderPanel(running({ status: 'needs-me', sessionId: null }), []);
    expect(screen.queryByRole('button', { name: 'Polish prompt' })).not.toBeInTheDocument();
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
