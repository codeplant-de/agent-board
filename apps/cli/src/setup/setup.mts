import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TOOL_UNIT_NAMES } from '@agent-board/shared';
import { EXEC_PATH, isCompiledBinary, selfCommand } from '../self/self.mts';
import { getPaths } from '../config/config.mts';
import { ensureRunDir, runDir } from '../worker/runtime.mts';
import {
  agentLabel,
  agentTarget,
  bootstrapCommand,
  isAgentLoaded,
  launchAgentsDirectory,
  passedEnv,
  renderAgents,
} from './launchd.mts';
import type { LaunchdSetupDeps } from './launchd.mts';
import { SystemError } from './system.mts';

const exec = promisify(execFile);

// The PATH of the units: what the worker finds `claude`, `gh` and `systemd-run` on, whatever the shell's PATH is. %h is the home directory.
export const UNIT_PATH = '%h/.local/bin:/usr/local/bin:/usr/bin:/bin';

// Every unit name must be in TOOL_UNIT_NAMES, which keeps it from being a task id and so a worker unit's name.
type ToolUnitName = (typeof TOOL_UNIT_NAMES)[number];
export const UNIT_NAMES = ['dispatch', 'intake'] as const satisfies readonly ToolUnitName[];
export type UnitName = (typeof UNIT_NAMES)[number];

// The timed units a machine runs: intake only when its config has an `intake` key.
export function activeUnitNames(intake: boolean): UnitName[] {
  return UNIT_NAMES.filter((name) => name !== 'intake' || intake);
}

// The listener is a service without a timer: it holds the board's event stream and starts dispatch ticks.
const LISTEN_NAME: ToolUnitName = 'listen';
export const LISTEN_SERVICE = `agent-board-${LISTEN_NAME}.service`;

// Exit 75 is `flock -E 75`: another tick holds the lock, which is not a failure.
const UNITS: Record<
  UnitName,
  { description: string; timerDescription: string; timeout: number; boot: string; every: string; accuracy: string }
> = {
  dispatch: {
    description: 'agent-board dispatcher: one tick',
    timerDescription: 'agent-board dispatcher every 2 minutes',
    timeout: 110,
    boot: '2min',
    every: '2min',
    accuracy: '10s',
  },
  intake: {
    description: 'agent-board intake: review requests to tasks',
    timerDescription: 'agent-board intake every 10 minutes',
    timeout: 300,
    boot: '5min',
    every: '10min',
    accuracy: '30s',
  },
};

