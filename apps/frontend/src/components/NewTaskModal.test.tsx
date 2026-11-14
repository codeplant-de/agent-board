import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewTaskModal } from './NewTaskModal';

const create = vi.hoisted(() => vi.fn(async (_: unknown) => ({ id: 'new1' })));

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({ tasks: { create: { mutationOptions: () => ({ mutationFn: create }) } } }),
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
        <QueryClientProvider client={new QueryClient()}>
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

beforeEach(() => create.mockClear());

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
