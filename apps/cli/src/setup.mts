import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { selfCommand } from './self.mts';
import { SystemError } from './system.mts';

const exec = promisify(execFile);

export const UNIT_NAMES = ['dispatch', 'intake'] as const;
export type UnitName = (typeof UNIT_NAMES)[number];

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
  command: (name: UnitName) => string[];
}

export function renderUnits({ flock, command }: RenderInput): UnitFile[] {
  return UNIT_NAMES.flatMap((name) => {
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
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
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
}

export function unitDirectory(env: Record<string, string | undefined>): string {
  return join(env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'systemd', 'user');
}

export const ENABLE_COMMAND = 'systemctl --user enable --now agent-board-dispatch.timer agent-board-intake.timer';

export interface SetupFlags {
  enable?: boolean;
  print?: boolean;
}

export interface SetupDeps {
  unitDir: string;
  platform: string;
  // The absolute path of a program on PATH.
  which: (program: string) => string | undefined;
  command: RenderInput['command'];
  run: (program: string, args: string[]) => Promise<void>;
  print: (line: string) => void;
}

export function whichOnPath(program: string, path: string | undefined = process.env['PATH']): string | undefined {
  return (path ?? '')
    .split(':')
    .filter((dir) => dir !== '')
    .map((dir) => join(dir, program))
    .find((candidate) => existsSync(candidate));
}

export function realSetupDeps(env: Record<string, string | undefined>, print: (line: string) => void): SetupDeps {
  return {
    unitDir: unitDirectory(env),
    platform: process.platform,
    which: (program) => whichOnPath(program, env['PATH']),
    command: (name) => selfCommand('internal', name),
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

export async function setup(deps: SetupDeps, flags: SetupFlags): Promise<void> {
  if (deps.platform !== 'linux')
    throw new SystemError(`board setup installs systemd user units and needs Linux; this is ${deps.platform}`);
  const flock = deps.which('flock');
  if (flock === undefined) throw new SystemError('flock is not on PATH; install util-linux and run board setup again');
  const units = renderUnits({ flock, command: deps.command });
  if (flags.print) {
    for (const unit of units) deps.print(`# ${join(deps.unitDir, unit.file)}\n${unit.text}`);
    return;
  }
  mkdirSync(deps.unitDir, { recursive: true });
  for (const unit of units) {
    const path = join(deps.unitDir, unit.file);
    let old: string | undefined;
    try {
      old = readFileSync(path, 'utf8');
    } catch {
      old = undefined;
    }
    if (old === unit.text) {
      deps.print(`unchanged ${path}`);
      continue;
    }
    if (old !== undefined) for (const line of diffNote(unit.file, old, unit.text)) deps.print(line);
    // A copy, not a link: `systemctl disable` deletes a unit file that is a symlink. Removed first, so a link is not written through.
    rmSync(path, { force: true });
    writeFileSync(path, unit.text, { mode: 0o644 });
    deps.print(`wrote ${path}`);
  }
  await deps.run('systemctl', ['--user', 'daemon-reload']);
  if (flags.enable) {
    await deps.run('systemctl', [
      '--user',
      'enable',
      '--now',
      'agent-board-dispatch.timer',
      'agent-board-intake.timer',
    ]);
    deps.print('enabled and started the dispatch and intake timers');
  } else {
    deps.print(`Enable the timers when you are ready:\n  ${ENABLE_COMMAND}`);
  }
}
