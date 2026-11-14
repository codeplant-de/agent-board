import { GitHubError } from './github.mts';
import { SystemError } from './system.mts';
import { BackendError, createWebBackend, dryRunBackend, loadWebConfig } from './backend.mts';
import { ConfigError, getPaths, loadConfig } from './config.mts';
import type { Config } from './config.mts';
import type { Backend } from '@agent-board/shared';
import { wantsColor } from './style.mts';

export interface Context {
  config: Config;
  backend: Backend;
  dryRun: boolean;
  print: (line: string) => void;
  // Whether output may carry colour.
  color?: boolean;
}

export function print(line: string): void {
  console.log(line);
}

export interface ContextOptions {
  // A missing config.json means the defaults: for the commands that never bind work to this machine's name (not schedule, add, dispatch, intake, worker).
  optionalConfig?: boolean;
  // Where human lines go, including the DRY lines of a dry run; stderr while stdout carries a JSON document.
  print?: (line: string) => void;
  // Per request to the board, for commands that must answer quickly.
  timeoutMs?: number;
}

// The config is read on first use, so a command that never needs it works without a config.json.
export function buildContext(dryRun: boolean, options: ContextOptions = {}): Context {
  const paths = getPaths();
  const backend = createWebBackend({
    loadConfig: () => loadWebConfig(paths.configDir),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  let config: Config | undefined;
  const out = options.print ?? print;
  return {
    get config() {
      config ??= loadConfig(paths.configFile, options);
      return config;
    },
    backend: dryRun ? dryRunBackend(backend, out) : backend,
    dryRun,
    print: out,
    color: wantsColor(process.stdout, process.env),
  };
}

// Expected failures end as a line on stderr, not a stack trace; a usage error exits 2, the rest 1.
export async function runMain(main: () => Promise<void>, prefix = 'agent-board'): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof ReportedFailure) {
      process.exitCode = 1;
      return;
    }
    if (
      error instanceof ConfigError ||
      error instanceof BackendError ||
      error instanceof UsageError ||
      error instanceof GitHubError ||
      error instanceof SystemError
    ) {
      console.error(`${prefix}: ${error.message}`);
      if (error instanceof UsageError) for (const line of error.details) console.error(line);
    } else {
      console.error(`${prefix}: unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

// A failure whose reason was already printed: it only sets the exit code.
export class ReportedFailure extends Error {}

export class UsageError extends Error {
  // Printed under the message: the command's usage and where to read more.
  details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.details = details;
  }
}

export async function readStdin(): Promise<string> {
  let content = '';
  for await (const chunk of process.stdin) content += String(chunk);
  return content;
}
