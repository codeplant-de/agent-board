import { serializePolish } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask, ThreadNote } from '../lib/trpc';
import { PolishItem } from './PolishItem';

const apply = vi.hoisted(() => vi.fn(async (_: unknown) => null));

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({ tasks: { applyPolish: { mutationOptions: () => ({ mutationFn: apply }) } } }),
}));

const task = (overrides: Partial<BoardTask>): BoardTask =>
  ({
    id: 'polish01',
    title: 'Polish prompt: rough idea',
    input: 'Polish it',
    status: 'needs-me',
    priority: 'normal',
    createdBy: 'user',
    agent: null,
    closed: false,
    scheduleId: null,
    parentId: 'target01',
    unreadable: [],
    invalid: [],
    ...overrides,
  }) as BoardTask;

const target = task({
  id: 'target01',
  title: 'rough idea',
  input: 'fix thing?? maybe export',
  status: 'backlog',
  parentId: null,
});

const rewrite = { target: 'target01', title: 'Speed up the export', prompt: 'Find out why the **export** is slow.' };

const note = (overrides: Partial<ThreadNote> = {}): ThreadNote => ({
  id: 'n1',
  text: serializePolish(rewrite),
  createdAt: new Date().toISOString(),
  author: 'agent',
  kind: 'polish',
  by: 'laptop',
  unreadable: false,
  ...overrides,
});

function renderItem(parent: BoardTask | null, thread: ThreadNote = note()) {
  return render(
    <MantineProvider>
      <ModalsProvider>
        <QueryClientProvider client={new QueryClient()}>
          <PolishItem note={thread} task={task({})} parent={parent} />
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
}

beforeEach(() => apply.mockClear());

describe('PolishItem', () => {
  it('shows the polished title and prompt as plain text, not as markdown', () => {
    renderItem(target);
    expect(screen.getByText('Polished prompt')).toBeInTheDocument();
    expect(screen.getByText('Speed up the export')).toBeInTheDocument();
    expect(screen.getByText(rewrite.prompt).tagName).toBe('PRE');
    expect(screen.queryByRole('strong')).not.toBeInTheDocument();
  });

  it('shows the whole new title and prompt and applies nothing until the user confirms', async () => {
    renderItem(target);
    await userEvent.click(screen.getByRole('button', { name: 'Apply to rough idea' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('polish-title').textContent).toBe(rewrite.title);
    expect(within(dialog).getByTestId('polish-prompt').textContent).toBe(rewrite.prompt);
    expect(apply).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(apply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Apply to rough idea' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Apply as mine' }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]?.[0]).toEqual({
      polishId: 'polish01',
      target,
      rewrite: { target: 'target01', title: rewrite.title, prompt: rewrite.prompt },
    });
  });

  it('works on a task in Needs me too', () => {
    renderItem({ ...target, status: 'needs-me' });
    expect(screen.getByRole('button', { name: 'Apply to rough idea' })).toBeInTheDocument();
  });

  it.each([
    ['a parent that is already in Todo', { ...target, status: 'todo' }, /no longer in Backlog or Needs me/],
    ['a closed parent', { ...target, closed: true }, /no longer in Backlog or Needs me/],
    ['a parent an agent created', { ...target, createdBy: 'agent' }, /not a task you wrote/],
    ['an occurrence of a schedule', { ...target, scheduleId: 's1' }, /not a task you wrote/],
    ['a parent that cannot be read', { ...target, unreadable: ['input'] }, /cannot be read/],
    ['no parent', null, /no parent/],
  ] as const)('says why it cannot be applied to %s, and offers no button', (_name, parent, reason) => {
    renderItem(parent as BoardTask | null);
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply to/ })).not.toBeInTheDocument();
  });

  it('refuses a polished prompt that is for another task than this one’s parent', () => {
    renderItem(target, note({ text: serializePolish({ ...rewrite, target: 'other999' }) }));
    expect(screen.getByText(/for task other999, not for this task’s parent/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply to/ })).not.toBeInTheDocument();
  });

  it.each([
    ['text that is not a polished prompt', note({ text: 'just words' })],
    ['one that the user wrote', note({ author: 'user' })],
  ])('refuses %s', (_name, thread) => {
    renderItem(target, thread);
    expect(screen.getByText(/not a polished prompt this browser understands/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply to/ })).not.toBeInTheDocument();
  });
});
