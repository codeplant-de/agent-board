import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListedTask } from '../lib/trpc';
import { BoardPage } from './BoardPage';

const move = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const create = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const done = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const listed = vi.hoisted(() => ({ tasks: [] as unknown[], machines: [] as unknown[] }));

vi.mock('../lib/trpc', () => ({
  POLL_MS: 60_000,
  useTRPC: () => ({
    tasks: {
      list: { queryOptions: () => ({ queryKey: ['tasks.list'], queryFn: async () => listed.tasks }) },
      move: { mutationOptions: () => ({ mutationFn: move }) },
      create: { mutationOptions: () => ({ mutationFn: create }) },
      done: { mutationOptions: () => ({ mutationFn: done }) },
    },
    machines: {
      list: { queryOptions: () => ({ queryKey: ['machines.list'], queryFn: async () => listed.machines }) },
    },
    slack: {
      inbox: {
        list: { queryOptions: () => ({ queryKey: ['slack.inbox.list'], queryFn: async () => [] }) },
        remove: { mutationOptions: () => ({ mutationFn: async () => null }) },
      },
    },
  }),
}));

const task = (overrides: Partial<ListedTask>): ListedTask =>
  ({
    id: 'p1',
    title: 'proposal',
    input: 'delete everything',
    pr: null,
    prState: null,
    status: 'needs-me',
    priority: 'normal',
    createdBy: 'agent',
    closed: false,
    openQuestion: false,
    machine: null,
    lane: null,
    sessionId: null,
    next: 'fresh',
    head: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    parentId: null,
    proposed: true,
    paused: false,
    notBefore: null,
    lastActiveAt: null,
    runStartedAt: null,
    borrowed: false,
    unreadable: [],
    invalid: [],
    labels: [],
    lastNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }) as ListedTask;

