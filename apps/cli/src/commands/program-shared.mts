import type { Command } from 'commander';
import type { WaitStore } from '../dispatch/waits.mts';
import type { ContextOptions, LinkingContext } from '../cli.mts';
import type { SelfUpdateDeps } from '../self/self-update.mts';
import type { UpdateState } from '../self/update-state.mts';
import type { DoctorDeps } from '../setup/doctor.mts';
import type { Prompts } from '../setup/init.mts';
import type { SetupDeps } from '../setup/setup.mts';
import type { Spawner } from './board.mts';

export interface ProgramOptions {
  env?: Record<string, string | undefined>;
  // The context of a command; tests hand over a fake backend.
  context?: (dryRun: boolean, options: ContextOptions) => LinkingContext;
  readStdin?: () => Promise<string>;
  // Starts claude for `attach`; tests must not launch the real one.
  spawnClaude?: Spawner;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  version?: string;
  // The machine under the setup commands; tests replace what would touch it.
  prompts?: Prompts;
  interactive?: boolean;
  hostName?: string;
  now?: () => Date;
  which?: SetupDeps['which'];
  platform?: string;
  // Runs a systemctl call that changes something (daemon-reload, enable).
  runSystem?: SetupDeps['run'];
  // The exit code of a read-only systemctl call.
  systemctlCode?: DoctorDeps['systemctl'];
  verifyServer?: DoctorDeps['verifyServer'];
  // Runs `gh` for self-update.
  gh?: (args: string[]) => Promise<string>;
  // Restarts the listener after self-update replaced the binary.
  restartListener?: SelfUpdateDeps['restartListener'];
  // The command line being run, set by runBoard.
  argv?: string[];
  // Where `board wait --check` stores the check, and the directory it runs in.
  waits?: WaitStore;
  cwd?: string;
  // The home directory, which `board dirs` warns about.
  home?: string;
  // Whether stderr is a terminal, the only place the update hint is shown.
  stderrIsTty?: boolean;
  // Where the update hint remembers when it was last shown.
  updateState?: UpdateState;
}

// What buildProgram builds once and hands to every command group.
export interface ProgramShared {
  program: Command;
  options: ProgramOptions;
  env: Record<string, string | undefined>;
  argv: string[];
  inRun: boolean;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  out: (line: string) => void;
  makeContext: (dryRun: boolean, options: ContextOptions) => LinkingContext;
  contextOf: (
    command: Command,
    flags?: { strictConfig?: boolean; json?: boolean; timeoutMs?: number },
  ) => LinkingContext;
  writeJson: (value: unknown) => void;
  taskIdOf: (context: LinkingContext, arg: string) => Promise<string>;
  jsonOption: (command: Command, flags?: { readable?: boolean }) => Command;
  jsonOptionReadable: (command: Command) => Command;
  dryRunOption: (command: Command) => Command;
  refuseDryRunInText: (words: string[], usage: string) => void;
  notInRun: (message: string) => void;
  textOf: (words: string[]) => Promise<string>;
}