// One argument of an ExecStart line: `%` and `$` are systemd's own, and anything unusual goes in double quotes.
export function quoteExecArg(arg: string): string {
  if (/[\n\r]/.test(arg)) throw new SystemError(`cannot put a line break in a unit file: ${JSON.stringify(arg)}`);
  const escaped = arg.replaceAll('%', () => '%%').replaceAll('$', () => '$$');
  if (/^[A-Za-z0-9_@:,./=+-]+$/.test(escaped.replaceAll('%%', () => '').replaceAll('$$', () => ''))) return escaped;
  return `"${escaped.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// The arguments of an ExecStart line, as systemd reads them (the reverse of quoteExecArg; specifiers stay as written).
export function parseExecStart(unit: string): string[] | undefined {
  const line = /^ExecStart=(.*)$/m.exec(unit)?.[1];
  if (line === undefined) return undefined;
  const args: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const match of line.matchAll(pattern)) {
    args.push(
      (match[1]?.replace(/\\(.)/g, '$1') ?? match[2] ?? '').replaceAll('%%', () => '%').replaceAll('$$', () => '$'),
    );
  }
  return args;
}

export interface UnitFile {
  file: string;
  text: string;
}

export interface RenderInput {
  // The absolute path of flock.
  flock: string;
  // The command that runs `internal <name>`.
  command: (name: UnitName | 'listen') => string[];
  // Whether to render the intake service and timer.
  intake: boolean;
}

export function renderUnits({ flock, command, intake }: RenderInput): UnitFile[] {
  const timed = activeUnitNames(intake).flatMap((name) => {
    const unit = UNITS[name];
    // %t is the runtime directory, where bin/dispatch and bin/intake keep the same lock files.
    const execStart = [
      quoteExecArg(flock),
      '-n',
      '-E',
      '75',
      `%t/agent-board-${name}.lock`,
      ...command(name).map(quoteExecArg),
    ].join(' ');
    return [
      {
        file: `agent-board-${name}.service`,
        text: `[Unit]
Description=${unit.description}

[Service]
Type=oneshot
# PATH is for gh, claude and systemd-run.
Environment=PATH=${UNIT_PATH}
# The lock keeps one run at a time, whoever starts it; exit 75 means another run holds it, which is not a failure.
ExecStart=${execStart}
SuccessExitStatus=75
TimeoutStartSec=${unit.timeout}
`,
      },
      {
        file: `agent-board-${name}.timer`,
        text: `[Unit]
Description=${unit.timerDescription}

[Timer]
OnBootSec=${unit.boot}
OnUnitActiveSec=${unit.every}
AccuracySec=${unit.accuracy}

[Install]
WantedBy=timers.target
`,
      },
    ];
  });
  const listen: UnitFile = {
    file: LISTEN_SERVICE,
    text: `[Unit]
Description=agent-board listener: dispatch as soon as the board says tasks changed
# The listener exits when the board no longer serves this CLI, until the CLI is updated; systemd must keep restarting it, not give up.
StartLimitIntervalSec=0

[Service]
Type=simple
# PATH is for the gh, claude and systemd-run that the dispatch ticks it starts use.
Environment=PATH=${UNIT_PATH}
ExecStart=${command('listen').map(quoteExecArg).join(' ')}
Restart=always
RestartSec=10
# Stopping signals the listener only; it waits for a running tick, which systemd then no longer cuts off midway.
KillMode=mixed

[Install]
WantedBy=default.target
`,
  };
  return [...timed, listen];
}

export function unitDirectory(env: Record<string, string | undefined>): string {
  return join(env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'systemd', 'user');
}

function enableUnits(intake: boolean): string[] {
  return [...activeUnitNames(intake).map((name) => `agent-board-${name}.timer`), LISTEN_SERVICE];
}

export function enableCommand(intake: boolean): string {
  return `systemctl --user enable --now ${enableUnits(intake).join(' ')}`;
}

export interface SetupFlags {
  enable?: boolean;
  print?: boolean;
  // Install although the tree that runs setup is not the one `board` is installed from.
  force?: boolean;
}

export interface SetupDeps {
  unitDir: string;
  // What macOS setup needs (see setupDarwin).
  launchd: LaunchdSetupDeps;
  platform: string;
  // The absolute path of a program on PATH.
  which: (program: string) => string | undefined;
  command: RenderInput['command'];
  // Whether this machine's config.json has an `intake` key.
  intake: boolean;
  // A sentence when this tree is not the one the installed `board` runs from, else undefined.
  treeProblem?: () => string | undefined;
  // Whether a timer or service is already enabled (a read-only systemctl call), to leave out the hint to enable it.
  unitEnabled?: (unit: string) => Promise<boolean>;
  run: (program: string, args: string[]) => Promise<void>;
  print: (line: string) => void;
}

// The checkout that runs setup against the one `~/.local/bin/board` resolves to: a worktree or scratch copy must not take over the live timers.
export function treeProblem(
  env: Record<string, string | undefined>,
  running: { compiled: boolean; execPath: string } = { compiled: isCompiledBinary(), execPath: EXEC_PATH },
): string | undefined {
  if (running.compiled) {
    // A binary run from the temp directory (a download being tried out) must not become what the timers run.
    const tmp = realpathSync(tmpdir());
    let real = running.execPath;
    try {
      real = realpathSync(running.execPath);
    } catch {
      // A binary that was replaced under us keeps the path it had.
    }
    return real.startsWith(`${tmp}${sep}`)
      ? `this board runs from ${real}, in the temp directory; install it (scripts/install.sh) and run board setup from there`
      : undefined;
  }
  const installed = join(env['BOARD_INSTALL_DIR'] || join(homedir(), '.local', 'bin'), 'board');
  if (!existsSync(installed)) return undefined;
  const installedTree = dirname(dirname(realpathSync(installed)));
  const thisTree = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  return installedTree === thisTree
    ? undefined
    : `this checkout (${thisTree}) is not the one ${installed} runs (${installedTree})`;
}

export function whichOnPath(program: string, path: string | undefined = process.env['PATH']): string | undefined {
  return (path ?? '')
    .split(':')
    .filter((dir) => dir !== '')
    .map((dir) => join(dir, program))
    .find((candidate) => existsSync(candidate));
}

export function realSetupDeps(
  env: Record<string, string | undefined>,
  print: (line: string) => void,
  intake: boolean,
): SetupDeps {
  const home = env['HOME'] || homedir();
  const uid = process.getuid?.() ?? 0;
  return {
    intake,
    launchd: {
      home,
      agentsDir: launchAgentsDirectory(home),
      logDir: getPaths(env).logDir,
      runDir: runDir(env, 'darwin'),
      uid,
      env: passedEnv(env),
      loaded: (name) => isAgentLoaded(uid, name),
    },
    unitDir: unitDirectory(env),
    platform: process.platform,
    which: (program) => whichOnPath(program, env['PATH']),
    command: (name) => selfCommand('internal', name),
    treeProblem: () => treeProblem(env),
    run: async (program, args) => {
      try {
        await exec(program, args);
      } catch (error) {
        throw new SystemError(
          `${program} ${args.join(' ')} failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`,
        );
      }
    },
    print,
  };
}

// What differs, line by line: enough to see why an installed unit is about to change.
function diffNote(file: string, old: string, next: string): string[] {
  const before = old.split('\n');
  const after = next.split('\n');
  return [
    `~ ${file} differs from what setup writes:`,
    ...before.filter((line) => !after.includes(line)).map((line) => `    - ${line}`),
    ...after.filter((line) => !before.includes(line)).map((line) => `    + ${line}`),
  ];
}

// Writes `text` to `path` as a copy unless it is there already; whether it changed.
function installCopy(deps: SetupDeps, path: string, file: string, text: string): boolean {
  let old: string | undefined;
  try {
    old = readFileSync(path, 'utf8');
  } catch {
    old = undefined;
  }
  if (old === text) {
    deps.print(`unchanged ${path}`);
    return false;
  }
  if (old !== undefined) for (const line of diffNote(file, old, text)) deps.print(line);
  // A copy, not a link: `systemctl disable` deletes a unit file that is a symlink. Removed first, so a link is not written through.
  rmSync(path, { force: true });
  writeFileSync(path, text, { mode: 0o644 });
  deps.print(`wrote ${path}`);
  return true;
}

// macOS: two launchd agents in ~/Library/LaunchAgents, written as copies and loaded into the user's gui domain. A loaded
// agent whose file changed is loaded again; with --enable every agent is. Intake has no agent here.
async function setupDarwin(deps: SetupDeps, flags: SetupFlags): Promise<void> {
  const { launchd } = deps;
  const lockf = deps.which('lockf');
  if (lockf === undefined)
    throw new SystemError('lockf is not on PATH (macOS ships /usr/bin/lockf); run board setup again');
  const agents = renderAgents({
    home: launchd.home,
    lockf,
    lockDir: launchd.runDir,
    logDir: launchd.logDir,
    command: deps.command,
    env: launchd.env,
  }).map((agent) => ({ ...agent, path: join(launchd.agentsDir, agent.file) }));
  if (flags.print) {
    for (const agent of agents) deps.print(`# ${agent.path}\n${agent.text}`);
    return;
  }
  const mismatch = deps.treeProblem?.();
  if (mismatch !== undefined) {
    if (!flags.force)
      throw new SystemError(
        `${mismatch}; run board setup from the installed one, or add --force to install these agents anyway`,
      );
    deps.print(`warning: ${mismatch}`);
  }
  mkdirSync(launchd.agentsDir, { recursive: true });
  mkdirSync(launchd.logDir, { recursive: true, mode: 0o700 });
  ensureRunDir(launchd.runDir);
  if (deps.intake)
    deps.print(
      'note: config.json has an intake key, but intake is not supported on macOS: setup installs no intake agent',
    );
  const changed = agents.map((agent) => installCopy(deps, agent.path, agent.file, agent.text));
  const domain = `gui/${launchd.uid}`;
  const load = async (agent: (typeof agents)[number]): Promise<void> => {
    // Not loaded yet is the usual case, so a failing bootout is nothing to report.
    await deps.run('launchctl', ['bootout', agentTarget(launchd.uid, agent.name)]).catch(() => undefined);
    await deps.run('launchctl', ['bootstrap', domain, agent.path]);
  };
  if (flags.enable) {
    for (const agent of agents) await load(agent);
    deps.print('loaded the dispatch agent and the listener');
    return;
  }
  const loaded = await Promise.all(agents.map((agent) => launchd.loaded(agent.name)));
  for (const [at, agent] of agents.entries()) {
    if (!changed[at] || !loaded[at]) continue;
    await load(agent);
    deps.print(`loaded ${agentLabel(agent.name)} again, to run the new agent file`);
  }
  if (loaded.every(Boolean))
    deps.print(
      `the dispatch agent and the listener are loaded already; the next tick runs the new files. To restart the listener: launchctl kickstart -k ${agentTarget(launchd.uid, 'listen')}`,
    );
  else
    deps.print(
      `Load the agents when you are ready:\n${agents
        .filter((_agent, at) => !loaded[at])
        .map((agent) => `  ${bootstrapCommand(launchd.uid, agent.path)}`)
        .join('\n')}`,
    );
}

