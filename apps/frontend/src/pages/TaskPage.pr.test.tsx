import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../lib/trpc';
import { TaskPage } from './TaskPage';

const shown = vi.hoisted(() => ({ task: undefined as unknown, machines: [] as unknown[] }));

vi.mock('../lib/trpc', () => ({
  POLL_MS: 60_000,
  errorMessage: (error: unknown) => String(error),
  useTRPC: () => ({
    tasks: {
      get: {
        queryOptions: () => ({
          queryKey: ['tasks.get'],
          queryFn: async () => ({ task: shown.task, thread: [], followUps: [], parent: null }),
        }),
      },
      setPriority: { mutationOptions: () => ({ mutationFn: async () => null }) },
    },
    machines: {
      list: { queryOptions: () => ({ queryKey: ['machines.list'], queryFn: async () => shown.machines }) },
    },
  }),
}));
vi.mock('../components/ActionPanel', () => ({ ActionPanel: () => null }));
vi.mock('../components/TranscriptDrawer', () => ({ TranscriptDrawer: () => null }));

const task = (overrides: Partial<BoardTask>): BoardTask =>
  ({
    id: 't1',
    title: 'A task',
    input: 'Fix the bug',
    prs: [],
    model: null,
    promptPrState: null,
    status: 'needs-me',
    priority: 'normal',
    createdBy: 'user',
    closed: false,
    openQuestion: false,
    machine: null,
    workdir: null,
    lane: null,
    sessionId: null,
    next: 'fresh',
    head: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    parentId: null,
    proposed: false,
    paused: false,
    notBefore: null,
    lastActiveAt: null,
    runStartedAt: null,
    borrowed: false,
    unreadable: [],
    invalid: [],
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }) as BoardTask;

function renderPage(overrides: Partial<BoardTask>) {
  shown.task = task(overrides);
  return render(
    <MemoryRouter initialEntries={['/t/t1']}>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Routes>
            <Route path="/t/:id" element={<TaskPage />} />
          </Routes>
        </QueryClientProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
}

describe('TaskPage pull request link', () => {
  beforeEach(() => {
    shown.task = undefined;
    shown.machines = [];
  });

  it('links the PR the agent reported', async () => {
    renderPage({ prs: [{ id: 'r1', url: 'https://github.com/acme/app/pull/2', state: null }] });
    const link = await screen.findByRole('link', { name: 'acme/app/pull/2' });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/pull/2');
  });

  it('shows the PR the prompt names first and the reported one beside it', async () => {
    renderPage({
      input: '/review-pr https://github.com/acme/app/pull/1 --auto',
      prs: [{ id: 'r1', url: 'https://github.com/acme/app/pull/2', state: null }],
    });
    expect(await screen.findByRole('link', { name: 'acme/app/pull/1' })).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /^(PR (merged|closed) )?acme\/app\/pull\/\d+$/ });
    expect(links.map((link) => link.textContent)).toEqual(['acme/app/pull/1', 'acme/app/pull/2']);
  });

  it('shows no link for a task without a PR', async () => {
    renderPage({});
    await screen.findByText('A task');
    expect(screen.queryByRole('link', { name: /acme/ })).not.toBeInTheDocument();
  });

  it('shows each PR with its own state', async () => {
    renderPage({
      input: '/review-pr https://github.com/acme/app/pull/1 --auto',
      promptPrState: 'closed',
      prs: [
        { id: 'r1', url: 'https://github.com/acme/app/pull/2', state: 'merged' },
        { id: 'r2', url: 'https://github.com/acme/app/pull/3', state: null },
      ],
    });
    const [first, second, third] = await screen.findAllByRole('link', { name: /acme\/app\/pull\/\d+$/ });
    expect(within(first!).getByLabelText('PR closed')).toBeInTheDocument();
    expect(within(second!).getByLabelText('PR merged')).toBeInTheDocument();
    expect(within(third!).queryByLabelText(/^PR (merged|closed)$/)).not.toBeInTheDocument();
  });

  it('shows a PR of the prompt that was also reported once, with the reported state', async () => {
    renderPage({
      input: '/review-pr https://github.com/acme/app/pull/1 --auto',
      prs: [{ id: 'r1', url: 'https://github.com/acme/app/pull/1', state: 'merged' }],
    });
    await screen.findByLabelText('PR merged');
    const links = document.querySelectorAll('a.truncate-flex');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://github.com/acme/app/pull/1');
  });

  it('shows a closed PR as closed', async () => {
    renderPage({ prs: [{ id: 'r1', url: 'https://github.com/acme/app/pull/2', state: 'closed' }] });
    expect(await screen.findByLabelText('PR closed')).toBeInTheDocument();
  });
});

describe('TaskPage directory', () => {
  beforeEach(() => {
    shown.machines = [{ name: 'laptop', shown: 'laptop', dirs: [{ path: '/work/app' }] }];
  });

  it('marks a directory that its machine does not list', async () => {
    renderPage({ machine: 'laptop', workdir: '/work/other' });
    expect(await screen.findByText(/laptop:\/work\/other · not listed on laptop/)).toBeInTheDocument();
  });

  it('says nothing about a directory below a listed one', async () => {
    renderPage({ machine: 'laptop', workdir: '/work/app/.claude/worktrees/x' });
    expect(await screen.findByText('laptop:/work/app/.claude/worktrees/x')).toBeInTheDocument();
  });
});
