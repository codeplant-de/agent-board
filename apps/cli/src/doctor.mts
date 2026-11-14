import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BackendError, checkBoardUrl, looksLikeMachineToken, verifyContract } from './backend.mts';
import type { ServerIdentity, WebConfig } from './backend.mts';
import { ConfigError, isSafeMode, parseConfig } from './config.mts';
import { parseEnv } from './env-file.mts';
import { parseExecStart, UNIT_NAMES, UNIT_PATH, whichOnPath } from './setup.mts';

export type Level = 'ok' | 'fail' | 'warn';

export interface CheckResult {
  name: string;
  level: Level;
  message: string;
  // How to fix it; set for a failure or a warning.
  hint?: string;
}

// Everything a check touches, so the checks run in tests without the machine.
export interface DoctorDeps {
  configDir: string;
  unitDir: string;
  // The version of Node this runs on; undefined on another runtime.
  nodeVersion: string | undefined;
  readText: (path: string) => string | undefined;
  mode: (path: string) => number | undefined;
  exists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  // Where a program is on the shell's PATH, and where on the PATH the units run with.
  which: (program: string) => string | undefined;
  whichInUnits: (program: string) => string | undefined;
  home: string;
  // A read-only systemctl call: its exit code.
  systemctl: (args: string[]) => Promise<number>;
  verifyServer: (config: Pick<WebConfig, 'url' | 'token'>) => Promise<ServerIdentity>;
}

type Check = (deps: DoctorDeps) => CheckResult[] | Promise<CheckResult[]>;

const ok = (name: string, message: string): CheckResult => ({ name, level: 'ok', message });
const problem = (name: string, level: 'fail' | 'warn', message: string, hint: string): CheckResult => ({
  name,
  level,
  message,
  hint,
});

export function realDoctorDeps(
  configDir: string,
  unitDir: string,
  systemctl: DoctorDeps['systemctl'],
  which: DoctorDeps['which'],
  home: string,
  whichInUnits: DoctorDeps['whichInUnits'] = (program) => whichOnPath(program, unitPath(home)),
): DoctorDeps {
  return {
    home,
    whichInUnits,
    configDir,
    unitDir,
    nodeVersion: process.versions['bun'] ? undefined : process.versions.node,
    readText: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    mode: (file) => statSync(file, { throwIfNoEntry: false })?.mode,
    exists: (file) => existsSync(file),
    isDirectory: (file) => statSync(file, { throwIfNoEntry: false })?.isDirectory() === true,
    which,
    systemctl,
    verifyServer: (config) => verifyContract(config),
  };
}

const checkNode: Check = ({ nodeVersion }) => {
  if (nodeVersion === undefined) return [];
  const major = Number(nodeVersion.split('.')[0]);
  return [
    major >= 24
      ? ok('node', `Node ${nodeVersion}`)
      : problem(
          'node',
          'fail',
          `Node ${nodeVersion} is too old`,
          'install Node 24 or newer (NODE=/path/to/node apps/cli/install.sh)',
        ),
  ];
};

const checkConfigDir: Check = ({ configDir, isDirectory }) => [
  isDirectory(configDir)
    ? ok('config dir', configDir)
    : problem('config dir', 'fail', `${configDir} does not exist`, 'run "board init"'),
];

function readWebUrl({ configDir, readText }: DoctorDeps): { url?: string; result: CheckResult } {
  const path = join(configDir, 'web.json');
  const text = readText(path);
  if (text === undefined) return { result: problem('web.json', 'fail', `${path} is missing`, 'run "board init"') };
  try {
    const raw: unknown = JSON.parse(text);
    const url = checkBoardUrl(typeof raw === 'object' && raw !== null && 'url' in raw ? raw.url : undefined);
    return { url, result: ok('web.json', url) };
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'is not valid JSON';
    return { result: problem('web.json', 'fail', `${path}: ${message}`, 'run "board init --force" to write it again') };
  }
}

const checkWeb: Check = (deps) => [readWebUrl(deps).result];

function readToken({ configDir, readText, mode }: DoctorDeps): { token?: string; results: CheckResult[] } {
  const path = join(configDir, 'env');
  const text = readText(path);
  if (text === undefined)
    return {
      results: [
        problem(
          'env',
          'fail',
          `${path} is missing`,
          'run "board init" (the token comes from the board\'s Settings page)',
        ),
      ],
    };
  const results: CheckResult[] = [];
  const fileMode = mode(path) ?? 0;
  if (isSafeMode(fileMode)) results.push(ok('env mode', (fileMode & 0o777).toString(8)));
  else
    results.push(
      problem(
        'env mode',
        'fail',
        `${path} has mode ${(fileMode & 0o777).toString(8)}; the CLI refuses it`,
        `chmod 600 ${path}`,
      ),
    );
  const token = parseEnv(text)['AGENT_BOARD_TOKEN'];
  if (!token) {
    results.push(
      problem(
        'token',
        'fail',
        'AGENT_BOARD_TOKEN is not set in env',
        'run "board init --force" or add it to the env file',
      ),
    );
    return { results };
  }
  results.push(
    looksLikeMachineToken(token)
      ? ok('token', 'present')
      : problem(
          'token',
          'warn',
          'the token does not start with abm_',
          "create a machine token on the board's Settings page",
        ),
  );
  return { token, results };
}

const checkEnv: Check = (deps) => readToken(deps).results;

const unitPath = (home: string): string => UNIT_PATH.replaceAll('%h', () => home);

