import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModalsProvider } from '@mantine/modals';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../lib/trpc';
import { TaskPage } from './TaskPage';

const shown = vi.hoisted(() => ({
  task: undefined as unknown,
  machines: [] as unknown[],
  removed: [] as unknown[],
  catalogs: [] as unknown[],
  skills: [] as readonly { name: string }[],
}));

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
      configure: { mutationOptions: () => ({ mutationFn: async () => null }) },
      removePr: {
        mutationOptions: () => ({
          mutationFn: async (input: unknown) => {
            shown.removed.push(input);
            return null;
          },
        }),
      },
    },
    machines: {
      list: { queryOptions: () => ({ queryKey: ['machines.list'], queryFn: async () => shown.machines }) },
      catalogs: { queryOptions: () => ({ queryKey: ['machines.catalogs'], queryFn: async () => shown.catalogs }) },
    },
  }),
}));
vi.mock('../components/ActionPanel', () => ({
  ActionPanel: ({ skills }: { skills: readonly { name: string }[] }) => {
    shown.skills = skills;
    return null;
  },
}));
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
        <ModalsProvider>
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <Routes>
              <Route path="/t/:id" element={<TaskPage />} />
            </Routes>
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
}

describe('TaskPage pull request link', () => {
  beforeEach(() => {
    shown.task = undefined;
    shown.machines = [];
    shown.removed = [];
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

describe('TaskPage pull request removal', () => {
  beforeEach(() => {
    shown.task = undefined;
    shown.removed = [];
  });

  it('offers to remove a reported PR, after a confirmation, with the id of its row', async () => {
    renderPage({ prs: [{ id: 'r1', url: 'https://github.com/acme/app/pull/2', state: null }] });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove acme/app/pull/2' }));
    expect(shown.removed).toEqual([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(shown.removed).toEqual([{ id: 't1', prId: 'r1' }]));
  });

  it('removes nothing when the confirmation is cancelled', async () => {
    renderPage({ prs: [{ id: 'r1', url: 'https://github.com/acme/app/pull/2', state: null }] });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove acme/app/pull/2' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(shown.removed).toEqual([]);
  });

  it('offers nothing for the PR the prompt names, also when the agent reported it too', async () => {
    renderPage({
      input: '/review-pr https://github.com/acme/app/pull/1 --auto',
      prs: [
        { id: 'r1', url: 'https://github.com/acme/app/pull/1', state: null },
        { id: 'r2', url: 'https://github.com/acme/app/pull/2', state: null },
      ],
    });
    await screen.findByRole('link', { name: 'acme/app/pull/1' });
    expect(screen.queryByRole('button', { name: 'Remove acme/app/pull/1' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove acme/app/pull/2' })).toBeInTheDocument();
  });

  it('offers nothing for a PR only the prompt names', async () => {
    renderPage({ input: '/review-pr https://github.com/acme/app/pull/1 --auto' });
    await screen.findByRole('link', { name: 'acme/app/pull/1' });
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
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

describe('TaskPage skills', () => {
  it('offers the reply field the skills of its machine and directory, from the catalogues query', async () => {
    shown.machines = [{ name: 'laptop', shown: 'laptop', dirs: [{ path: '/work/app' }] }];
    shown.catalogs = [
      {
        name: 'laptop',
        catalog: {
          models: [],
          skills: [{ name: 'review' }],
          dirs: { '/work/app': [{ name: 'deploy' }], '/work/other': [{ name: 'sweep' }] },
        },
      },
    ];
    renderPage({ machine: 'laptop', workdir: '/work/app' });
    await screen.findByText('laptop:/work/app');
    await waitFor(() => expect(shown.skills.map(({ name }) => name)).toEqual(['deploy', 'review']));
  });
});
