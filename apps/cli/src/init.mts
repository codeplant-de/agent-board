import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDataKey, isSafeMachineName } from '@agent-board/shared';
import { checkBoardUrl, looksLikeMachineToken } from './backend.mts';
import { ConfigError, readSecretFile } from './config.mts';
import { parseEnv } from './env-file.mts';
import exampleConfig from '../config.example.json' with { type: 'json' };
import { UsageError } from './cli.mts';

export interface InitFlags {
  url?: string;
  tokenFile?: string;
  dataKeyFile?: string;
  machine?: string;
  force?: boolean;
}

// Questions for a person at a terminal; tests answer them without one. `validate` gets the raw input, as clack passes it
// (untrimmed, and before a default is applied), and the answer comes back raw too.
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

// Clack is loaded only when a person is asked, so the hook, dispatch and intake never pay for it.
export function clackPrompts(): Prompts {
  const answer = (value: string | symbol): string => {
    if (typeof value !== 'string') throw new UsageError('cancelled; nothing was written');
    return value;
  };
  return {
    text: async (message, { defaultValue, validate }) => {
      const clack = await import('@clack/prompts');
      return answer(
        await clack.text({
          message,
          ...(defaultValue === undefined ? {} : { defaultValue, placeholder: defaultValue }),
          // clack validates the empty input before it applies the default, so the default is what gets validated then.
          validate: (value) => validate(value === undefined || value.trim() === '' ? (defaultValue ?? '') : value),
        }),
      );
    },
    secret: async (message, { validate }) => {
      const clack = await import('@clack/prompts');
      return answer(await clack.password({ message, validate: (value) => validate(value ?? '') }));
    },
  };
}

export function urlProblem(url: string): string | undefined {
  try {
    checkBoardUrl(url.trim());
    return undefined;
  } catch (error) {
    return error instanceof ConfigError ? error.message.replace(/^web\.json: /, '') : 'not a URL';
  }
}

export function tokenProblem(token: string): string | undefined {
  return looksLikeMachineToken(token.trim())
    ? undefined
    : "a machine token starts with abm_ (create one on the board's Settings page)";
}

// The data key is checked by what it must be, and never echoed.
export function dataKeyProblem(key: string): string | undefined {
  try {
    decodeDataKey(key.trim());
    return undefined;
  } catch {
    return "a data key is abk1_ and 43 more characters; copy it from the board's Settings page";
  }
}

export function machineProblem(name: string): string | undefined {
  return isSafeMachineName(name.trim()) ? undefined : "use letters, digits, '.', '-' and '_'";
}

// A token or key file is a secret like env: refused unless mode 600 or 400, which a pipe (`--token-file /dev/stdin`) is.
function readSecret(path: string, what: string): string {
  try {
    return readSecretFile(path, what).trim();
  } catch (error) {
    throw new UsageError(error instanceof ConfigError ? error.message : `cannot read the ${what} ${path}`);
  }
}

const STDIN_PATHS = ['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'];

