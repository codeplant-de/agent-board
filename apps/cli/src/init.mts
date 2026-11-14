import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeMachineName } from '@agent-board/shared';
import * as clack from '@clack/prompts';
import { checkBoardUrl, looksLikeMachineToken } from './backend.mts';
import { ConfigError } from './config.mts';
import exampleConfig from '../config.example.json' with { type: 'json' };
import { UsageError } from './cli.mts';

export interface InitFlags {
  url?: string;
  tokenFile?: string;
  machine?: string;
  force?: boolean;
}

// Questions for a person at a terminal; tests answer them without one.
export interface Prompts {
  text: (
    message: string,
    options: { defaultValue?: string; validate: (value: string) => string | undefined },
  ) => Promise<string>;
  secret: (message: string, options: { validate: (value: string) => string | undefined }) => Promise<string>;
}

export interface InitDeps {
  configDir: string;
  interactive: boolean;
  prompts: Prompts;
  hostName: string;
  now: () => Date;
  print: (line: string) => void;
}

export interface InitResult {
  written: string[];
  skipped: string[];
  // Files that were backed up before they were replaced.
  backedUp: string[];
}

export function clackPrompts(): Prompts {
  const answer = (value: string | symbol): string => {
    if (clack.isCancel(value) || typeof value !== 'string') throw new UsageError('cancelled; nothing was written');
    return value;
  };
  const check = (validate: (value: string) => string | undefined) => (value: string | undefined) =>
    validate((value ?? '').trim());
  return {
    text: async (message, { defaultValue, validate }) =>
      answer(
        await clack.text({
          message,
          ...(defaultValue === undefined ? {} : { defaultValue, placeholder: defaultValue }),
          validate: check(validate),
        }),
      ),
    secret: async (message, { validate }) => answer(await clack.password({ message, validate: check(validate) })),
  };
}

export function urlProblem(url: string): string | undefined {
  try {
    checkBoardUrl(url);
    return undefined;
  } catch (error) {
    return error instanceof ConfigError ? error.message.replace(/^web\.json: /, '') : 'not a URL';
  }
}

export function tokenProblem(token: string): string | undefined {
  return looksLikeMachineToken(token)
    ? undefined
    : "a machine token starts with abm_ (create one on the board's Settings page)";
}

export function machineProblem(name: string): string | undefined {
  return isSafeMachineName(name) ? undefined : "use letters, digits, '.', '-' and '_'";
}

function readToken(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    throw new UsageError(`cannot read the token file ${path}`);
  }
}

function backupName(path: string, now: Date): string {
  return `${path}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
}

// A file created with its final mode, never widened and narrowed afterwards.
function createFile(path: string, content: string, mode: number): void {
  writeFileSync(path, content, { mode, flag: 'wx' });
}

export async function init(deps: InitDeps, flags: InitFlags): Promise<InitResult> {
  const { configDir } = deps;
  const webPath = join(configDir, 'web.json');
  const envPath = join(configDir, 'env');
  const configPath = join(configDir, 'config.json');
  const force = flags.force === true;
  const result: InitResult = { written: [], skipped: [], backedUp: [] };

  // An existing file is kept without --force. config.json holds the user's lanes and repos, so even --force keeps it.
  const exists = (path: string): boolean => existsSync(path);
  const writeWeb = force || !exists(webPath);
  const writeEnv = force || !exists(envPath);
  const writeConfig = !exists(configPath);
  if (!writeWeb) result.skipped.push(webPath);
  if (!writeEnv) result.skipped.push(envPath);
  if (!writeConfig) result.skipped.push(configPath);

  const need = (flag: string, what: string): never => {
    throw new UsageError(`${what} is needed and there is no terminal to ask: give ${flag}`);
  };
  let url: string | undefined;
  let token: string | undefined;
  if (flags.url !== undefined) {
    const problem = urlProblem(flags.url);
    if (problem) throw new UsageError(`--url: ${problem}`);
  }
  if (writeWeb || writeEnv) {
    url =
      flags.url ??
      (deps.interactive
        ? await deps.prompts.text("The board's URL", { validate: (v) => urlProblem(v) })
        : need('--url', "the board's URL"));
    token =
      flags.tokenFile !== undefined
        ? readToken(flags.tokenFile)
        : deps.interactive
          ? await deps.prompts.secret('Machine token (not shown)', { validate: (v) => tokenProblem(v) })
          : need('--token-file', 'the machine token');
    const problem = tokenProblem(token);
    if (problem) throw new UsageError(`the token: ${problem}`);
  }
  let machine: string | undefined;
  if (writeConfig) {
    machine =
      flags.machine ??
      (deps.interactive
        ? await deps.prompts.text('Machine name', { defaultValue: deps.hostName, validate: (v) => machineProblem(v) })
        : deps.hostName);
    const problem = machineProblem(machine);
    if (problem) throw new UsageError(`the machine name: ${problem}`);
  }

  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const backUp = (path: string): void => {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    const backup = backupName(path, deps.now());
    createFile(backup, readFileSync(path, 'utf8'), stat.mode & 0o777);
    rmSync(path);
    result.backedUp.push(backup);
  };
  if (writeWeb && url !== undefined) {
    backUp(webPath);
    createFile(webPath, `${JSON.stringify({ url: checkBoardUrl(url) }, null, 2)}\n`, 0o644);
    result.written.push(webPath);
  }
  if (writeEnv && token !== undefined) {
    backUp(envPath);
    createFile(envPath, `AGENT_BOARD_TOKEN=${token}\n`, 0o600);
    result.written.push(envPath);
  }
  if (writeConfig && machine !== undefined) {
    createFile(configPath, `${JSON.stringify({ ...exampleConfig, machine }, null, 2)}\n`, 0o644);
    result.written.push(configPath);
  }

  for (const path of result.written) deps.print(`wrote ${path}`);
  for (const path of result.backedUp) deps.print(`backed up the old file to ${path}`);
  for (const path of result.skipped)
    deps.print(
      `kept ${path}${path === configPath && force ? ' (config.json is never replaced)' : ' (it exists; --force replaces it after a backup)'}`,
    );
  return result;
}
