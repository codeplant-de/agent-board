import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BackendError, checkDataKey, looksLikeMachineToken, verifyContract, webUrlOf } from '../backend/backend.mts';
import type { ServerIdentity, WebConfig } from '../backend/backend.mts';
import { ConfigError, configWarnings, isSafeMode, parseConfig } from '../config/config.mts';
import type { Config } from '../config/config.mts';
import { plainLine } from '../output/terminal.mts';
import {
  API_VERSION,
  decodeDataKey,
  machineDirsIndex,
  SERVER_FEATURE_LABELS,
  SERVER_FEATURES,
} from '@agent-board/shared';
import type { Keys } from '@agent-board/shared';
import { pluginPlaceholders } from '../dispatch/decide.mts';
import { dirsToSend, isAllowedDir, isDirectory, routedDirs, UNCOVERED_HINT } from '../commands/dirs.mts';
import { parseEnv } from '../config/env-file.mts';
import { activeUnitNames, LISTEN_SERVICE, parseExecStart, UNIT_PATH, whichOnPath } from './setup.mts';
import { errorText, shellQuote } from '../output/text.mts';
import { PluginError, resolvePluginRoot } from '../worker/plugins.mts';
import type { PluginFiles } from '../worker/plugins.mts';

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
  // The real path of an existing path; undefined when it is not there.
  realpath: (path: string) => string | undefined;
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
    isDirectory,
    realpath: (file) => {
      try {
        return realpathSync(file);
      } catch {
        return undefined;
      }
    },
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
    const url = webUrlOf(JSON.parse(text));
    return { url, result: ok('web.json', url) };
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'is not valid JSON';
    return { result: problem('web.json', 'fail', `${path}: ${message}`, 'run "board init --force" to write it again') };
  }
}

const checkWeb: Check = (deps) => [readWebUrl(deps).result];

function readCredentials({ configDir, readText, mode }: DoctorDeps): {
  token?: string;
  dataKey?: Uint8Array;
  results: CheckResult[];
} {
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
  const values = parseEnv(text);
  const token = values['AGENT_BOARD_TOKEN'];
  if (!token) {
    results.push(
      problem(
        'token',
        'fail',
        'AGENT_BOARD_TOKEN is not set in env',
        'run "board init": it sees the env without a token and asks for the token only',
      ),
    );
  } else {
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
  }
  // The key is never printed, nor part of any message.
  const encodedKey = values['AGENT_BOARD_DATA_KEY'];
  let dataKey: Uint8Array | undefined;
  if (!encodedKey) {
    results.push(
      problem(
        'data key',
        'fail',
        'AGENT_BOARD_DATA_KEY is not set in env',
        'copy the data key from the board\'s Settings page and run "board init": it sees the env without a key and asks for the key only',
      ),
    );
  } else {
    try {
      dataKey = decodeDataKey(encodedKey);
      results.push(ok('data key', 'present and well-formed'));
    } catch {
      results.push(
        problem(
          'data key',
          'fail',
          'AGENT_BOARD_DATA_KEY is not a data key (abk1_ and 43 more characters)',
          'copy it again from the board\'s Settings page and run "board init --force": it keeps the URL and the token unless you give them again, and asks for the key',
        ),
      );
    }
  }
  return { ...(token ? { token } : {}), ...(dataKey ? { dataKey } : {}), results };
}

const checkEnv: Check = (deps) => readCredentials(deps).results;

const quoted = (text: string): string => shellQuote(plainLine(text));

const unitPath = (home: string): string => UNIT_PATH.replaceAll('%h', () => home);

// A server that lacks a feature still works; only the commands that need it refuse.
const missingFeatureChecks = (features: ReadonlySet<string>): CheckResult[] => {
  const lacking = SERVER_FEATURES.filter((feature) => !features.has(feature));
  return lacking.length === 0
    ? []
    : [
        problem(
          'server features',
          'warn',
          `the board server does not support ${lacking.map((feature) => SERVER_FEATURE_LABELS[feature]).join(', ')} yet`,
          'update the board server; until then the commands that need it refuse',
        ),
      ];
};

