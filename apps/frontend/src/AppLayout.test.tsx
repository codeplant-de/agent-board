import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';

vi.mock('./crypto/KeyContext', () => ({ useLock: () => undefined }));
vi.mock('./components/NewTaskModal', () => ({ NewTaskModal: () => null }));
vi.mock('./components/useDesktopNotifications', () => ({ useDesktopNotifications: () => undefined }));

describe('AppLayout', () => {
  it('names every nav link and the new task button, whatever the width', () => {
    render(
      <MemoryRouter>
        <MantineProvider>
          <AppLayout />
        </MantineProvider>
      </MemoryRouter>,
    );
    for (const name of ['Board', 'Schedules', 'Closed', 'Settings']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument();
  });
});
