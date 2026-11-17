import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { after } from 'node:test';
import type { CommandResult } from '../../dispatch/waits.mts';
import type { WatchRunner } from '../../watch/attempt.mts';
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

export const mergedDef = (overrides: Partial<WatchDef> = {}): WatchDef =>
  watchDef({ name: 'pr-merged', source: { kind: 'pr-merged', pr: PR, cwd: '/work' }, everyMs: 60_000, ...overrides });

// What `gh pr view <pr> --json state,mergedAt,closedAt,mergeCommit` printed for a merged, a closed and an open PR.
export const mergedFixture = (state: 'merged' | 'closed' | 'open'): string =>
  readFileSync(new URL(`../fixtures/pr-merged-${state}.json`, import.meta.url), 'utf8');

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

export interface FakeRunner extends WatchRunner {
  // Every command it was asked to run, in order.
  calls: string[];
}

/**
 * A runner that starts no process: `gh pr view` finds the open PR at HEAD (asked for its reviews and comments: none, by
 * octo-dev; asked for its merge: still open), `gh pr checks` has one check still running, and any other command exits 1 with "not yet". `answer` overrides a command by a prefix it starts with.
 */
export function fakeRunner(answer: Record<string, CommandResult> = {}): FakeRunner {
  const calls: string[] = [];
  const run: WatchRunner = async ({ command }) => {
    calls.push(command);
    const given = Object.entries(answer).find(([prefix]) => command.startsWith(prefix));
    if (given !== undefined) return given[1];
    if (command.startsWith('gh pr view') && command.includes('--json state,'))
      return commandResult(0, mergedFixture('open'));
    if (command.startsWith('gh pr view') && command.includes('reviews,comments'))
      return commandResult(
        0,
        JSON.stringify({ url: PR, state: 'OPEN', author: { login: 'octo-dev' }, reviews: [], comments: [] }),
      );
    if (command.startsWith('gh pr view'))
      return commandResult(0, JSON.stringify({ url: PR, headRefOid: HEAD, state: 'OPEN' }));
    if (command.startsWith('gh pr checks'))
      return commandResult(0, JSON.stringify([{ name: 'build', bucket: 'pending', link: '' }]));
    return commandResult(1, 'not yet');
  };
  return Object.assign(run, { calls });
}