function renderBoard() {
  return render(
    <MemoryRouter>
      <MantineProvider>
        <ModalsProvider>
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <BoardPage />
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
}

const column = (name: string) => screen.getByText(name).closest('.board-column') as HTMLElement;

async function drag(title: string, to: string) {
  const card = (await screen.findByText(title)).closest('a') as HTMLElement;
  const dataTransfer = { effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(column(to), { dataTransfer });
  fireEvent.drop(column(to), { dataTransfer });
}

beforeEach(() => {
  move.mockClear();
  create.mockClear();
  done.mockClear();
  listed.machines = [];
});

describe('BoardPage drag and drop', () => {
  it('shows the whole prompt before a drag into Todo starts an agent’s proposal, and moves nothing until confirmed', async () => {
    listed.tasks = [task({})];
    renderBoard();
    await drag('proposal', 'Todo');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('proposal-prompt').textContent).toBe('delete everything');
    expect(move).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start as mine' }));
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0]?.[0]).toMatchObject({ id: 'p1', status: 'todo', task: { createdBy: 'agent' } });
  });

  it('does not ask, and does not start anything, when an agent’s task the board put in Todo is reordered there', async () => {
    listed.tasks = [task({ status: 'todo', proposed: false })];
    renderBoard();
    await drag('proposal', 'Todo');
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(move.mock.calls[0]?.[0]).toMatchObject({ task: { status: 'todo' } });
  });

  it('does not ask for a move of the user’s own task into Todo', async () => {
    listed.tasks = [task({ createdBy: 'user', proposed: false, status: 'backlog' })];
    renderBoard();
    await drag('proposal', 'Todo');
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('BoardPage move merged to Done', () => {
  const merged = (id: string, overrides: Partial<ListedTask> = {}) =>
    task({
      id,
      title: `merged ${id}`,
      createdBy: 'user',
      proposed: false,
      pr: `https://github.com/acme/app/pull/${id.length}${id}`,
      prState: 'merged',
      ...overrides,
    });

  it('moves the merged tasks of Needs me to Done and leaves the others', async () => {
    listed.tasks = [
      merged('m1'),
      merged('m2'),
      merged('m3', { status: 'todo' }),
      merged('m4', { prState: 'open' }),
      merged('m5', { pr: null }),
    ];
    renderBoard();
    await userEvent.click(await screen.findByRole('button', { name: /Move merged to Done/ }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(2));
    expect(done.mock.calls.map(([variables]) => variables)).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  it('is only there while Needs me has a merged PR', async () => {
    listed.tasks = [merged('m1', { prState: 'closed' }), merged('m2', { status: 'done' }), merged('m3', { pr: null })];
    renderBoard();
    await screen.findByText('merged m1');
    expect(screen.queryByRole('button', { name: /Move merged to Done/ })).not.toBeInTheDocument();
  });

  it('counts a review task whose prompt names the PR', async () => {
    listed.tasks = [merged('r1', { pr: null, input: '/review-pr https://github.com/acme/app/pull/9 --auto' })];
    renderBoard();
    expect(await screen.findByRole('button', { name: 'Move merged to Done (1)' })).toBeInTheDocument();
  });
});

describe('BoardPage layout', () => {
  it('stacks Waiting above Todo in one board cell', async () => {
    listed.tasks = [];
    renderBoard();
    await screen.findAllByText('Empty');
    const cell = column('Waiting').closest('.board-cell') as HTMLElement;
    expect(cell).toBe(column('Todo').closest('.board-cell'));
    expect(column('Waiting').compareDocumentPosition(column('Todo')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('BoardPage polish action', () => {
  const backlog = (overrides: Partial<ListedTask>) =>
    task({ id: 'b1', title: 'rough idea', createdBy: 'user', proposed: false, status: 'backlog', ...overrides });

  it('queues a polish task from a backlog card without opening the card', async () => {
    listed.tasks = [backlog({ priority: 'urgent' })];
    renderBoard();
    await userEvent.click(await screen.findByRole('button', { name: 'Polish prompt' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      title: 'Polish prompt: rough idea',
      priority: 'urgent',
      parentId: 'b1',
    });
  });

  it('disables it while a polish task of the card is open', async () => {
    listed.tasks = [
      backlog({}),
      task({
        id: 'c1',
        title: 'Polish prompt: rough idea',
        parentId: 'b1',
        createdBy: 'user',
        proposed: false,
        status: 'todo',
      }),
    ];
    renderBoard();
    expect(await screen.findByRole('button', { name: 'Polish prompt' })).toBeDisabled();
  });

  it('is only on the cards of a task of the user’s in the backlog', async () => {
    listed.tasks = [
      backlog({ id: 'b2', title: 'agent’s', createdBy: 'agent' }),
      task({ id: 'n1', title: 'waiting', createdBy: 'user' }),
    ];
    renderBoard();
    await screen.findByText('waiting');
    expect(screen.queryByRole('button', { name: 'Polish prompt' })).not.toBeInTheDocument();
  });
});

describe('BoardPage banner for machines whose CLI the board refuses', () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const machine = (name: string, overrides: Record<string, unknown> = {}) => ({
    name,
    shown: name,
    revokedAt: null,
    lastSeenAt: hoursAgo(1),
    clientVersion: '0.4.0',
    clientStatus: 'incompatible',
    ...overrides,
  });

  it('names the machines seen in the last day and links to Settings', async () => {
    listed.tasks = [];
    listed.machines = [
      machine('laptop'),
      machine('workstation'),
      machine('old-box', { lastSeenAt: hoursAgo(30) }),
      machine('revoked-box', { revokedAt: hoursAgo(2) }),
      machine('never-seen', { lastSeenAt: null }),
      machine('fine', { clientStatus: 'current', clientVersion: '0.7.0' }),
    ];
    renderBoard();
    const banner = await screen.findByText(/A machine needs a CLI update/);
    const alert = banner.closest('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('laptop, workstation');
    expect(alert.textContent).not.toMatch(/old-box|revoked-box|never-seen|fine/);
    expect(within(alert).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('shows nothing while every machine is compatible', async () => {
    listed.tasks = [];
    listed.machines = [machine('laptop', { clientStatus: 'outdated' }), machine('b', { clientStatus: 'unknown' })];
    renderBoard();
    await screen.findByText('Backlog');
    expect(screen.queryByText(/A machine needs a CLI update/)).not.toBeInTheDocument();
  });
});
