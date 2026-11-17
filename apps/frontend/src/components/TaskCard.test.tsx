import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PrState, TaskWatch } from '@agent-board/shared';
import type { ListedTask } from '../lib/trpc';
import { TaskCard } from './TaskCard';

const task = (overrides: Partial<ListedTask>): ListedTask =>
  ({
    id: 't1',
    title: 'A task',
    input: 'Fix the bug',
    prs: [],
    promptPrState: null,
    status: 'needs-me',
    priority: 'normal',
    createdBy: 'user',
    closed: false,
    openQuestion: false,
    machine: null,
    lane: null,
    sessionId: null,
    next: 'fresh',
    head: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    parentId: null,
    proposed: false,
    paused: false,
    notBefore: null,
    lastActiveAt: null,
    runStartedAt: null,
    borrowed: false,
    unreadable: [],
    invalid: [],
    labels: [],
    lastNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }) as ListedTask;

const renderCard = (overrides: Partial<ListedTask>) =>
  render(
    <MemoryRouter>
      <MantineProvider>
        <TaskCard
          task={task(overrides)}
          draggable={false}
          dragging={false}
          onDragStart={() => {}}
          onDragEnd={() => {}}
          onDragOver={() => {}}
        />
      </MantineProvider>
    </MemoryRouter>,
  );

const hasPrIcon = (container: HTMLElement) => container.querySelector('.tabler-icon-brand-github') !== null;

const pr = (n: number, state: PrState | null = null) => ({
  id: `r${n}`,
  url: `https://github.com/acme/app/pull/${n}`,
  state,
});

describe('TaskCard pull request icon', () => {
  it('shows for a review task whose prompt names a PR', () => {
    expect(hasPrIcon(renderCard({ input: '/review-pr https://github.com/acme/app/pull/1 --auto' }).container)).toBe(
      true,
    );
  });

  it('shows for a task whose agent reported a PR', () => {
    expect(hasPrIcon(renderCard({ prs: [pr(2)] }).container)).toBe(true);
  });

  it('is not there for a task without a PR', () => {
    expect(hasPrIcon(renderCard({}).container)).toBe(false);
  });
});

describe('TaskCard pull request state', () => {
  it('shows the merge icon for a merged PR instead of the GitHub mark', () => {
    const { container } = renderCard({ prs: [pr(2, 'merged')] });
    expect(screen.getByLabelText('PR merged')).toBeInTheDocument();
    expect(hasPrIcon(container)).toBe(false);
  });

  it('shows the closed icon for a PR closed without a merge', () => {
    const { container } = renderCard({
      input: '/review-pr https://github.com/acme/app/pull/2 --auto',
      promptPrState: 'closed',
    });
    expect(screen.getByLabelText('PR closed')).toBeInTheDocument();
    expect(hasPrIcon(container)).toBe(false);
  });

  it.each(['open', null] as const)('keeps the GitHub mark for a PR that is %s', (state) => {
    const { container } = renderCard({ prs: [pr(2, state)] });
    expect(hasPrIcon(container)).toBe(true);
    expect(screen.queryByLabelText(/^PR (merged|closed)$/)).not.toBeInTheDocument();
  });

  it('shows nothing for a state without a PR', () => {
    renderCard({ promptPrState: 'merged' });
    expect(screen.queryByLabelText('PR merged')).not.toBeInTheDocument();
  });

  it('shows one icon per PR with its own state', () => {
    renderCard({ prs: [pr(1, 'merged'), pr(2, 'closed'), pr(3)] });
    expect(screen.getAllByLabelText(/^PR (merged|closed)$/)).toHaveLength(2);
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  it('shows at most three icons and counts the rest', () => {
    renderCard({ prs: [pr(1, 'merged'), pr(2, 'merged'), pr(3, 'merged'), pr(4, 'merged'), pr(5, 'merged')] });
    expect(screen.getAllByLabelText('PR merged')).toHaveLength(3);
    expect(screen.getByText('+2')).toBeInTheDocument();
  });
});

const watch = (overrides: Partial<TaskWatch> = {}): TaskWatch => ({
  id: '0123456789abcdef',
  name: 'ci',
  kind: 'ci',
  label: 'CI #116',
  status: '4 of 7 passed, 3 running',
  deadline: new Date(Date.now() + 3_600_000).toISOString(),
  pendingEvents: 0,
  ...overrides,
});

describe('TaskCard watches', () => {
  it('shows the first watch with its short status on a running task, and counts the rest', () => {
    renderCard({
      status: 'running',
      watches: [watch(), watch({ id: 'fedcba9876543210', name: 'cmd', kind: 'command', label: 'command, every 30s' })],
    });
    expect(screen.getByText('Watching CI #116 · 4/7 +1')).toBeInTheDocument();
  });

  it('replaces the checking countdown of a waiting task and keeps it in the tooltip', () => {
    const wakeAt = new Date(Date.now() + 20 * 60_000 + 30_000).toISOString();
    renderCard({ status: 'waiting', wakeAt, waitCheck: true, machine: 'laptop', watches: [watch()] });
    const badge = screen.getByText('Watching CI #116 · 4/7');
    expect(badge.closest('[title]')?.getAttribute('title')).toContain('Checking · up to 20m');
    expect(screen.queryByText(/^Checking/)).not.toBeInTheDocument();
  });

  it('shows the label alone when the status has no count', () => {
    renderCard({ status: 'running', watches: [watch({ kind: 'timer', label: 'timer', status: 'fires at 14:20' })] });
    expect(screen.getByText('Watching timer')).toBeInTheDocument();
  });

  it('keeps the existing badge when the watches are unreadable, and shows nothing off Running and Waiting', () => {
    const wakeAt = new Date(Date.now() + 20 * 60_000 + 30_000).toISOString();
    const { unmount } = renderCard({ status: 'waiting', wakeAt, waitCheck: true, watches: null });
    expect(screen.getByText('Checking · up to 20m')).toBeInTheDocument();
    unmount();
    renderCard({ status: 'needs-me', watches: [watch()] });
    expect(screen.queryByText(/^Watching/)).not.toBeInTheDocument();
  });

  it('shows watch text as plain text', () => {
    renderCard({ status: 'running', watches: [watch({ label: '<b>bold</b> **x**' })] });
    expect(screen.getByText('Watching <b>bold</b> **x** · 4/7')).toBeInTheDocument();
  });
});
