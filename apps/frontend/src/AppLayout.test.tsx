import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';

const signOut = vi.hoisted(() => ({ current: null as (() => Promise<void>) | null }));

vi.mock('./crypto/KeyContext', () => ({ useLock: () => undefined }));
vi.mock('./auth/useSignOut', () => ({ useSignOut: () => signOut.current }));
vi.mock('./components/NewTaskModal', () => ({ NewTaskModal: () => null }));
vi.mock('./components/useDesktopNotifications', () => ({ useDesktopNotifications: () => undefined }));

function renderLayout(path = '/') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <MantineProvider>
        <AppLayout />
      </MantineProvider>
    </MemoryRouter>,
  );
}

describe('AppLayout', () => {
  beforeEach(() => {
    signOut.current = null;
  });

  it('names every nav link and the new task button, whatever the width', () => {
    renderLayout();
    for (const name of ['Board', 'Schedules', 'Closed', 'Settings']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
    // jsdom applies Mantine's hiddenFrom rule: the phone-only link is hidden, so it has no computed name to query by.
    expect(screen.getByRole('link', { hidden: true, name: '' })).toHaveAttribute('aria-label', 'Backlog');
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument();
  });

  it('marks Settings as the current page on a settings subpage', () => {
    renderLayout('/settings/encryption');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('data-variant', 'light');
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute('data-variant', 'subtle');
  });

  it('has no sign out where the board has no sign-in', () => {
    renderLayout();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('signs out from the header', async () => {
    signOut.current = vi.fn(async () => undefined);
    renderLayout();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut.current).toHaveBeenCalledTimes(1);
  });
});