export async function setup(deps: SetupDeps, flags: SetupFlags): Promise<void> {
  if (deps.platform === 'darwin') return setupDarwin(deps, flags);
  if (deps.platform !== 'linux')
    throw new SystemError(`board setup needs Linux with systemd or macOS; this is ${deps.platform}`);
  const flock = deps.which('flock');
  if (flock === undefined) throw new SystemError('flock is not on PATH; install util-linux and run board setup again');
  const units = renderUnits({ flock, command: deps.command, intake: deps.intake });
  if (flags.print) {
    for (const unit of units) deps.print(`# ${join(deps.unitDir, unit.file)}\n${unit.text}`);
    return;
  }
  const mismatch = deps.treeProblem?.();
  if (mismatch !== undefined) {
    if (!flags.force)
      throw new SystemError(
        `${mismatch}; run board setup from the installed one, or add --force to install these units anyway`,
      );
    deps.print(`warning: ${mismatch}`);
  }
  mkdirSync(deps.unitDir, { recursive: true });
  if (!deps.intake) {
    const leftover = ['service', 'timer']
      .map((kind) => `agent-board-intake.${kind}`)
      .filter((file) => existsSync(join(deps.unitDir, file)));
    if (leftover.length > 0)
      deps.print(
        `note: config.json has no intake key, so setup leaves ${leftover.join(' and ')} alone and \`board internal intake\` refuses; if the timer is enabled, stop it: systemctl --user disable --now agent-board-intake.timer`,
      );
  }
  let listenerChanged = false;
  for (const unit of units) {
    if (installCopy(deps, join(deps.unitDir, unit.file), unit.file, unit.text) && unit.file === LISTEN_SERVICE)
      listenerChanged = true;
  }
  await deps.run('systemctl', ['--user', 'daemon-reload']);
  // A running listener keeps the old unit and code until it is restarted; try-restart leaves a stopped one alone.
  if (listenerChanged) {
    await deps.run('systemctl', ['--user', 'try-restart', LISTEN_SERVICE]);
    deps.print(`restarted ${LISTEN_SERVICE} if it was running, to run the new unit`);
  }
  if (flags.enable) {
    await deps.run('systemctl', ['--user', 'enable', '--now', ...enableUnits(deps.intake)]);
    deps.print(
      deps.intake
        ? 'enabled and started the dispatch and intake timers and the listener'
        : 'enabled and started the dispatch timer and the listener',
    );
  } else {
    const enabled = await Promise.all(
      enableUnits(deps.intake).map((unit) => deps.unitEnabled?.(unit) ?? Promise.resolve(false)),
    );
    if (enabled.every(Boolean))
      deps.print(
        `${deps.intake ? 'the timers' : 'the timer'} and the listener are enabled already; the next tick runs the new units, and the listener once it is restarted: systemctl --user restart agent-board-listen`,
      );
    else
      deps.print(
        `Enable ${deps.intake ? 'the timers' : 'the timer'} and the listener when you are ready:\n  ${enableCommand(deps.intake)}`,
      );
  }
}
