import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schedule } from '../lib/trpc';
import { stamp } from '../lib/time';
import { SchedulesPage } from './SchedulesPage';

type Row = Schedule;

const list = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
const setPaused = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const remove = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const update = vi.hoisted(() =>
  vi.fn(async (_: unknown): Promise<{ pending: 'updated' | 'started' | 'none' }> => ({ pending: 'updated' })),
);

vi.mock('../components/MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) => (
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}));

vi.mock('../lib/trpc', () => ({
  POLL_MS: 5_000,
  errorMessage: String,
  useTRPC: () => ({
    schedules: {
      list: { queryOptions: () => ({ queryKey: ['schedules'], queryFn: list }) },
      setPaused: { mutationOptions: () => ({ mutationFn: setPaused }) },
      remove: { mutationOptions: () => ({ mutationFn: remove }) },
      update: { mutationOptions: () => ({ mutationFn: update }) },
    },
    machines: {
      list: { queryOptions: () => ({ queryKey: ['machines'], queryFn: async () => [] }) },
      catalogs: { queryOptions: () => ({ queryKey: ['catalogs'], queryFn: async () => [] }) },
    },
  }),
}));

const nextRunAt = new Date(Date.now() + 3 * 3_600_000).toISOString();

function row(overrides: Partial<Row>): Row {
  return {
    id: 'sch1',
    title: 'Nightly sweep',
    input: '/sweep the backlog\nand report',
    priority: 'normal',
    machine: 'laptop',
    workdir: '/work',
    everyMs: 7_200_000,
    cron: null,
    after: null,
    maxConcurrent: null,
    timezone: null,
    anchorAt: nextRunAt,
    nextRunAt,
    remaining: null,
    until: null,
    paused: false,
    ended: false,
    occurrenceTaskId: 'task1',
    createdAt: nextRunAt,
    unreadable: [],
    invalid: [],
    ...overrides,
  } as Row;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MantineProvider>
        <ModalsProvider>
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <SchedulesPage />
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  list.mockReset();
  setPaused.mockClear();
  remove.mockClear();
  update.mockClear();
});

