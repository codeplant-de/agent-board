import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ListedTask } from '../lib/trpc';
import { TaskCard } from './TaskCard';

const task = (overrides: Partial<ListedTask>): ListedTask =>
  ({
    id: 't1',
    title: 'A task',
    input: 'Fix the bug',
    pr: null,
    prState: null,
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

describe('TaskCard pull request icon', () => {
  it('shows for a review task whose prompt names a PR', () => {
    expect(hasPrIcon(renderCard({ input: '/review-pr https://github.com/acme/app/pull/1 --auto' }).container)).toBe(
      true,
    );
  });

  it('shows for a task whose agent reported a PR', () => {
    expect(hasPrIcon(renderCard({ pr: 'https://github.com/acme/app/pull/2' }).container)).toBe(true);
  });

  it('is not there for a task without a PR', () => {
    expect(hasPrIcon(renderCard({}).container)).toBe(false);
  });
});

describe('TaskCard pull request state', () => {
  const pr = 'https://github.com/acme/app/pull/2';

  it('shows the merge icon for a merged PR instead of the GitHub mark', () => {
    const { container } = renderCard({ pr, prState: 'merged' });
    expect(screen.getByLabelText('PR merged')).toBeInTheDocument();
    expect(hasPrIcon(container)).toBe(false);
  });

  it('shows the closed icon for a PR closed without a merge', () => {
    const { container } = renderCard({ input: `/review-pr ${pr} --auto`, prState: 'closed' });
    expect(screen.getByLabelText('PR closed')).toBeInTheDocument();
    expect(hasPrIcon(container)).toBe(false);
  });

  it.each(['open', null] as const)('keeps the GitHub mark for a PR that is %s', (prState) => {
    const { container } = renderCard({ pr, prState });
    expect(hasPrIcon(container)).toBe(true);
    expect(screen.queryByLabelText(/^PR (merged|closed)$/)).not.toBeInTheDocument();
  });

  it('shows nothing for a state without a PR', () => {
    renderCard({ prState: 'merged' });
    expect(screen.queryByLabelText('PR merged')).not.toBeInTheDocument();
  });
});
