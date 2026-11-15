import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptDrawer } from './TranscriptDrawer';

// Small pages, so a few events already take more than one.
vi.mock('@agent-board/shared', async (original) => ({
  ...(await original<typeof import('@agent-board/shared')>()),
  TRANSCRIPT_PAGE_SIZE: 2,
}));

const board = vi.hoisted(() => ({ events: [] as { seq: number; text: string }[] }));
const fetchRuns = vi.hoisted(() => vi.fn());
const fetchPage = vi.hoisted(() =>
  vi.fn<(input: { taskId: string; runId: string; afterSeq: number }, signal?: AbortSignal) => Promise<unknown[]>>(),
);

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    transcript: {
      runs: { queryOptions: ({ id }: { id: string }) => ({ queryKey: ['transcript.runs', id], queryFn: fetchRuns }) },
      events: {
        queryKey: ({ runId }: { runId: string }) => ['transcript.events', runId],
        fetchPage,
      },
      output: { queryOptions: () => ({ queryKey: ['transcript.output'], queryFn: async () => '' }) },
    },
  }),
}));

const NOW = new Date().toISOString();
const run = { id: 'run1', startedAt: NOW, resumed: false, machine: 'm1', lastEventAt: NOW, eventCount: 4 };

beforeEach(() => {
  board.events = [
    { seq: 0, text: 'first' },
    { seq: 1, text: 'second' },
    { seq: 2, text: 'third' },
  ];
  fetchRuns.mockReset().mockResolvedValue([run]);
  fetchPage.mockReset().mockImplementation(async ({ afterSeq }: { afterSeq: number }) =>
    board.events
      .filter((event) => event.seq > afterSeq)
      .slice(0, 2)
      .map(({ seq, text }) => ({ seq, at: NOW, kind: 'note', text, parent: null })),
  );
});

function renderDrawer(props: { opened: boolean; live: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (p: typeof props) => (
    <MantineProvider>
      <QueryClientProvider client={client}>
        <TranscriptDrawer taskId="task1" onClose={() => {}} {...p} />
      </QueryClientProvider>
    </MantineProvider>
  );
  const view = render(ui(props));
  return { rerender: (next: typeof props) => view.rerender(ui(next)) };
}

const afterSeqs = () => fetchPage.mock.calls.map(([input]) => input.afterSeq);

describe('TranscriptDrawer', () => {
  it('loads a run page by page, and after the run ends fetches only what follows', async () => {
    const drawer = renderDrawer({ opened: true, live: true });
    expect(await screen.findByText('third')).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
    // A full page asks for the next one; a short one ends the load.
    expect(afterSeqs()).toEqual([-1, 1]);

    board.events.push({ seq: 3, text: 'fourth' });
    drawer.rerender({ opened: true, live: false });
    expect(await screen.findByText('fourth')).toBeInTheDocument();
    expect(afterSeqs()).toEqual([-1, 1, 2]);
    expect(fetchPage).toHaveBeenCalledWith({ taskId: 'task1', runId: 'run1', afterSeq: 2 }, expect.anything());
  });

  it('fetches nothing while closed, also when the run ends', async () => {
    const drawer = renderDrawer({ opened: false, live: true });
    drawer.rerender({ opened: false, live: false });
    // Let any refetch the end of the run would start reach the mocks.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchRuns).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();

    drawer.rerender({ opened: true, live: false });
    expect(await screen.findByText('third')).toBeInTheDocument();
    expect(fetchRuns).toHaveBeenCalledTimes(1);
  });
});
