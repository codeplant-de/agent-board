import { describe, expect, it } from 'vitest';
import { isStopHintDue, isStopping, stopKind, STOP_HINT_AFTER_MS } from './stopping';

const task = (overrides: Partial<Parameters<typeof stopKind>[0]>) => ({
  status: 'needs-me' as const,
  next: 'fresh' as const,
  closed: false,
  createdBy: 'user' as const,
  ...overrides,
});

describe('stopKind', () => {
  it('stops a run, a queued answer and a wait', () => {
    expect(stopKind(task({ status: 'running' }))).toBe('run');
    expect(stopKind(task({ status: 'todo', next: 'resume' }))).toBe('resume');
    expect(stopKind(task({ status: 'waiting' }))).toBe('wait');
  });

  it('offers nothing elsewhere, on a closed task or on a proposal', () => {
    expect(stopKind(task({ status: 'todo' }))).toBeNull();
    expect(stopKind(task({ status: 'backlog' }))).toBeNull();
    expect(stopKind(task({ status: 'running', closed: true }))).toBeNull();
    expect(stopKind(task({ status: 'waiting', createdBy: 'agent' }))).toBeNull();
  });
});

describe('isStopping', () => {
  it('needs a running task with a request', () => {
    expect(isStopping({ status: 'running', stopRequested: true })).toBe(true);
    expect(isStopping({ status: 'running', stopRequested: false })).toBe(false);
    expect(isStopping({ status: 'todo', stopRequested: true })).toBe(false);
  });
});

describe('isStopHintDue', () => {
  it('is due a minute after the click, never without one', () => {
    expect(isStopHintDue(1_000, 1_000 + STOP_HINT_AFTER_MS - 1)).toBe(false);
    expect(isStopHintDue(1_000, 1_000 + STOP_HINT_AFTER_MS)).toBe(true);
    expect(isStopHintDue(null, 10 ** 12)).toBe(false);
  });
});
