import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { stamp } from '../lib/time';
import type { BoardTask } from '../lib/trpc';
import { TaskBadges } from './TaskBadges';

const task = (overrides: Partial<BoardTask>) =>
  ({
    id: 'a',
    status: 'todo',
    priority: 'normal',
    labels: [],
    next: 'fresh',
    paused: false,
    openQuestion: false,
    proposed: false,
    borrowed: false,
    machine: null,
    lane: null,
    notBefore: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    ...overrides,
  }) as BoardTask;

const renderBadges = (overrides: Partial<BoardTask>) =>
  render(
    <MantineProvider>
      <TaskBadges task={task(overrides)} />
    </MantineProvider>,
  );

describe('TaskBadges', () => {
  it('shows Stopping… on a running task with a stop request, and not otherwise', () => {
    const { unmount } = renderBadges({ status: 'running', stopRequested: true });
    expect(screen.getByText('Stopping…')).toBeInTheDocument();
    unmount();
    renderBadges({ status: 'running', stopRequested: false });
    expect(screen.queryByText('Stopping…')).not.toBeInTheDocument();
  });

  it('shows Paused on a task waiting in Todo', () => {
    renderBadges({ paused: true });
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('does not show Paused on a running task: the flag stays true through the claim', () => {
    renderBadges({ status: 'running', paused: true, machine: 'laptop' });
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
  });

  it('shows when a waiting task starts, with the exact time as its title', () => {
    const notBefore = new Date(Date.now() + 4 * 3_600_000 + 30_000).toISOString();
    renderBadges({ notBefore });
    const badge = screen.getByText('Starts in 4h');
    expect(badge.closest('[title]')).toHaveAttribute('title', stamp(notBefore));
  });

  it('shows when a timer wakes a waiting task, and how long a check may take', () => {
    const wakeAt = new Date(Date.now() + 20 * 60_000 + 30_000).toISOString();
    const { unmount } = renderBadges({ status: 'waiting', wakeAt });
    expect(screen.getByText('Wakes in 20m').closest('[title]')).toHaveAttribute('title', `Wakes ${stamp(wakeAt)}`);
    unmount();
    renderBadges({ status: 'waiting', wakeAt, waitCheck: true, machine: 'laptop' });
    expect(screen.getByText('Checking · up to 20m').closest('[title]')).toHaveAttribute(
      'title',
      `Wakes when its check on laptop passes, at the latest ${stamp(wakeAt)}`,
    );
  });

  it('shows Woken, not Resume, on a task whose wait ended into Todo', () => {
    renderBadges({ next: 'resume', woken: true });
    expect(screen.getByText('Woken')).toBeInTheDocument();
    expect(screen.queryByText('Resume')).not.toBeInTheDocument();
  });

  it('marks a task made by a schedule as a repeat', () => {
    renderBadges({ scheduleId: 'sch1' });
    expect(screen.getByText('Repeat')).toBeInTheDocument();
  });

  it('shows no repeat badge on an ordinary task', () => {
    renderBadges({});
    expect(screen.queryByText('Repeat')).not.toBeInTheDocument();
  });

  it('shows no start time once it is due, or off Todo', () => {
    renderBadges({ notBefore: new Date(Date.now() - 1000).toISOString() });
    expect(screen.queryByText(/Starts in/)).not.toBeInTheDocument();
    renderBadges({ status: 'backlog', notBefore: new Date(Date.now() + 3_600_000).toISOString() });
    expect(screen.queryByText(/Starts in/)).not.toBeInTheDocument();
  });
});