const checkServer: Check = async (deps) => {
  const { url } = readWebUrl(deps);
  const { token } = readToken(deps);
  if (url === undefined || token === undefined) return [];
  try {
    await deps.verifyServer({ url, token });
    return [ok('server', `${url} answers, contract matches`)];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only the API's own answer says the token is refused; a login page or proxy with a 401 is something else.
    if (error instanceof BackendError && error.fromApi && (error.status === 401 || error.status === 403))
      return [
        problem(
          'server',
          'fail',
          `${url} refused the token`,
          'create a new machine token on the board\'s Settings page and run "board init --force"',
        ),
      ];
    if (/older than/.test(message))
      return [
        problem(
          'server',
          'fail',
          message,
          'update the older side: the board server, or the CLI with "board self-update" (or pull the checkout)',
        ),
      ];
    return [problem('server', 'fail', message, 'check the URL in web.json and that the board is up')];
  }
};

const checkConfig: Check = ({ configDir, readText }) => {
  const path = join(configDir, 'config.json');
  const text = readText(path);
  if (text === undefined)
    return [
      problem(
        'config.json',
        'warn',
        `${path} is missing; only a worker machine needs it`,
        'run "board init" on a worker machine',
      ),
    ];
  try {
    const config = parseConfig(JSON.parse(text));
    return [ok('config.json', `machine ${config.machine}`)];
  } catch (error) {
    const message =
      error instanceof SyntaxError ? 'is not valid JSON' : error instanceof Error ? error.message : String(error);
    return [
      problem(
        'config.json',
        'fail',
        `${path}: ${message}`,
        'fix the file; "board init --force" does not replace it, config.example.json shows the shape',
      ),
    ];
  }
};

const TOOLS = ['claude', 'gh', 'flock', 'systemd-run', 'systemctl'];

function installedUnits(deps: DoctorDeps): string[] {
  return UNIT_NAMES.flatMap((name) => [`agent-board-${name}.service`, `agent-board-${name}.timer`]).filter((file) =>
    deps.exists(join(deps.unitDir, file)),
  );
}

// A worker machine's tools and units: a warning on a machine that has installed no unit, a failure on one that has.
const checkWorker: Check = async (deps) => {
  const installed = installedUnits(deps);
  const level = installed.length > 0 ? 'fail' : 'warn';
  const results: CheckResult[] = [];
  for (const tool of TOOLS) {
    const found = deps.whichInUnits(tool);
    const onShell = deps.which(tool);
    if (found === undefined && onShell !== undefined)
      results.push(
        problem(
          `tool ${tool}`,
          level,
          `${tool} is at ${onShell}, on your shell's PATH but not on the units' (${unitPath(deps.home)})`,
          `link it into ~/.local/bin (ln -s ${onShell} ~/.local/bin/${tool}), then run "board doctor" again`,
        ),
      );
    else
      results.push(
        found
          ? ok(`tool ${tool}`, found)
          : problem(
              `tool ${tool}`,
              level,
              `${tool} is not on PATH`,
              `install ${tool} and make it visible to the user systemd units`,
            ),
      );
  }
  if (installed.length === 0) {
    results.push(problem('units', 'warn', 'no agent-board unit is installed', 'run "board setup" on a worker machine'));
    return results;
  }
  for (const name of UNIT_NAMES) {
    const service = `agent-board-${name}.service`;
    const timer = `agent-board-${name}.timer`;
    for (const file of [service, timer]) {
      if (!installed.includes(file))
        results.push(problem(`unit ${file}`, 'fail', `${join(deps.unitDir, file)} is missing`, 'run "board setup"'));
      else results.push(ok(`unit ${file}`, 'installed'));
    }
    const text = deps.readText(join(deps.unitDir, service));
    const args = text === undefined ? undefined : parseExecStart(text);
    if (args !== undefined) {
      // Absolute paths that are not systemd specifiers must still exist: a moved checkout or a removed Node breaks the unit quietly.
      // %h is the home directory; what is left with a % (the lock in %t) is not a program.
      const paths = args
        .map((arg) => arg.replaceAll('%h', () => deps.home))
        .filter((arg) => arg.startsWith('/') && !arg.includes('%'));
      const missing = paths.filter((path) => !deps.exists(path));
      results.push(
        missing.length === 0
          ? ok(`${service} command`, 'its programs exist')
          : problem(
              `${service} command`,
              'fail',
              `${missing.join(', ')} no longer exists`,
              'run "board setup" again from the installed CLI',
            ),
      );
    }
    if (installed.includes(timer)) {
      const enabled = (await deps.systemctl(['--user', 'is-enabled', timer])) === 0;
      const active = (await deps.systemctl(['--user', 'is-active', timer])) === 0;
      results.push(
        enabled && active
          ? ok(`${timer} state`, 'enabled and active')
          : problem(
              `${timer} state`,
              'warn',
              `${enabled ? 'enabled' : 'not enabled'}, ${active ? 'active' : 'not active'}`,
              `systemctl --user enable --now ${timer}`,
            ),
      );
    }
  }
  return results;
};

const CHECKS: Check[] = [checkNode, checkConfigDir, checkWeb, checkEnv, checkServer, checkConfig, checkWorker];

export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CHECKS) results.push(...(await check(deps)));
  return results;
}

const MARKS: Record<Level, string> = { ok: '✓', fail: '✗', warn: '!' };

export function formatResult(result: CheckResult): string {
  const hint = result.hint === undefined ? '' : `\n    → ${result.hint}`;
  return `${MARKS[result.level]} ${result.name}: ${result.message}${hint}`;
}

export function hasFailure(results: CheckResult[]): boolean {
  return results.some((result) => result.level === 'fail');
}
