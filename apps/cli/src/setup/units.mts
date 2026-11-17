/**
 * `board restart` and `board logs`: the worker units of this machine (the dispatch timer, the listener, the watch unit) as
 * systemd user units on Linux and as launchd agents on macOS, without typing systemctl, journalctl or launchctl.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeTaskId } from '@agent-board/shared';
import { ReportedFailure, UsageError } from '../cli.mts';
import { plainLine } from '../output/terminal.mts';
import { logFile } from '../worker/logs.mts';
import { AGENT_NAMES, agentFile, agentLabel, agentLog, agentTarget, bootstrapCommand } from './launchd.mts';
import type { AgentName } from './launchd.mts';
import { LISTEN_SERVICE, WATCH_SERVICE } from './setup.mts';
import type { SetupDeps } from './setup.mts';
import { SystemError } from './system.mts';

export const WORKER_UNITS = AGENT_NAMES;
export type WorkerUnit = AgentName;

const SETUP_HINT = 'run "board setup --enable"';

// What the journal and the unit files call each unit: dispatch is a timer that starts a oneshot service.
const SERVICES: Record<WorkerUnit, string> = {
  dispatch: 'agent-board-dispatch.service',
  listen: LISTEN_SERVICE,
  watch: WATCH_SERVICE,
};
const RESTARTED_UNIT: Record<WorkerUnit, string> = { ...SERVICES, dispatch: 'agent-board-dispatch.timer' };

const unitsOf = (requested: readonly WorkerUnit[]): readonly WorkerUnit[] =>
  requested.length === 0 ? WORKER_UNITS : WORKER_UNITS.filter((unit) => requested.includes(unit));

export type RestartDeps = Pick<SetupDeps, 'unitDir' | 'launchd' | 'platform' | 'run' | 'print'>;

// Restarts the units that are installed; a running worker is its own transient unit and is not touched.
export async function restartUnits(deps: RestartDeps, requested: readonly WorkerUnit[]): Promise<void> {
  const { platform } = deps;
  if (platform !== 'linux' && platform !== 'darwin')
    throw new SystemError(
      `this system has no worker units: board restart needs Linux with systemd or macOS, not ${platform}`,
    );
  let restarted = 0;
  let failed = false;
  for (const unit of unitsOf(requested)) {
    const done = platform === 'linux' ? await restartSystemd(deps, unit) : await restartLaunchd(deps, unit);
    if (done === 'restarted') restarted += 1;
    if (done === 'failed') failed = true;
  }
  if (failed) throw new ReportedFailure('a restart failed');
  if (restarted === 0) throw new ReportedFailure('nothing was restarted');
}

type Outcome = 'restarted' | 'skipped' | 'failed';

async function runRestart(
  deps: RestartDeps,
  program: string,
  args: string[],
  name: string,
  did: string,
): Promise<Outcome> {
  try {
    await deps.run(program, args);
  } catch (error) {
    deps.print(`could not restart ${name}: ${plainLine(error instanceof Error ? error.message : String(error))}`);
    return 'failed';
  }
  deps.print(`${did} ${name}`);
  return 'restarted';
}

async function restartSystemd(deps: RestartDeps, unit: WorkerUnit): Promise<Outcome> {
  const name = RESTARTED_UNIT[unit];
  if (!existsSync(join(deps.unitDir, name))) {
    deps.print(`${name} is not installed in ${deps.unitDir}; ${SETUP_HINT}`);
    return 'skipped';
  }
  return runRestart(deps, 'systemctl', ['--user', 'restart', name], name, 'restarted');
}

async function restartLaunchd(deps: RestartDeps, unit: WorkerUnit): Promise<Outcome> {
  const { uid, agentsDir } = deps.launchd;
  const label = agentLabel(unit);
  if (!(await deps.launchd.loaded(unit))) {
    deps.print(
      `${label} is not loaded; ${SETUP_HINT}, or load it with: ${bootstrapCommand(uid, join(agentsDir, agentFile(unit)))}`,
    );
    return 'skipped';
  }
  // A tick that runs is not killed: -k would end it midway, and the next one starts at once anyway.
  const args = ['kickstart', ...(unit === 'dispatch' ? [] : ['-k']), agentTarget(uid, unit)];
  return runRestart(deps, 'launchctl', args, label, unit === 'dispatch' ? 'started a tick of' : 'restarted');
}

// Runs a program on the terminal of the user and resolves with its exit code; undefined when it could not be started.
export type RunInherited = (argv: string[]) => Promise<number | undefined>;

// The user ending a follow with Ctrl-C is the normal way out: the signal reaches the child through the terminal.
export const runInherited: RunInherited = ([program, ...args]) =>
  new Promise((resolve) => {
    if (program === undefined) return resolve(undefined);
    const child = spawn(program, args, { stdio: 'inherit' });
    const ignore = (): void => undefined;
    process.on('SIGINT', ignore);
    const end = (code: number | undefined): void => {
      process.off('SIGINT', ignore);
      resolve(code);
    };
    child.once('error', () => end(undefined));
    child.once('close', (code, signal) => end(code ?? (signal === 'SIGINT' ? 0 : 1)));
  });

export interface LogsDeps {
  platform: string;
  logDir: string;
  run: RunInherited;
}

export interface LogsFlags {
  follow?: boolean;
  lines: string;
  since?: string;
}

export const DEFAULT_LINES = '100';

// The value goes to argv: digits, no sign, bounded.
function lineCount(text: string): string {
  if (!/^[1-9][0-9]{0,6}$/.test(text)) throw new UsageError('--lines takes a positive whole number');
  return text;
}

// A time as journalctl reads one ("2 hours ago", "2026-01-31 10:00", "-1h"): letters, digits and a few separators only.
function sinceTime(text: string): string {
  if (!/^[A-Za-z0-9 :.+_-]{1,40}$/.test(text))
    throw new UsageError('--since takes a time such as "1 hour ago", "-30m" or "2026-01-31 10:00"');
  return text;
}

const isWorkerUnit = (word: string): word is WorkerUnit => WORKER_UNITS.some((unit) => unit === word);

// Prints the log of one unit (or all of them) or of a task. A task's log is the file its worker wrote on the machine that ran it.
export async function showLogs(deps: LogsDeps, target: string | undefined, flags: LogsFlags): Promise<void> {
  const count = lineCount(flags.lines);
  const follow = flags.follow ? ['-f'] : [];
  const isTask = target !== undefined && !isWorkerUnit(target);
  if (flags.since !== undefined && (isTask || deps.platform !== 'linux'))
    throw new UsageError('--since works for the units on Linux only; use --lines for the end of a log');
  const since = flags.since === undefined ? [] : [`--since=${sinceTime(flags.since)}`];
  if (isTask) {
    if (!isSafeTaskId(target))
      throw new UsageError(`"${plainLine(target).slice(0, 40)}" is not ${WORKER_UNITS.join(', ')} or a task id`);
    const file = logFile(deps.logDir, target);
    return runLogs(
      deps,
      tailArgv(count, follow, [file], () => `this machine has no log for task ${target}: ${file} does not exist`),
    );
  }
  const units = unitsOf(target === undefined ? [] : [target]);
  if (deps.platform === 'linux')
    return runLogs(deps, [
      'journalctl',
      '--user',
      '--no-pager',
      '-n',
      count,
      ...follow,
      ...since,
      ...units.flatMap((name) => ['-u', SERVICES[name]]),
    ]);
  if (deps.platform === 'darwin') {
    const files = units.map((name) => agentLog(deps.logDir, name));
    return runLogs(
      deps,
      tailArgv(count, follow, files, (file) => `no log yet: ${file} does not exist`),
    );
  }
  throw new SystemError(
    `this system has no worker units: board logs needs Linux with systemd or macOS, not ${deps.platform}`,
  );
}

async function runLogs(deps: LogsDeps, argv: string[]): Promise<void> {
  const code = await deps.run(argv);
  if (code === undefined) throw new SystemError(`could not start ${argv[0]}`);
  if (code !== 0) throw new ReportedFailure(`${argv[0]} ended with status ${code}`, code);
}

function tailArgv(count: string, follow: string[], files: string[], missing: (file: string) => string): string[] {
  for (const file of files) if (!existsSync(file)) throw new SystemError(plainLine(missing(file)));
  return ['tail', '-n', count, ...follow, ...files];
}
