import { GitHubError } from "./github.mts";
import { SystemError } from "./system.mts";
import { ConfigError, getPaths, loadConfig, loadCredentials } from "./config.mts";
import type { Config } from "./config.mts";
import { createTrelloClient, TrelloError } from "./trello.mts";
import type { TrelloClient } from "./trello.mts";

export interface Context {
  config: Config;
  trello: TrelloClient;
  dryRun: boolean;
  print: (line: string) => void;
}

export function print(line: string): void {
  console.log(line);
}

export function buildContext(dryRun: boolean): Context {
  const paths = getPaths();
  const config = loadConfig(paths.configFile);
  const credentials = loadCredentials(paths.envFile);
  const trello = createTrelloClient({ credentials, boardId: config.boardId, dryRun, print });
  return { config, trello, dryRun, print };
}

// Expected failures end as one line on stderr, not a stack trace.
export async function runMain(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof ConfigError ||
      error instanceof TrelloError ||
      error instanceof UsageError ||
      error instanceof GitHubError ||
      error instanceof SystemError) {
      console.error(`agent-board: ${error.message}`);
    } else {
      console.error(`agent-board: unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}

export class UsageError extends Error {}

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
