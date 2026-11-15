import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
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
