import { GitHubError } from './github.mts';
import { SystemError } from './system.mts';
import { BackendError, dryRunBackend, loadWebConfig } from './backend.mts';
import { ConfigError, getPaths, loadConfig } from './config.mts';
import type { Config } from './config.mts';
import { createSealedBackend } from './sealing.mts';
import type { Backend } from '@agent-board/shared';

export interface Context {
  config: Config;
  backend: Backend;
  dryRun: boolean;
  print: (line: string) => void;
}

export function print(line: string): void {
  console.log(line);
}

export function buildContext(dryRun: boolean): Context {
  const paths = getPaths();
  const config = loadConfig(paths.configFile);
  // The dry-run wrapper goes outside the sealing one, so it prints plaintext and reads what the sealing backend opens.
  const backend = createSealedBackend({ loadConfig: () => loadWebConfig(paths.configDir) });
  return { config, backend: dryRun ? dryRunBackend(backend, print) : backend, dryRun, print };
}

// Expected failures end as one line on stderr, not a stack trace.
export async function runMain(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof BackendError ||
      error instanceof UsageError ||
      error instanceof GitHubError ||
      error instanceof SystemError
    ) {
      console.error(`agent-board: ${error.message}`);
    } else {
      console.error(`agent-board: unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}

export class UsageError extends Error {}

export async function readStdin(): Promise<string> {
  let content = '';
  for await (const chunk of process.stdin) content += String(chunk);
  return content;
}

export function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

// Anything left after the known flags is a typo, and a typo must never turn into a real run.
export function rejectExtraArgs(args: string[], usage: string): void {
  if (args.length > 0) throw new UsageError(`unexpected argument "${args[0]}"; ${usage}`);
}
