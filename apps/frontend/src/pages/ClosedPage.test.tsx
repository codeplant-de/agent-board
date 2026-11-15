import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClosedPage } from './ClosedPage';

const list = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));

vi.mock('../lib/trpc', () => ({
  errorMessage: (error: Error) => error.message,
  useTRPC: () => ({ tasks: { list: { queryOptions: () => ({ queryKey: ['tasks.list', 'closed'], queryFn: list }) } } }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ClosedPage />
        </QueryClientProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  list.mockReset();
});

describe('ClosedPage', () => {
  it('says so when nothing is closed', async () => {
    list.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Nothing closed.')).toBeInTheDocument();
  });

  it('shows why the list did not load instead of saying nothing is closed', async () => {
    list.mockRejectedValue(new Error('board is locked'));
    renderPage();
    expect(await screen.findByText('Could not load closed tasks: board is locked')).toBeInTheDocument();
    expect(screen.queryByText('Nothing closed.')).not.toBeInTheDocument();
  });

  it('does not say nothing is closed while the list loads', () => {
    list.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText('Loading closed tasks…')).toBeInTheDocument();
    expect(screen.queryByText('Nothing closed.')).not.toBeInTheDocument();
  });
});