// Whether the board holds the current directory list of this machine, for a machine with a `dirs` key and a server that can hold one.
async function dirsOnBoardChecks(deps: DoctorDeps, identity: ServerIdentity, keys: Keys): Promise<CheckResult[]> {
  if (!identity.features.has('machine.dirs')) return [];
  const text = deps.readText(join(deps.configDir, 'config.json'));
  let config: Config;
  try {
    config = parseConfig(text === undefined ? undefined : JSON.parse(text));
  } catch {
    return [];
  }
  if (config.dirs === undefined) return [];
  const index = await machineDirsIndex(keys, config.machine, dirsToSend(config.dirs, deps.isDirectory));
  return [
    index === identity.dirsIndex
      ? ok('dirs on board', 'the board has the current list')
      : problem(
          'dirs on board',
          'warn',
          'the board does not have the current list yet',
          'the next dispatch tick sends it; "board dirs add" or "board dirs rm" send it at once',
        ),
  ];
}

const checkServer: Check = async (deps) => {
  const { url } = readWebUrl(deps);
  const { token, dataKey } = readCredentials(deps);
  if (url === undefined || token === undefined) return [];
  try {
    const identity = await deps.verifyServer({ url, token });
    const results = [
      ok(
        'server',
        `${url} answers, api ${API_VERSION}, server api ${identity.api.version} (serves clients from ${identity.api.minClient})`,
      ),
      ...missingFeatureChecks(identity.features),
    ];
    // A board without a key cannot be matched, whatever env holds: say so first, with the way out.
    if (identity.keyId === null)
      return [
        ...results,
        problem(
          'board key',
          'fail',
          'the board has no data key yet',
          'set up encryption in the browser first, then copy the key from the Settings page and run "board init"',
        ),
      ];
    if (dataKey === undefined) return results;
    // The board's key and this machine's: derived for the board's owner, compared by id, neither ever printed.
    const checked = await checkDataKey(dataKey, identity);
    if ('keys' in checked)
      return [
        ...results,
        ok('board key', `the board's data key is id ${checked.keys.keyId}, and this machine holds it`),
        ...(await dirsOnBoardChecks(deps, identity, checked.keys)),
      ];
    return [
      ...results,
      problem(
        'board key',
        'fail',
        checked.problem === 'board-has-no-key'
          ? 'the board has no data key yet'
          : `this machine holds a different data key (id ${checked.mine}) than the board's (id ${checked.boards})`,
        'copy the current key from the board\'s Settings page and run "board init --force": it keeps the URL and the token unless you give them again, and asks for the key',
      ),
    ];
  } catch (error) {
    const message = errorText(error);
    // Only the API's own answer says the token is refused; a login page or proxy with a 401 is something else.
    if (error instanceof BackendError && error.fromApi && (error.status === 401 || error.status === 403))
      return [
        problem(
          'server',
          'fail',
          `${url} refused the token`,
          'create a new machine token on the board\'s Settings page and run "board init --force": it keeps the URL and the data key unless you give them again, and asks for the token',
        ),
      ];
    // Which update hint to show comes from the two API numbers, never from text the server wrote.
    if (error instanceof BackendError && error.contractMismatch !== undefined)
      return [
        problem(
          'server',
          'fail',
          message,
          error.contractMismatch === 'server-older'
            ? "update the board server to this CLI's API version"
            : 'update this CLI: "board self-update" for a binary; "git pull" and "pnpm install" in the checkout for a checkout',
        ),
      ];
    return [problem('server', 'fail', message, 'check the URL in web.json and that the board is up')];
  }
};

