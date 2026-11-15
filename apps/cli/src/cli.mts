import { GitHubError } from './github.mts';
import { SystemError } from './system.mts';
import { BackendError, dryRunBackend, loadWebConfig, updateCliHint } from './backend.mts';
import { ConfigError, getPaths, loadConfig } from './config.mts';
import type { Config } from './config.mts';
import { taskLink } from './links.mts';
import { createSealedBackend } from './sealing.mts';
import type { Backend, SkippedItem } from '@agent-board/shared';
import { wantsColor } from './style.mts';

export interface Context {
  config: Config;
  backend: Backend;
  dryRun: boolean;
  print: (line: string) => void;
  // Whether output may carry colour.
  color?: boolean;
  // The newest CLI release the board advertised, known once a call reached the board.
  serverCli?: () => string | undefined;
}

/** What the commands that print or send a link to a task need: that link, from this machine's own web.json and the task's id. */
export interface LinkingContext extends Context {
  taskLink: (taskId: string) => string;
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

// Warns on stderr, once per field and value, that a list answer left an item out for a value this CLI does not know.
export function warnSkippedOnce(warn: (line: string) => void = console.error): (skipped: SkippedItem) => void {
  const seen = new Set<string>();
  return ({ what, field, value }) => {
    const key = `${what}.${field}=${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    warn(`board: skipped a ${what} with ${field} ${JSON.stringify(value)} this CLI does not know; ${updateCliHint()}`);
  };
}

// An older board server is a state to wait out during a rollout, not a failure of a tick: one line, exit 0.
export async function skipTickWhileServerOlder(
  tick: () => Promise<void>,
  log: (line: string) => void = print,
): Promise<void> {
  try {
    await tick();
  } catch (error) {
    if (!(error instanceof BackendError) || error.contractMismatch !== 'server-older') throw error;
    log(`skipped: ${error.message}`);
  }
}

// The config is read on first use, so a command that never needs it works without a config.json.
export function buildContext(dryRun: boolean, options: ContextOptions = {}): LinkingContext {
  const paths = getPaths();
  // The dry-run wrapper goes outside the sealing one, so it prints plaintext and reads what the sealing backend opens.
  let serverCli: string | undefined;
  const backend = createSealedBackend({
    onServer: (identity) => {
      serverCli = identity.cli;
    },
    loadConfig: () => loadWebConfig(paths.configDir),
    onSkip: warnSkippedOnce(),
    warn: (line) => console.error(`board: ${line}`),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  let config: Config | undefined;
  let boardUrl: string | undefined;
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
    serverCli: () => serverCli,
    // From this machine's own web.json, never from the server.
    taskLink: (taskId) => taskLink((boardUrl ??= loadWebConfig(paths.configDir).url), taskId),
  };
}

// Expected failures end as a line on stderr, not a stack trace; a usage error exits 2, the rest 1.
export async function runMain(main: () => Promise<void>, prefix = 'agent-board'): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof ReportedFailure) {
      process.exitCode = error.exitCode;
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

// A failure whose reason was already printed: it only sets the exit code (1, or the status of a program that ran for the user).
export class ReportedFailure extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

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

// The binary honours HTTP_PROXY and Node can (NODE_USE_ENV_PROXY): a board on this machine must never be sent through one,
// or the token reaches the proxy in clear. Both runtimes read NO_PROXY, so loopback goes on it before the first request.
export function keepLoopbackOffProxy(env: Record<string, string | undefined>): void {
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'];
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const current = (env[name] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    env[name] = [...current, ...loopback.filter((entry) => !current.includes(entry))].join(',');
  }
}
