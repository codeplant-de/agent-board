import { mkdtempSync, rmSync } from 'node:fs';
import { after } from 'node:test';
import type { CommandResult } from '../../dispatch/waits.mts';
import type { WatchDef } from '../../watch/store.mts';

export const PR = 'https://github.com/acme/app/pull/7';
export const HEAD = 'a'.repeat(40);
export const OTHER_HEAD = 'b'.repeat(40);

// A watch of task Ab3dEf9x, created at `createdAt` and due in two hours; `overrides` replace any field.
export function watchDef(overrides: Partial<WatchDef> = {}): WatchDef {
  return {
    id: 'a1b2c3d4e5f60718',
    name: 'ci',
    task: 'Ab3dEf9x',
    source: { kind: 'ci', pr: PR, required: false, cwd: '/work' },
    everyMs: 30_000,
    createdAt: '2026-01-01T12:00:00.000Z',
    deadline: '2026-01-01T14:00:00.000Z',
    ...overrides,
  };
}

export function commandDef(command: string, overrides: Partial<WatchDef> = {}): WatchDef {
  return watchDef({
    name: 'health',
    source: { kind: 'command', command, cwd: '/work' },
    everyMs: 60_000,
    ...overrides,
  });
}

export const timerDef = (overrides: Partial<WatchDef> = {}): WatchDef =>
  watchDef({ name: 'timer', source: { kind: 'timer' }, everyMs: 0, ...overrides });

// What a finished command answered; stdout and stderr default to the output on the side the exit code suggests.
export function commandResult(exitCode: number | null, output = '', extra: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode,
    timedOut: false,
    output,
    stdout: exitCode === 0 ? output : '',
    stderr: exitCode === 0 ? '' : output,
    ...extra,
  };
}

// A temporary directory that goes when the test file is done.
export function tempDir(prefix = 'board-watch-test-'): string {
  const dir = mkdtempSync(`/tmp/${prefix}`);
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
