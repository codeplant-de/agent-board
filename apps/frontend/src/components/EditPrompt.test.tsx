import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask, Schedule } from '../lib/trpc';
import { EditSchedulePrompt, EditTaskPrompt } from './EditPrompt';

const editTask = vi.hoisted(() => vi.fn(async (_: unknown) => ({})));
const editSchedule = vi.hoisted(() =>
  vi.fn(async (_: unknown): Promise<{ pending: 'updated' | 'started' | 'none' }> => ({ pending: 'updated' })),
);

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    tasks: { edit: { mutationOptions: () => ({ mutationFn: editTask }) } },
    schedules: { edit: { mutationOptions: () => ({ mutationFn: editSchedule }) } },
  }),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) => (
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}));

const task = (overrides: Partial<BoardTask> = {}): BoardTask =>
  ({
    id: 'task0001',
    status: 'todo',
    proposed: false,
    closed: false,
    started: false,
    title: 'Old title',
    input: 'Old prompt',
    createdBy: 'user',
    scheduleId: null,
    agent: 'reviewer',
    unreadable: [],
    ...overrides,
  }) as BoardTask;

const schedule = (overrides: Partial<Schedule> = {}): Schedule =>
  ({ id: 'sched001', title: 'Nightly', input: 'sweep', agent: undefined, unreadable: [], ...overrides }) as Schedule;

function renderWith(ui: React.ReactNode) {
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {ui}
      </QueryClientProvider>
    </MantineProvider>,
  );
}

const retype = async (label: string, text: string) => {
  const field = await screen.findByLabelText(label);
  await userEvent.clear(field);
  await userEvent.type(field, text);
};

beforeEach(() => {
  editTask.mockReset().mockResolvedValue({});
  editSchedule.mockReset().mockResolvedValue({ pending: 'updated' as const });
});

describe('EditTaskPrompt', () => {
  it('opens the editor with the title and prompt filled in and saves nothing until they change', async () => {
    renderWith(<EditTaskPrompt task={task()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit prompt' }));
    expect(await screen.findByLabelText('Title')).toHaveValue('Old title');
    expect(screen.getByLabelText('Prompt')).toHaveValue('Old prompt');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('sends the task as the page shows it, with its agent, and the new text', async () => {
    renderWith(<EditTaskPrompt task={task()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit prompt' }));
    await retype('Prompt', 'New prompt');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(editTask).toHaveBeenCalled());
    expect(editTask.mock.calls[0]?.[0]).toMatchObject({
      target: { id: 'task0001', agent: 'reviewer', scheduleId: null },
      title: 'Old title',
      input: 'New prompt',
    });
    await waitFor(() => expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument());
  });

  it('shows the server’s refusal in the editor and keeps what was typed', async () => {
    editTask.mockRejectedValue(
      new Error('The task has already run; its prompt is in its thread now. Reply to it instead.'),
    );
    renderWith(<EditTaskPrompt task={task()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit prompt' }));
    await retype('Prompt', 'New prompt');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/already run/)).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveValue('New prompt');
  });

  it('stays open with the draft when the task is claimed meanwhile, and shows the refusal on save', async () => {
    editTask.mockRejectedValue(
      new Error('The task has started; its prompt is in its thread now. Reply to it instead.'),
    );
    const view = (started: boolean) => (
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <EditTaskPrompt task={task({ started, status: started ? 'running' : 'todo' })} />
        </QueryClientProvider>
      </MantineProvider>
    );
    const { rerender } = render(view(false));
    await userEvent.click(screen.getByRole('button', { name: 'Edit prompt' }));
    await retype('Prompt', 'my draft');
    rerender(view(true));
    expect(screen.getByLabelText('Prompt')).toHaveValue('my draft');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/The task has started/)).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveValue('my draft');
  });

  it('shows no button for a task that cannot be edited', () => {
    renderWith(<EditTaskPrompt task={task({ started: true })} />);
    expect(screen.queryByRole('button', { name: 'Edit prompt' })).not.toBeInTheDocument();
  });
});

describe('EditSchedulePrompt', () => {
  it('sends the schedule and the new text, then says the pending card was updated', async () => {
    renderWith(<EditSchedulePrompt schedule={schedule()} onClose={() => undefined} />);
    expect(screen.getByLabelText('Title')).toHaveValue('Nightly');
    await retype('Prompt', 'sweep harder');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The pending card was updated too.')).toBeInTheDocument();
    expect(editSchedule.mock.calls[0]?.[0]).toMatchObject({
      schedule: { id: 'sched001', agent: null },
      title: 'Nightly',
      input: 'sweep harder',
    });
  });

  it('says when the schedule has no pending card', async () => {
    editSchedule.mockResolvedValue({ pending: 'none' as const });
    renderWith(<EditSchedulePrompt schedule={schedule()} onClose={() => undefined} />);
    await retype('Prompt', 'sweep harder');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('The schedule has no pending card; its next run takes the change.'),
    ).toBeInTheDocument();
  });

  it('says when the pending card had already started', async () => {
    editSchedule.mockResolvedValue({ pending: 'started' as const });
    renderWith(<EditSchedulePrompt schedule={schedule()} onClose={() => undefined} />);
    await retype('Prompt', 'sweep harder');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('The pending card has already started; the change applies from the next run.'),
    ).toBeInTheDocument();
  });

  it('shows an error inline, for example an ended schedule', async () => {
    editSchedule.mockRejectedValue(new Error('The schedule has ended.'));
    renderWith(<EditSchedulePrompt schedule={schedule()} onClose={() => undefined} />);
    await retype('Prompt', 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The schedule has ended.')).toBeInTheDocument();
  });
});
