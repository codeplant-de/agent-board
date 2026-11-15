import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackLinkPage } from './SlackLinkPage';

const confirmLink = vi.hoisted(() => vi.fn(async (_: unknown) => ({ slackUserId: 'U1' })));
const peek = vi.hoisted(() => ({
  current: (async () => ({ slackUserId: 'U1', displayName: 'Ada' })) as () => Promise<unknown>,
}));

vi.mock('../lib/trpc', () => ({
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  useTRPC: () => ({
    slack: {
      peekLink: { queryOptions: (input: unknown) => ({ queryKey: ['peek', input], queryFn: () => peek.current() }) },
      confirmLink: { mutationOptions: () => ({ mutationFn: confirmLink }) },
      status: { queryFilter: () => ({ queryKey: ['slack.status'] }) },
    },
  }),
}));

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <MantineProvider>
        <Notifications />
        <QueryClientProvider client={new QueryClient()}>
          <Routes>
            <Route path="/slack/link" element={<SlackLinkPage />} />
            <Route path="/settings" element={<p>settings page</p>} />
            <Route path="/" element={<p>board page</p>} />
          </Routes>
        </QueryClientProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  confirmLink.mockClear();
  peek.current = async () => ({ slackUserId: 'U1', displayName: 'Ada' });
});

describe('SlackLinkPage', () => {
  it('asks to link the Slack user, and links with the code from the URL', async () => {
    renderAt('/slack/link?code=abc123');
    expect(await screen.findByText('Link Slack user Ada to your board account?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(confirmLink.mock.calls[0]?.[0]).toEqual({ code: 'abc123' }));
    expect(await screen.findByText('settings page')).toBeInTheDocument();
  });

  it('names the Slack user by id when Slack gave no name', async () => {
    peek.current = async () => ({ slackUserId: 'U42', displayName: null });
    renderAt('/slack/link?code=abc123');
    expect(await screen.findByText('Link Slack user U42 to your board account?')).toBeInTheDocument();
  });

  it('says so when the code is missing', async () => {
    renderAt('/slack/link');
    expect(await screen.findByText(/needs the link/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link' })).not.toBeInTheDocument();
  });

  it('shows the reason when the code expired and offers no button', async () => {
    peek.current = async () => {
      throw new Error('This link has expired or was already used.');
    };
    renderAt('/slack/link?code=old');
    expect(await screen.findByText(/has expired/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link' })).not.toBeInTheDocument();
  });

  it('goes back to the board on cancel without linking', async () => {
    renderAt('/slack/link?code=abc123');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('board page')).toBeInTheDocument();
    expect(confirmLink).not.toHaveBeenCalled();
  });
});
