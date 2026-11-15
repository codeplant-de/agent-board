import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../lib/trpc';
import { TaskPage } from './TaskPage';

vi.mock('../lib/trpc', () => {
  const idle = { mutationOptions: () => ({ mutationFn: async () => null }) };
  return {
    POLL_MS: 60_000,
    errorMessage: () => 'error',
    useTRPCClient: () => ({}),
    useTRPC: () => ({
      tasks: {
        get: { queryOptions: ({ id }: { id: string }) => ({ queryKey: ['tasks.get', id] }) },
        setPriority: idle,
        answer: idle,
        reply: idle,
        done: idle,
        rerun: idle,
        setClosed: idle,
        move: idle,
        create: idle,
        takeBack: idle,
        setNotBefore: idle,
        wakeNow: idle,
        applyPolish: idle,
      },
      transcript: {
        runs: { queryOptions: ({ id }: { id: string }) => ({ queryKey: ['transcript.runs', id] }) },
        events: { queryKey: (input: unknown) => ['transcript.events', input] },
      },
    }),
  };
});

const task = (id: string, title: string): BoardTask =>
  ({
    id,
    title,
    input: 'do it',
    labels: [],
    status: 'needs-me',
    priority: 'normal',
    closed: false,
    machine: null,
    sessionId: 's',
    workdir: null,
    next: 'resume',
    head: null,
    openQuestion: false,
    createdBy: 'user',
    lane: null,
    borrowed: false,
    lastActiveAt: null,
    runStartedAt: null,
    paused: false,
    notBefore: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    proposed: false,
    invalid: [],
    unreadable: [],
    parentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as BoardTask;

describe('TaskPage', () => {
  it('drops the draft of one task when it goes to another that is already in the cache', async () => {
    const a = task('aaaa1111', 'Task A');
    const b = { ...task('bbbb2222', 'Task B'), parentId: a.id };
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(['tasks.get', a.id], { task: a, thread: [], followUps: [b], parent: null });
    client.setQueryData(['tasks.get', b.id], { task: b, thread: [], followUps: [], parent: a });
    render(
      <MemoryRouter initialEntries={[`/t/${a.id}`]}>
        <MantineProvider>
          <ModalsProvider>
            <QueryClientProvider client={client}>
              <Routes>
                <Route path="/t/:id" element={<TaskPage />} />
              </Routes>
            </QueryClientProvider>
          </ModalsProvider>
        </MantineProvider>
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByRole('textbox'), 'only for A');
    await userEvent.click(screen.getByRole('link', { name: 'Task B' }));

    expect(screen.getByRole('heading', { name: 'Task B' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send & continue' })).toBeDisabled();
  });
});
