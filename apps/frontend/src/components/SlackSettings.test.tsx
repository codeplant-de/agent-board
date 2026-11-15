import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackSettings } from './SlackSettings';

const unlink = vi.hoisted(() => vi.fn(async () => true));
const status = vi.hoisted(() => ({ current: { enabled: false, link: null } as unknown }));
const fetched = vi.hoisted(() => vi.fn());

vi.mock('../lib/trpc', () => ({
  errorMessage: String,
  useTRPC: () => ({
    slack: {
      status: {
        queryOptions: () => ({
          queryKey: ['slack.status'],
          queryFn: async () => {
            fetched();
            return status.current;
          },
        }),
        queryFilter: () => ({ queryKey: ['slack.status'] }),
      },
      unlink: { mutationOptions: () => ({ mutationFn: unlink }) },
    },
  }),
}));

function renderSettings() {
  return render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SlackSettings />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

beforeEach(() => {
  unlink.mockClear();
  fetched.mockClear();
});

describe('SlackSettings', () => {
  it('shows nothing while Slack is off', async () => {
    status.current = { enabled: false, link: null };
    renderSettings();
    await waitFor(() => expect(fetched).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Slack')).not.toBeInTheDocument());
  });

  it('explains how to link when nothing is linked', async () => {
    status.current = { enabled: true, link: null };
    renderSettings();
    expect(await screen.findByText('/board link')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument();
  });

  it('shows the linked account and unlinks it', async () => {
    status.current = {
      enabled: true,
      link: { slackUserId: 'U1', displayName: 'Ada', createdAt: new Date().toISOString() },
    };
    renderSettings();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(unlink).toHaveBeenCalled());
  });

  it('falls back to the Slack user id without a name', async () => {
    status.current = {
      enabled: true,
      link: { slackUserId: 'U1', displayName: null, createdAt: new Date().toISOString() },
    };
    renderSettings();
    expect(await screen.findByText('U1')).toBeInTheDocument();
  });
});
