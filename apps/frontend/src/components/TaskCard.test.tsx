import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PrState } from '@agent-board/shared';
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
