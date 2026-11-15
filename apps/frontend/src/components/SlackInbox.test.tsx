import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackInbox } from './SlackInbox';

const remove = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const create = vi.hoisted(() => vi.fn(async (_: unknown) => ({ id: 'new1' })));
const inbox = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock('../lib/trpc', () => ({
  POLL_MS: 60_000,
  errorMessage: String,
  useTRPC: () => ({
    slack: {
      inbox: {
        list: {
          queryOptions: () => ({ queryKey: ['inbox'], queryFn: async () => inbox.items }),
          queryFilter: () => ({ queryKey: ['inbox'] }),
        },
        remove: { mutationOptions: () => ({ mutationFn: remove }) },
      },
    },
    tasks: { create: { mutationOptions: () => ({ mutationFn: create }) } },
  }),
}));

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Prompt" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}));

const item = { id: 'i1', text: 'Fix the flaky test\nit fails on CI only', createdAt: new Date().toISOString() };

function renderInbox() {
  return render(
    <MemoryRouter>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <SlackInbox />
        </QueryClientProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  remove.mockClear();
  create.mockClear();
  inbox.items = [];
});

describe('SlackInbox', () => {
  it('shows nothing without items', async () => {
    renderInbox();
    await waitFor(() => expect(screen.queryByText('From Slack')).not.toBeInTheDocument());
  });

  it('marks the items as unencrypted text from Slack', async () => {
    inbox.items = [item];
    renderInbox();
    expect(await screen.findByText('From Slack')).toBeInTheDocument();
    expect(screen.getByText('unencrypted text')).toBeInTheDocument();
    expect(screen.getByText(/Fix the flaky test/)).toBeInTheDocument();
  });

  it('shows text as text, not as markup', async () => {
    inbox.items = [{ ...item, text: '<img src=x onerror=alert(1)>' }];
    const { container } = renderInbox();
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('dismisses an item', async () => {
    inbox.items = [item];
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(remove.mock.calls[0]?.[0]).toEqual({ id: 'i1' }));
  });

  it('opens the new-task modal with the text as the prompt and its first line as the title, and deletes the item once the task exists', async () => {
    inbox.items = [item];
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: 'Create task' }));
    expect(await screen.findByLabelText('Prompt')).toHaveValue(item.text);
    expect(screen.getByLabelText('Title')).toHaveValue('Fix the flaky test');
    expect(remove).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0]).toMatchObject({ title: 'Fix the flaky test', input: item.text });
    await waitFor(() => expect(remove.mock.calls[0]?.[0]).toEqual({ id: 'i1' }));
  });

  it('keeps the item when closing the modal without creating', async () => {
    inbox.items = [item];
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: 'Create task' }));
    await userEvent.keyboard('{Escape}');
    expect(remove).not.toHaveBeenCalled();
  });
});