describe('SchedulesPage', () => {
  it('shows a placeholder, not the board’s text, for a run count or an interval that is not a number', async () => {
    list.mockResolvedValue([row({ invalid: ['remaining', 'everyMs'], remaining: null, everyMs: null })]);
    renderPage();
    expect(await screen.findByText('Nightly sweep')).toBeInTheDocument();
    expect(screen.getAllByText('(invalid)')).toHaveLength(2);
    expect(screen.queryByText('forever')).not.toBeInTheDocument();
  });

  it('says so when there are no schedules', async () => {
    list.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No schedules yet.')).toBeInTheDocument();
  });

  it('shows why the list did not load instead of saying there are no schedules', async () => {
    list.mockRejectedValue(new Error('board is locked'));
    renderPage();
    expect(await screen.findByText(/Could not load schedules: .*board is locked/)).toBeInTheDocument();
    expect(screen.queryByText('No schedules yet.')).not.toBeInTheDocument();
  });

  it('does not say there are no schedules while they load', () => {
    list.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText('Loading schedules…')).toBeInTheDocument();
    expect(screen.queryByText('No schedules yet.')).not.toBeInTheDocument();
  });

  it('shows every cron expression and the limit', async () => {
    list.mockResolvedValue([
      row({
        everyMs: null,
        cron: '0 9 * * 5#1',
        moreCrons: ['0 9 * * 5#3'],
        timezone: 'Europe/Berlin',
        maxConcurrent: 2,
      }),
    ]);
    renderPage();
    const fridays = (await screen.findByText('Nightly sweep')).closest('tr')!;
    expect(within(fridays).getByText('cron 0 9 * * 5#1 | 0 9 * * 5#3 (Europe/Berlin)')).toBeInTheDocument();
    expect(within(fridays).getByText('At most 2 at once')).toBeInTheDocument();
  });

  it('names the schedule a schedule runs after, with the delay, and what it waits for', async () => {
    list.mockResolvedValue([
      row({ id: 'up1', title: 'Build' }),
      row({
        id: 'sch2',
        title: 'Deploy',
        everyMs: null,
        after: { scheduleId: 'up1', delayMs: 600_000 },
        nextRunAt: null,
        occurrenceTaskId: null,
      }),
      row({
        id: 'sch3',
        title: 'Notify',
        everyMs: null,
        after: { scheduleId: 'gone1', delayMs: 0 },
        nextRunAt: null,
        occurrenceTaskId: null,
      }),
    ]);
    renderPage();
    const deploy = (await screen.findByText('Deploy')).closest('tr')!;
    expect(within(deploy).getByText('after Build +10m')).toBeInTheDocument();
    expect(within(deploy).getByText('waits for Build')).toBeInTheDocument();
    const notify = screen.getByText('Notify').closest('tr')!;
    expect(within(notify).getByText('after gone1')).toBeInTheDocument();
    expect(within(notify).getByText('waits for gone1')).toBeInTheDocument();
  });

  it('shows the id of an upstream whose title cannot be read, and no wait for a paused schedule', async () => {
    list.mockResolvedValue([
      row({ id: 'up1', title: '(cannot decrypt)', unreadable: ['title'] }),
      row({
        id: 'sch2',
        title: 'Deploy',
        everyMs: null,
        after: { scheduleId: 'up1', delayMs: 0 },
        paused: true,
        nextRunAt: null,
        occurrenceTaskId: null,
      }),
    ]);
    renderPage();
    const deploy = (await screen.findByText('Deploy')).closest('tr')!;
    expect(within(deploy).getByText('after up1')).toBeInTheDocument();
    expect(within(deploy).queryByText(/waits for/)).not.toBeInTheDocument();
  });

  it('lists the rule, next run, runs left, machine and a link to the waiting card', async () => {
    list.mockResolvedValue([
      row({}),
      row({
        id: 'sch2',
        title: 'Mornings',
        everyMs: null,
        cron: '0 9 * * 1-5',
        timezone: 'Europe/Berlin',
        remaining: 2,
        machine: null,
        occurrenceTaskId: 'task2',
      }),
    ]);
    renderPage();
    const sweep = (await screen.findByText('Nightly sweep')).closest('tr')!;
    expect(within(sweep).getByText('every 2h')).toBeInTheDocument();
    expect(within(sweep).getByText(new RegExp(stamp(nextRunAt)))).toBeInTheDocument();
    expect(within(sweep).getByText('forever')).toBeInTheDocument();
    expect(within(sweep).getByText('laptop')).toBeInTheDocument();
    expect(within(sweep).getByText(/sweep the backlog/)).toBeInTheDocument();
    expect(within(sweep).getByRole('link', { name: 'Next card' })).toHaveAttribute('href', '/t/task1');
    const mornings = screen.getByText('Mornings').closest('tr')!;
    expect(within(mornings).getByText('cron 0 9 * * 1-5 (Europe/Berlin)')).toBeInTheDocument();
    expect(within(mornings).getByText('3')).toBeInTheDocument();
    expect(within(mornings).getByText('any')).toBeInTheDocument();
  });

  it('pause calls setPaused with the schedule, and a paused schedule offers resume', async () => {
    list.mockResolvedValue([row({}), row({ id: 'sch2', title: 'Held', paused: true, nextRunAt: null })]);
    renderPage();
    await userEvent.click(within((await screen.findByText('Nightly sweep')).closest('tr')!).getByLabelText('Pause'));
    await waitFor(() => expect(setPaused).toHaveBeenCalled());
    expect(setPaused.mock.calls[0]?.[0]).toEqual({ id: 'sch1', paused: true });
    await userEvent.click(within(screen.getByText('Held').closest('tr')!).getByLabelText('Resume'));
    await waitFor(() => expect(setPaused).toHaveBeenCalledTimes(2));
    expect(setPaused.mock.calls[1]?.[0]).toEqual({ id: 'sch2', paused: false });
  });

  it('delete asks first, then calls remove', async () => {
    list.mockResolvedValue([row({})]);
    renderPage();
    await userEvent.click(within((await screen.findByText('Nightly sweep')).closest('tr')!).getByLabelText('Delete'));
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(remove.mock.calls[0]?.[0]).toEqual({ id: 'sch1' });
  });

  it('an ended schedule is marked and offers only delete', async () => {
    list.mockResolvedValue([row({ ended: true, remaining: 0, nextRunAt: null, occurrenceTaskId: null })]);
    renderPage();
    const ended = (await screen.findByText('Nightly sweep')).closest('tr')!;
    expect(within(ended).getByText('ended')).toBeInTheDocument();
    expect(within(ended).queryByLabelText('Pause')).not.toBeInTheDocument();
    expect(within(ended).queryByLabelText('Resume')).not.toBeInTheDocument();
    expect(within(ended).queryByLabelText('Edit')).not.toBeInTheDocument();
    expect(within(ended).getByLabelText('Delete')).toBeInTheDocument();
    expect(within(ended).queryByRole('link', { name: 'Next card' })).not.toBeInTheDocument();
  });

  it('edit opens one dialog with the schedule’s values and saves all of them through update', async () => {
    list.mockResolvedValue([row({})]);
    renderPage();
    const actions = within((await screen.findByText('Nightly sweep')).closest('tr')!);
    expect(actions.queryByLabelText('Change repeat')).not.toBeInTheDocument();
    await userEvent.click(actions.getByLabelText('Edit'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Nightly sweep');
    const prompt = within(dialog).getByLabelText('Prompt');
    expect(prompt).toHaveValue('/sweep the backlog\nand report');
    expect(within(dialog).getByLabelText(/Repeat/)).toHaveValue('2h');
    await userEvent.clear(prompt);
    await userEvent.type(prompt, '/sweep everything');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('The pending card was updated too.')).toBeInTheDocument();
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      id: 'sch1',
      title: 'Nightly sweep',
      input: '/sweep everything',
      place: { machine: 'laptop', workdir: '/work' },
      repeat: { everyMs: 7_200_000 },
      runsLeft: null,
      until: null,
      maxConcurrent: null,
    });
  });

  it('edit says when the pending card had already started', async () => {
    update.mockResolvedValueOnce({ pending: 'started' as const });
    list.mockResolvedValue([row({})]);
    renderPage();
    await userEvent.click(within((await screen.findByText('Nightly sweep')).closest('tr')!).getByLabelText('Edit'));
    const prompt = await within(await screen.findByRole('dialog')).findByLabelText('Prompt');
    await userEvent.type(prompt, '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/already started; the change applies from the next run/)).toBeInTheDocument();
  });

  it('offers no edit for an ended schedule and a disabled one for a schedule that cannot be read', async () => {
    list.mockResolvedValue([
      row({ ended: true, remaining: 0, nextRunAt: null, occurrenceTaskId: null }),
      row({ id: 'sch2', title: 'Broken', unreadable: ['input'] }),
    ]);
    renderPage();
    const ended = (await screen.findByText('Nightly sweep')).closest('tr')!;
    expect(within(ended).queryByLabelText('Edit')).not.toBeInTheDocument();
    expect(within(screen.getByText('Broken').closest('tr')!).getByLabelText('Edit')).toBeDisabled();
  });
});
