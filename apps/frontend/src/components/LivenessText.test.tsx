import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LivenessText } from './LivenessText';

describe('LivenessText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T12:00:10Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('counts up every second', () => {
    render(
      <MantineProvider>
        <LivenessText lastActiveAt="2026-11-13T12:00:00Z" />
      </MantineProvider>,
    );
    expect(screen.getByText('active 10s ago')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('active 13s ago')).toBeInTheDocument();
  });
});
