import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../lib/trpc';
import { ForkModal } from './ForkModal';

const fork = vi.hoisted(() => vi.fn(async (_: unknown) => ({ id: 'fork0001' })));

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({ tasks: { fork: { mutationOptions: () => ({ mutationFn: fork }) } } }),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Instructions" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}));

const parent = {
  id: 'parent01',
  title: 'Fix the export',
  status: 'needs-me',
  closed: false,
  createdBy: 'user',
  machine: 'laptop',
  sessionId: 's',
  workdir: '/work/app',
  agent: null,
  unreadable: [],
} as unknown as BoardTask;

function open(task: BoardTask = parent) {
  render(
    <MemoryRouter>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Routes>
            <Route path="/" element={<ForkModal opened onClose={() => undefined} parent={task} />} />
            <Route path="/t/:id" element={<p>task page</p>} />
          </Routes>
        </QueryClientProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
}

const start = () => screen.getByRole('button', { name: 'Fork & start' });

beforeEach(() => {
  fork.mockClear();
});

describe('ForkModal', () => {
  it('prefills the title, needs instructions, and says what a fork keeps', async () => {
    open();
    expect(screen.getByLabelText('Title')).toHaveValue('Fork of Fix the export');
    expect(screen.getByText(/continues a copy of this task's Claude session on laptop/)).toBeInTheDocument();
    expect(start()).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Instructions'), '   ');
    expect(start()).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Instructions'), 'look into the flaky test');
    expect(start()).toBeEnabled();
  });

  it('forks the task as shown, with the title and instructions, and goes to the new task', async () => {
    open();
    await userEvent.type(screen.getByLabelText('Instructions'), 'look into the flaky test');
    await userEvent.clear(screen.getByLabelText('Title'));
    await userEvent.type(screen.getByLabelText('Title'), 'Flaky test');
    await userEvent.click(start());
    await waitFor(() => expect(screen.getByText('task page')).toBeInTheDocument());
    expect(fork).toHaveBeenCalledOnce();
    expect(fork.mock.calls[0]?.[0]).toEqual({ parent, title: 'Flaky test', input: 'look into the flaky test' });
  });

  it('shows what the board refuses and stays open', async () => {
    fork.mockRejectedValueOnce(new Error('The CLI of laptop does not know forks'));
    open();
    await userEvent.type(screen.getByLabelText('Instructions'), 'go');
    await userEvent.click(start());
    expect(await screen.findByText('The CLI of laptop does not know forks')).toBeInTheDocument();
    expect(screen.queryByText('task page')).not.toBeInTheDocument();
  });

  it('does not let a task fork that has nothing to take over, and says why', async () => {
    open({ ...parent, workdir: null });
    expect(screen.getByText(/directory or agent cannot be read/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Instructions'), 'go');
    expect(start()).toBeDisabled();
  });
});
