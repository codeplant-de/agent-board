import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});
