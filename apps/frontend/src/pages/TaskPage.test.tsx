import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../lib/trpc';
import { TaskPage } from './TaskPage';

const shown = vi.hoisted(() => ({ task: undefined as unknown }));

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
  }),
}));
vi.mock('../components/ActionPanel', () => ({ ActionPanel: () => null }));
vi.mock('../components/TranscriptDrawer', () => ({ TranscriptDrawer: () => null }));

const task = (overrides: Partial<BoardTask>): BoardTask =>
  ({
    id: 't1',
    title: 'A task',
    input: 'Fix the bug',
    pr: null,
    prState: null,
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
  });

  it('links the PR the agent reported', async () => {
    renderPage({ pr: 'https://github.com/acme/app/pull/2' });
    const link = await screen.findByRole('link', { name: 'acme/app/pull/2' });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/pull/2');
  });

  it('shows the PR the prompt names first and the reported one beside it', async () => {
    renderPage({
      input: '/review-pr https://github.com/acme/app/pull/1 --auto',
      pr: 'https://github.com/acme/app/pull/2',
    });
    expect(await screen.findByRole('link', { name: 'acme/app/pull/1' })).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /^acme\/app\/pull\/\d+$/ });
    expect(links.map((link) => link.textContent)).toEqual(['acme/app/pull/1', 'acme/app/pull/2']);
  });

  it('shows no link for a task without a PR', async () => {
    renderPage({});
    await screen.findByText('A task');
    expect(screen.queryByRole('link', { name: /acme/ })).not.toBeInTheDocument();
  });

  it('shows the state of the PR next to its link, only for the PR the state is about', async () => {
    renderPage({
      input: '/review-pr https://github.com/acme/app/pull/1 --auto',
      pr: 'https://github.com/acme/app/pull/2',
      prState: 'merged',
    });
    const [first, second] = await screen.findAllByRole('link', { name: /acme\/app\/pull\/\d+$/ });
    expect(within(first!).getByLabelText('PR merged')).toBeInTheDocument();
    expect(within(second!).queryByLabelText('PR merged')).not.toBeInTheDocument();
  });

  it('shows a closed PR as closed', async () => {
    renderPage({ pr: 'https://github.com/acme/app/pull/2', prState: 'closed' });
    expect(await screen.findByLabelText('PR closed')).toBeInTheDocument();
  });
});
