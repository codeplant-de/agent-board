import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';

const fetchMe = vi.hoisted(() => vi.fn<() => Promise<{ username: string; keyId: string | null }>>());

vi.mock('./lib/trpc', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  POLL_MS: 5_000,
  useTRPC: () => ({ me: { queryOptions: () => ({ queryKey: ['me'], queryFn: fetchMe }) } }),
}));

// Stands in for the unlocked app: state that lives below the gate, like a reply being typed.
vi.mock('./crypto/KeyGate', () => ({
  KeyGate: ({ me }: { me: { username: string } }) => <textarea aria-label={`draft of ${me.username}`} />,
}));

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return queryClient;
}

describe('App', () => {
  it('keeps the app and its state when a background refetch of me fails', async () => {
    fetchMe.mockResolvedValueOnce({ username: 'jascha', keyId: 'k1' });
    const queryClient = renderApp();
    await userEvent.type(await screen.findByLabelText('draft of jascha'), 'half a reply');

    fetchMe.mockRejectedValueOnce(new Error('502 Bad Gateway'));
    await queryClient.refetchQueries({ queryKey: ['me'] });

    expect(await screen.findByText('Board unreachable, retrying')).toBeInTheDocument();
    expect(screen.getByLabelText('draft of jascha')).toHaveValue('half a reply');
    expect(screen.queryByText(/No access/)).not.toBeInTheDocument();

    fetchMe.mockResolvedValueOnce({ username: 'jascha', keyId: 'k1' });
    await queryClient.refetchQueries({ queryKey: ['me'] });
    await waitFor(() => expect(screen.queryByText('Board unreachable, retrying')).not.toBeInTheDocument());
    expect(screen.getByLabelText('draft of jascha')).toHaveValue('half a reply');
  });

  it('stops at no access when the first answer is an error', async () => {
    fetchMe.mockRejectedValueOnce(new Error('not allowed on this board'));
    renderApp();
    expect(await screen.findByText('No access: not allowed on this board')).toBeInTheDocument();
    expect(screen.queryByLabelText(/draft of/)).not.toBeInTheDocument();
  });
});
