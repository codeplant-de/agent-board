import { mkdtempSync, rmSync } from 'node:fs';
import { after } from 'node:test';
import type { CommandResult } from '../../dispatch/waits.mts';
import type { WatchRunner } from '../../watch/attempt.mts';
import type { WatchDef } from '../../watch/store.mts';
import type { StreamJob, StreamSink, StreamStarter } from '../../watch/stream.mts';

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

export function streamDef(command: string, overrides: Partial<WatchDef> = {}): WatchDef {
  return watchDef({
    name: 'log',
    source: { kind: 'stream', command, cwd: '/work', starts: 0, events: 0 },
    everyMs: 0,
    ...overrides,
  });
}

export interface FakeStream {
  job: StreamJob;
  sink: StreamSink;
  killed: boolean;
}

export interface FakeStreams {
  start: StreamStarter;
  // Every command that was started, in order; a test prints lines and exits through its `sink`.
  started: FakeStream[];
}

/** A stream starter that starts no process: the test plays the command. */
export function fakeStreams(): FakeStreams {
  const started: FakeStream[] = [];
  return {
    started,
    start(job, sink) {
      const stream: FakeStream = { job, sink, killed: false };
      started.push(stream);
      return {
        kill() {
          stream.killed = true;
        },
      };
    },
  };
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

export interface FakeRunner extends WatchRunner {
  // Every command it was asked to run, in order.
  calls: string[];
}

/**
 * A runner that starts no process: `gh pr view` finds the open PR at HEAD, `gh pr checks` has one check still running, and any
 * other command exits 1 with "not yet". `answer` overrides a command by a prefix it starts with.
 */
export function fakeRunner(answer: Record<string, CommandResult> = {}): FakeRunner {
  const calls: string[] = [];
  const run: WatchRunner = async ({ command }) => {
    calls.push(command);
    const given = Object.entries(answer).find(([prefix]) => command.startsWith(prefix));
    if (given !== undefined) return given[1];
    if (command.startsWith('gh pr view'))
      return commandResult(0, JSON.stringify({ url: PR, headRefOid: HEAD, state: 'OPEN' }));
    if (command.startsWith('gh pr checks'))
      return commandResult(0, JSON.stringify([{ name: 'build', bucket: 'pending', link: '' }]));
    return commandResult(1, 'not yet');
  };
  return Object.assign(run, { calls });
}
