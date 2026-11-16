import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../lib/opening';
import { NewTaskModal } from './NewTaskModal';

const create = vi.hoisted(() => vi.fn(async (_: unknown) => ({ id: 'new1' })));

const listed = vi.hoisted(() => ({ machines: [] as unknown[], failure: null as Error | null }));

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    tasks: { create: { mutationOptions: () => ({ mutationFn: create }) } },
    machines: {
      list: {
        queryOptions: () => ({
          queryKey: ['machines.list'],
          queryFn: async () => {
            if (listed.failure) throw listed.failure;
            return listed.machines;
          },
        }),
      },
    },
  }),
  errorMessage: (error: unknown) => String(error),
}));

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Prompt" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}));

const FUTURE = '2099-01-01T10:00';

async function open(when?: string) {
  render(
    <MemoryRouter>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <NewTaskModal opened onClose={() => undefined} />
        </QueryClientProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
  await userEvent.type(screen.getByLabelText('Prompt'), '/sweep');
  if (when !== undefined) {
    await userEvent.click(screen.getByRole('combobox', { name: 'When' }));
    await userEvent.click(await screen.findByRole('option', { name: when, hidden: true }));
  }
}

const createButton = () => screen.getByRole('button', { name: 'Create' });
const sent = () => create.mock.calls[0]?.[0];

beforeEach(() => {
  create.mockClear();
  listed.machines = [];
  listed.failure = null;
});

describe('NewTaskModal When', () => {
  it.each([
    ['Now', 'now'],
    ['Backlog', 'backlog'],
    ['Needs me', 'hold'],
  ])('sends %s as the plain keyword', async (label, when) => {
    await open(label);
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ input: '/sweep', when });
  });

  it('sends Later with the chosen start time', async () => {
    await open('Later');
    expect(createButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: FUTURE } });
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ when: { at: new Date(FUTURE) } });
  });

  it('refuses a Later start time in the past', async () => {
    await open('Later');
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '2020-01-01T10:00' } });
    expect(await screen.findByText('Pick a time in the future')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
  });

  it('sends a repeating interval with its first run and number of runs', async () => {
    await open('Repeating');
    expect(createButton()).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    fireEvent.change(screen.getByLabelText('First run'), { target: { value: FUTURE } });
    await userEvent.type(screen.getByLabelText('Number of runs'), '3');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ when: { every: 2 * 3_600_000, at: new Date(FUTURE), times: 3 } });
  });

  it('sends a repeating cron rule in the local time zone, starting now by default', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '0 9 * * 1-5');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    const { when } = sent() as { when: Record<string, unknown> };
    expect(when).toEqual({ cron: '0 9 * * 1-5', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  it('refuses a past first run and a number of runs below 1', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    fireEvent.change(screen.getByLabelText('First run'), { target: { value: '2020-01-01T10:00' } });
    expect(await screen.findByText('Pick a time in the future')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('First run'), { target: { value: '' } });
    await userEvent.type(screen.getByLabelText('Number of runs'), '0');
    expect(await screen.findByText('A whole number, 1 or more')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('NewTaskModal model', () => {
  it('sends no model by default', async () => {
    await open();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('model');
  });

  it('sends the chosen alias', async () => {
    await open();
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Opus', hidden: true }));
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ model: 'opus', when: 'now' });
  });
});

const HOUR = 3_600_000;
const machine = (name: string, dirs: string[] | null, extra: Partial<Machine> = {}): Machine =>
  ({
    name,
    shown: name,
    dirs,
    dirsUnreadable: false,
    revokedAt: null,
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    ...extra,
  }) as Machine;

const directory = () => screen.getByRole('combobox', { name: 'Working directory' });
const pick = async (path: string, group?: string) => {
  await userEvent.click(directory());
  const options = await screen.findAllByRole('option', { name: path, hidden: true });
  const target =
    group === undefined
      ? options[0]
      : options.find((option) => option.closest('[data-combobox-option]')?.parentElement?.textContent?.includes(group));
  await userEvent.click(target ?? options[0]!);
};

describe('NewTaskModal working directory', () => {
  it('is disabled with a hint when no machine has listed a directory', async () => {
    listed.machines = [machine('laptop', null), machine('desktop', [])];
    await open();
    await waitFor(() => expect(directory()).toBeDisabled());
    expect(screen.getByText(/No machine has listed a directory yet/)).toBeInTheDocument();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('place');
  });

  it('shows the error of a failed load without blocking the form', async () => {
    listed.failure = new Error('machines are down');
    await open();
    expect(await screen.findByText(/machines are down/)).toBeInTheDocument();
    expect(directory()).toBeDisabled();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
  });

  it('sends the machine and directory that was picked', async () => {
    listed.machines = [machine('laptop', ['/work/a', '/work/b'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await pick('/work/b');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ place: { machine: 'laptop', workdir: '/work/b' } });
  });

  it('sends no place when the field stays empty', async () => {
    listed.machines = [machine('laptop', ['/work/a'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent()).not.toHaveProperty('place');
  });

  it('keeps the same path on two machines apart and sends the machine picked', async () => {
    listed.machines = [machine('laptop', ['/work/app']), machine('desktop', ['/work/app'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(directory());
    expect(await screen.findAllByRole('option', { name: '/work/app', hidden: true })).toHaveLength(2);
    await pick('/work/app', 'desktop');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ place: { machine: 'desktop', workdir: '/work/app' } });
  });

  it('orders groups by last seen and labels a machine not seen for a day', async () => {
    listed.machines = [
      machine('old', ['/o'], { lastSeenAt: new Date(Date.now() - 49 * HOUR).toISOString() }),
      machine('never', ['/n'], { lastSeenAt: null }),
      machine('fresh', ['/f']),
    ];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(directory());
    const labels = (await screen.findAllByText(/^(fresh|old|never)/, { selector: '.mantine-Select-groupLabel' })).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(['fresh', 'old · last seen 2 days ago', 'never · never seen']);
  });

  it('hides revoked machines', async () => {
    listed.machines = [
      machine('gone', ['/g'], { revokedAt: new Date().toISOString(), dirs: null }),
      machine('laptop', ['/l']),
    ];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(directory());
    expect(await screen.findByRole('option', { name: '/l', hidden: true })).toBeInTheDocument();
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
  });

  it('says which machine has a list it could not read', async () => {
    listed.machines = [machine('laptop', ['/l']), machine('desktop', null, { dirsUnreadable: true })];
    await open();
    expect(await screen.findByText('The directory list of desktop could not be read.')).toBeInTheDocument();
    expect(directory()).toBeEnabled();
  });

  it('stays enabled and sends the place for a repeating schedule', async () => {
    listed.machines = [machine('laptop', ['/work/a'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await pick('/work/a');
    await userEvent.click(screen.getByRole('combobox', { name: 'When' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Repeating', hidden: true }));
    expect(directory()).toBeEnabled();
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ when: { every: 7_200_000 }, place: { machine: 'laptop', workdir: '/work/a' } });
  });
});