// The values of an env file that is there already; nothing for a missing or unreadable one.
function readEnvValues(path: string): Record<string, string> | undefined {
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const TOKEN = 'AGENT_BOARD_TOKEN';
const DATA_KEY = 'AGENT_BOARD_DATA_KEY';

function backupName(path: string, now: Date): string {
  return `${path}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
}

interface Pending {
  path: string;
  content: string;
  mode: number;
}

export async function init(deps: InitDeps, flags: InitFlags): Promise<InitResult> {
  const { configDir } = deps;
  const webPath = join(configDir, 'web.json');
  const envPath = join(configDir, 'env');
  const configPath = join(configDir, 'config.json');
  const force = flags.force === true;
  const result: InitResult = { written: [], skipped: [], backedUp: [] };

  // An existing file is kept without --force. config.json holds the user's lanes and repos, so it is always kept.
  const writeWeb = force || !existsSync(webPath);
  // An env that exists is replaced whole with --force; without it only a value it lacks is asked for and added.
  const existingEnv = readEnvValues(envPath);
  const wantToken = force || existingEnv === undefined || !existingEnv[TOKEN];
  const wantDataKey = force || existingEnv === undefined || !existingEnv[DATA_KEY];
  const writeEnv = wantToken || wantDataKey;
  const writeConfig = !existsSync(configPath);
  if (!writeWeb) result.skipped.push(webPath);
  if (!writeEnv) result.skipped.push(envPath);
  if (!writeConfig) result.skipped.push(configPath);

  // Everything is asked and checked before the first file is touched, and each value only when its file will be written.
  const need = (flag: string, what: string): never => {
    throw new UsageError(`${what} is needed and there is no terminal to ask: give ${flag}`);
  };
  const fail = (what: string, problem: string): never => {
    throw new UsageError(`${what}: ${problem}`);
  };
  const files: Pending[] = [];
  if (writeWeb) {
    const raw =
      flags.url ??
      (deps.interactive
        ? await deps.prompts.text("The board's URL", { validate: urlProblem })
        : need('--url', "the board's URL"));
    const url = raw.trim();
    const problem = urlProblem(url);
    if (problem) fail(flags.url === undefined ? "the board's URL" : '--url', problem);
    files.push({ path: webPath, content: `${JSON.stringify({ url: checkBoardUrl(url) }, null, 2)}\n`, mode: 0o644 });
  }
  if (writeEnv) {
    if (flags.tokenFile !== undefined && flags.tokenFile === flags.dataKeyFile)
      throw new UsageError('--token-file and --data-key-file name the same file; they are two secrets');
    if (
      flags.tokenFile !== undefined &&
      flags.dataKeyFile !== undefined &&
      STDIN_PATHS.includes(flags.tokenFile) &&
      STDIN_PATHS.includes(flags.dataKeyFile)
    )
      throw new UsageError('only one of --token-file and --data-key-file can be /dev/stdin');
    if (!force && existingEnv !== undefined)
      deps.print(
        `${envPath} has ${wantToken ? 'no token' : 'a token'} and ${wantDataKey ? 'no data key' : 'a data key'}: asking for ${wantToken ? 'the token' : 'the data key'} only`,
      );
    // What the file keeps when a value is not asked for again: the current one.
    const current = (name: string): string | undefined => existingEnv?.[name];
    const secret = async (options: {
      want: boolean;
      name: string;
      flag: string;
      file: string | undefined;
      what: string;
      message: string;
      problem: (value: string) => string | undefined;
    }): Promise<string> => {
      const kept = current(options.name);
      if (!options.want) return kept ?? '';
      if (options.file !== undefined) return readSecret(options.file, options.what).trim();
      // With --force the current value stays when it is not given again.
      if (!deps.interactive) return kept !== undefined && force ? kept : need(options.flag, options.what);
      const answer = (
        await deps.prompts.secret(
          kept !== undefined && force ? `${options.message} (Enter keeps the current one)` : options.message,
          {
            validate: (value) =>
              value.trim() === '' && kept !== undefined && force ? undefined : options.problem(value),
          },
        )
      ).trim();
      return answer === '' && kept !== undefined && force ? kept : answer;
    };
    const token = await secret({
      want: wantToken,
      name: TOKEN,
      flag: '--token-file',
      file: flags.tokenFile,
      what: 'token file',
      message: 'Machine token (not shown)',
      problem: tokenProblem,
    });
    const tokenError = wantToken ? tokenProblem(token) : undefined;
    if (tokenError) fail('the token', tokenError);
    const dataKey = await secret({
      want: wantDataKey,
      name: DATA_KEY,
      flag: '--data-key-file',
      file: flags.dataKeyFile,
      what: 'data key file',
      message: "Data key (not shown; copy it from the board's Settings page)",
      problem: dataKeyProblem,
    });
    const keyError = wantDataKey ? dataKeyProblem(dataKey) : undefined;
    if (keyError) fail('the data key', keyError);
    // Everything else the file held stays too.
    const others = Object.entries(existingEnv ?? {}).filter(([name]) => name !== TOKEN && name !== DATA_KEY);
    const content = [[TOKEN, token], [DATA_KEY, dataKey], ...others]
      .map(([name, value]) => `${name}=${value}`)
      .join('\n');
    files.push({ path: envPath, content: `${content}\n`, mode: 0o600 });
  }
  if (writeConfig) {
    const fallback = deps.hostName;
    const raw =
      flags.machine ??
      (deps.interactive
        ? await deps.prompts.text('Machine name', {
            defaultValue: fallback,
            validate: (value) => machineProblem(value.trim() === '' ? fallback : value),
          })
        : fallback);
    const machine = raw.trim() === '' ? fallback : raw.trim();
    const problem = machineProblem(machine);
    if (problem) fail('the machine name', problem);
    files.push({
      path: configPath,
      content: `${JSON.stringify({ ...exampleConfig, machine }, null, 2)}\n`,
      mode: 0o644,
    });
  }

  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // Each file is written beside its place with its final mode and renamed over it, so no failure leaves a file missing,
  // and a link in the way (even a dangling one) is replaced, not followed.
  const staged: string[] = [];
  // Every temp file, backups included, is written before the first rename, so a failure up to there changes nothing.
  const renames: { from: string; to: string }[] = [];
  const stage = (to: string, content: string | Buffer, mode: number): void => {
    const from = `${to}.tmp-${process.pid}`;
    staged.push(from);
    rmSync(from, { force: true });
    writeFileSync(from, content, { mode, flag: 'wx' });
    renames.push({ from, to });
  };
  try {
    for (const file of files) {
      const existing = statSync(file.path, { throwIfNoEntry: false });
      if (existing) {
        const backup = backupName(file.path, deps.now());
        stage(backup, readFileSync(file.path), existing.mode & 0o777);
        result.backedUp.push(backup);
      }
      stage(file.path, file.content, file.mode);
    }
    for (const { from, to } of renames) renameSync(from, to);
    result.written.push(...files.map((file) => file.path));
  } finally {
    for (const temp of staged) rmSync(temp, { force: true });
  }

  for (const path of result.written) deps.print(`wrote ${path}`);
  for (const path of result.backedUp) deps.print(`backed up the old file to ${path}`);
  for (const path of result.skipped)
    deps.print(
      path === configPath
        ? `kept ${path} (config.json is always kept; edit it by hand)`
        : `kept ${path} (it exists; --force replaces it after a backup)`,
    );
  return result;
}