// Where Claude Code keeps its plugin lists, under the home directory doctor was given.
function readPluginFiles(deps: DoctorDeps): PluginFiles | undefined {
  const readJson = (file: string): unknown => {
    const text = deps.readText(file);
    try {
      return text === undefined ? undefined : JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const installedPlugins = readJson(join(deps.home, '.claude', 'plugins', 'installed_plugins.json'));
  if (installedPlugins === undefined) return undefined;
  return {
    installedPlugins,
    knownMarketplaces: readJson(join(deps.home, '.claude', 'plugins', 'known_marketplaces.json')),
    marketplaceManifest: (root) => readJson(join(root, '.claude-plugin', 'marketplace.json')),
    dirExists: deps.isDirectory,
  };
}

// The tool an allow rule is for: "Bash" for `Bash(git status)`. MCP rules name servers and patterns, which `tools` may cover
// in ways not worth guessing at.
const ruleTool = (rule: string): string => rule.split('(')[0] ?? rule;

// A plugin placeholder in rules that does not resolve fails every run those rules govern.
function checkPlugins(
  name: string,
  owner: string,
  lists: { allowedTools: string[]; disallowedTools: string[] },
  pluginFiles: PluginFiles | undefined,
): CheckResult[] {
  return pluginPlaceholders([...lists.allowedTools, ...lists.disallowedTools]).flatMap((placeholder) => {
    try {
      if (pluginFiles === undefined) throw new PluginError('cannot read ~/.claude/plugins/installed_plugins.json');
      resolvePluginRoot(placeholder, pluginFiles);
      return [];
    } catch (error) {
      return [
        problem(
          name,
          'warn',
          `its rules name {${placeholder}}, which does not resolve (${errorText(error)}), so a run as ${owner} fails`,
          'install the plugin, or name its marketplace as {plugin@marketplace}',
        ),
      ];
    }
  });
}

// What would make an agent's run fail or its rules dead letters: an agent that cannot be read, a plugin it names that does not
// resolve, an allow rule for a tool its `tools` leave out. Intake's rules name plugins too.
function checkAgents(config: Config, deps: DoctorDeps): CheckResult[] {
  const entries = Object.entries(config.agents);
  const results = [
    ...Object.entries(config.agentErrors).map(([name, reason]) =>
      problem(
        `agent ${plainLine(name.slice(0, 40))}`,
        'fail',
        `${reason}; tasks that name it are not run`,
        'fix the agent in config.json',
      ),
    ),
    ...(entries.length === 0 ? [] : [ok('agents', entries.map(([name]) => name).join(', '))]),
  ];
  const pluginFiles = readPluginFiles(deps);
  if (config.intakeEnabled) results.push(...checkPlugins('config.json intake', 'intake', config.intake, pluginFiles));
  for (const [name, agent] of entries) {
    results.push(...checkPlugins(`agent ${name}`, name, agent, pluginFiles));
    const dead = [
      ...new Set(
        agent.allowedTools.map(ruleTool).filter((tool) => !tool.startsWith('mcp__') && !agent.tools.includes(tool)),
      ),
    ];
    if (dead.length > 0)
      results.push(
        problem(
          `agent ${name}`,
          'warn',
          `allowedTools has rules for ${dead.join(', ')}, which tools leaves out: the agent does not have ${dead.length === 1 ? 'that tool' : 'those tools'}`,
          `add ${dead.length === 1 ? 'it' : 'them'} to agents.${name}.tools`,
        ),
      );
  }
  return results;
}

const checkConfig: Check = (deps) => {
  const { configDir, readText } = deps;
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
    const raw: unknown = JSON.parse(text);
    const config = parseConfig(raw);
    return [
      ok('config.json', `machine ${config.machine}`),
      ...checkAgents(config, deps),
      ...configWarnings(raw).map((warning) =>
        problem(
          'config.json',
          'warn',
          warning,
          'fix or remove the key: the CLI does not read it, so its setting keeps the default',
        ),
      ),
    ];
  } catch (error) {
    const message = error instanceof SyntaxError ? 'is not valid JSON' : errorText(error);
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

// The list of directories workers may run in. Tasks routed to a directory outside it stop in Needs me, so that is a failure.
const checkDirs: Check = (deps) => {
  const text = deps.readText(join(deps.configDir, 'config.json'));
  let config: Config;
  try {
    config = parseConfig(text === undefined ? undefined : JSON.parse(text));
  } catch {
    return [];
  }
  const { dirs } = config;
  if (dirs === undefined) return [ok('dirs', 'not set: workers are not limited to directories')];
  const results = [ok('dirs', `${dirs.length} listed`)];
  for (const { path } of dirs)
    if (!deps.isDirectory(path))
      results.push(
        problem(
          'dirs',
          'warn',
          `${plainLine(path)} is listed but is not a directory`,
          `"board dirs rm ${quoted(path)}"`,
        ),
      );
  for (const { label, path } of routedDirs(config)) {
    const real = deps.realpath(path) ?? path;
    if (!isAllowedDir(dirs, path, (file) => deps.realpath(file) ?? file))
      results.push(
        problem(
          'dirs',
          'fail',
          `${label} ${plainLine(path)} is in no listed directory: ${UNCOVERED_HINT}`,
          `"board dirs add ${quoted(real)}", or "board dirs add --from-config"`,
        ),
      );
  }
  return results;
};

// Absolute paths in a unit's ExecStart that are not systemd specifiers must still exist: a moved checkout or a removed Node breaks the unit quietly.
function checkCommand(deps: DoctorDeps, service: string): CheckResult[] {
  const text = deps.readText(join(deps.unitDir, service));
  const args = text === undefined ? undefined : parseExecStart(text);
  if (args === undefined) return [];
  // %h is the home directory; what is left with a % (the lock in %t) is not a program.
  const paths = args
    .map((arg) => arg.replaceAll('%h', () => deps.home))
    .filter((arg) => arg.startsWith('/') && !arg.includes('%'));
  const missing = paths.filter((path) => !deps.exists(path));
  return [
    missing.length === 0
      ? ok(`${service} command`, 'its programs exist')
      : problem(
          `${service} command`,
          'fail',
          `${missing.join(', ')} no longer exists`,
          'run "board setup" again from the installed CLI',
        ),
  ];
}

const TOOLS = ['claude', 'gh', 'flock', 'timeout', 'systemd-run', 'systemctl'];

// An intake machine is one whose config.json has an `intake` key; any other config problem is checkConfig's to report.
function hasIntake({ configDir, readText }: DoctorDeps): boolean {
  const text = readText(join(configDir, 'config.json'));
  if (text === undefined) return false;
  try {
    const raw: unknown = JSON.parse(text);
    return typeof raw === 'object' && raw !== null && 'intake' in raw;
  } catch {
    return false;
  }
}

function installedUnits(deps: DoctorDeps, intake: boolean): string[] {
  return [
    ...activeUnitNames(intake).flatMap((name) => [`agent-board-${name}.service`, `agent-board-${name}.timer`]),
    LISTEN_SERVICE,
  ].filter((file) => deps.exists(join(deps.unitDir, file)));
}

// A worker machine's tools and units: a warning on a machine that has installed no unit, a failure on one that has.
const checkWorker: Check = async (deps) => {
  const intake = hasIntake(deps);
  const installed = installedUnits(deps, intake);
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
  const timer = 'agent-board-intake.timer';
  if (!intake && deps.exists(join(deps.unitDir, timer)))
    results.push(
      problem(
        `unit ${timer}`,
        'warn',
        'installed, but config.json has no intake key, so `board internal intake` refuses',
        `systemctl --user disable --now ${timer}`,
      ),
    );
  if (installed.length === 0) {
    results.push(problem('units', 'warn', 'no agent-board unit is installed', 'run "board setup" on a worker machine'));
    return results;
  }
  for (const name of activeUnitNames(intake)) {
    const service = `agent-board-${name}.service`;
    const timer = `agent-board-${name}.timer`;
    for (const file of [service, timer]) {
      if (!installed.includes(file))
        results.push(problem(`unit ${file}`, 'fail', `${join(deps.unitDir, file)} is missing`, 'run "board setup"'));
      else results.push(ok(`unit ${file}`, 'installed'));
    }
    results.push(...checkCommand(deps, service));
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
  results.push(...(await checkListener(deps, installed)));
  return results;
};

// The listener is an addition to the timers, which do the same work every 2 minutes: a missing or stopped one only warns.
async function checkListener(deps: DoctorDeps, installed: string[]): Promise<CheckResult[]> {
  if (!installed.includes(LISTEN_SERVICE))
    return [
      problem(
        `unit ${LISTEN_SERVICE}`,
        'warn',
        'not installed: new tasks wait for the next timer tick',
        'run "board setup" to install it',
      ),
    ];
  const enabled = (await deps.systemctl(['--user', 'is-enabled', LISTEN_SERVICE])) === 0;
  const active = (await deps.systemctl(['--user', 'is-active', LISTEN_SERVICE])) === 0;
  return [
    ok(`unit ${LISTEN_SERVICE}`, 'installed'),
    ...checkCommand(deps, LISTEN_SERVICE),
    enabled && active
      ? ok(`${LISTEN_SERVICE} state`, 'enabled and active')
      : problem(
          `${LISTEN_SERVICE} state`,
          'warn',
          `${enabled ? 'enabled' : 'not enabled'}, ${active ? 'active' : 'not active'}`,
          `systemctl --user enable --now ${LISTEN_SERVICE}`,
        ),
  ];
}

const CHECKS: Check[] = [
  checkNode,
  checkConfigDir,
  checkWeb,
  checkEnv,
  checkServer,
  checkConfig,
  checkDirs,
  checkWorker,
];

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
