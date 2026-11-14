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
    ...overrides,
  }) as BoardTask;

const renderBadges = (overrides: Partial<BoardTask>) =>
  render(
    <MantineProvider>
      <TaskBadges task={task(overrides)} />
    </MantineProvider>,
  );

describe('TaskBadges', () => {
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
