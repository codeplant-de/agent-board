import { readFileSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_PRIORITY,
  DIR_LABEL_RULE,
  isPriority,
  isRecord,
  isSafeDirLabel,
  isSafeMachineName,
  MACHINE_NAME_RULE,
  isSafeWorkdir,
  isStringList,
  PRIORITIES,
  shortSkill,
} from '@agent-board/shared';
import type { Priority } from '@agent-board/shared';

export class ConfigError extends Error {}

// How intake's tasks run: unattended, on PR text nobody chose to read, so with a narrow allow list instead of the user's
// own settings.
export interface IntakeConfig {
  // The task's prompt; {url} is the PR's URL.
  prompt: string;
  priority: Priority;
  allowedTools: string[];
  disallowedTools: string[];
  // Variables the worker copies from the checkout's .claude/settings.json and settings.local.json into the run:
  // intake loads only the user's settings, so tokens and endpoints kept in the checkout would be missing.
  env: string[];
  // MCP servers of the checkout's .mcp.json that intake runs get (with `--mcp-config`), such as "shortcut".
  mcpServers: string[];
}

// Slots of one kind of work on this machine. A lane runs its own skills first (a task's skill is the slash command its
// prompt starts with) and borrows any other work when it has none; it takes its slot back by pausing borrowed work once
// its own work waits. "*" owns every skill no other lane names, and prompts without one.
export interface Lane {
  name: string;
  skills: string[];
  slots: number;
  // Where its tasks run when they have no directory of their own and their prompt names no PR of a known repo.
  cwd?: string;
}

// What a machine does when its CLI is behind the board: "incompatible" updates when the board refuses this CLI,
// "always" also when a newer release exists and no worker runs, "never" leaves it to the user.
export const AUTO_UPDATES = ['incompatible', 'always', 'never'] as const;
export type AutoUpdate = (typeof AUTO_UPDATES)[number];
const isAutoUpdate = (value: unknown): value is AutoUpdate => AUTO_UPDATES.some((mode) => mode === value);

// A directory workers may run in, as listed in config.json under `dirs`, with its optional settings.
export interface DirEntry {
  path: string;
  // Shown with the path in the New task form; sent to the board.
  label?: string;
  // `owner/name`: the directory is the checkout of that repository, like a `repos` entry.
  repo?: string;
  // Tasks without a directory of their own run here, like `defaultCwd`.
  default?: true;
  // A lane of this config: its tasks without a directory run here, like the lane's `cwd`.
  lane?: string;
}

// The settings of a `dirs` entry, in the order the CLI writes and lists them.
export const DIR_SETTINGS = ['label', 'repo', 'default', 'lane'] as const;
export type DirSetting = (typeof DIR_SETTINGS)[number];

export const MAX_DIRS = 200;

export interface Config {
  // This machine's name on the board: it claims tasks under it, and a resume runs only on the machine that ran the session.
  machine: string;
  // In config order. Every skill is in at most one lane, and at most one lane has "*".
  lanes: Lane[];
  // Where a task without a directory of its own runs (one created in the UI).
  defaultCwd: string;
  // A borrowed run is paused for its lane's own work only after it has run this long.
  pauseAfterMinutes: number;
  // A run whose agent made no tool call for this long is stopped as stuck.
  inactivityMinutes: number;
  // A run is stopped after this long however busy it is: a guard against runaways.
  maxRunHours: number;
  autoUpdate: AutoUpdate;
  intake: IntakeConfig;
  // Whether config.json has an `intake` key: the intake timer and `board internal intake` exist only then.
  intakeEnabled: boolean;
  repos: Record<string, string>;
  // The directories workers may run in, in config order; undefined when config.json has no `dirs` key, which is not the
  // same as an empty list: a list that is present will allow only what it names.
  dirs?: DirEntry[];
}

export interface Paths {
  configDir: string;
  configFile: string;
  logDir: string;
  // Per-task records of the Claude sessions this machine started (see sessions.mts).
  sessionDir: string;
  // The checks of waiting tasks this machine runs (see waits.mts).
  waitDir: string;
  // Small state files of the CLI itself, such as when it last offered an update.
  stateDir: string;
}

export function getPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configDir = env['AGENT_BOARD_CONFIG_DIR'] ?? join(homedir(), '.config', 'agent-board');
  const stateDir =
    env['AGENT_BOARD_STATE_DIR'] ?? join(env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'agent-board');
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    logDir: join(stateDir, 'logs'),
    sessionDir: join(stateDir, 'sessions'),
    waitDir: join(stateDir, 'waits'),
    stateDir,
  };
}

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path;
}

// The path a `dirs` key names: `~` expanded, `.` and `..` and a trailing slash resolved away.
export function dirKeyPath(key: string): string | undefined {
  const expanded = expandHome(key);
  return isSafeWorkdir(expanded) ? resolve(expanded) : undefined;
}

const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** What is wrong with `value` as the setting `key` of a directory, or undefined when it is fine. `lanes` are the names the config has. */
export function dirSettingProblem(key: DirSetting, value: unknown, lanes: readonly string[]): string | undefined {
  switch (key) {
    case 'label':
      return typeof value === 'string' && isSafeDirLabel(value) ? undefined : `must be a label of ${DIR_LABEL_RULE}`;
    case 'repo':
      return typeof value === 'string' && REPO_PATTERN.test(value) ? undefined : 'must look like owner/name';
    case 'default':
      return value === true ? undefined : 'must be true (leave the key out for no default)';
    case 'lane':
      return typeof value === 'string' && lanes.includes(value)
        ? undefined
        : `must name a lane of this config (${lanes.join(', ')})`;
  }
}

const isDirSetting = (key: string): key is DirSetting => DIR_SETTINGS.some((setting) => setting === key);

function parseDirs(raw: unknown, lanes: readonly string[]): DirEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ConfigError('config: dirs must be an object keyed by directory');
  if (Object.keys(raw).length > MAX_DIRS) throw new ConfigError(`config: dirs lists more than ${MAX_DIRS} directories`);
  const seen = new Map<string, string>();
  const entries = Object.entries(raw).map(([key, settings]): DirEntry => {
    const shown = JSON.stringify(key.slice(0, 100));
    const path = dirKeyPath(key);
    if (path === undefined) throw new ConfigError(`config: dirs key ${shown} must be an absolute path (or ~/...)`);
    if (!isRecord(settings)) throw new ConfigError(`config: dirs[${shown}] must be an object`);
    const unknown = Object.keys(settings).find((name) => !isDirSetting(name));
    if (unknown !== undefined)
      throw new ConfigError(
        `config: dirs[${shown}] has no setting "${unknown.slice(0, 40)}" (it takes ${DIR_SETTINGS.join(', ')})`,
      );
    const other = seen.get(path);
    if (other !== undefined)
      throw new ConfigError(
        `config: dirs lists ${shown} and ${JSON.stringify(other.slice(0, 100))}, the same directory`,
      );
    seen.set(path, key);
    const entry: DirEntry = { path };
    for (const setting of DIR_SETTINGS) {
      const value = settings[setting];
      if (value === undefined) continue;
      const problem = dirSettingProblem(setting, typeof value === 'string' ? value.trim() : value, lanes);
      if (problem !== undefined) throw new ConfigError(`config: dirs[${shown}].${setting} ${problem}`);
      if (setting === 'default') entry.default = true;
      else entry[setting] = String(value).trim();
    }
    return entry;
  });
  for (const setting of ['repo', 'default', 'lane'] as const) {
    const owners = new Map<string, DirEntry>();
    for (const entry of entries) {
      const value = entry[setting];
      if (value === undefined) continue;
      const name = String(value);
      const first = owners.get(name);
      if (first !== undefined)
        throw new ConfigError(
          setting === 'default'
            ? `config: dirs[${JSON.stringify(first.path)}] and dirs[${JSON.stringify(entry.path)}] are both the default directory; one directory has it`
            : `config: dirs[${JSON.stringify(first.path)}] and dirs[${JSON.stringify(entry.path)}] both set ${setting} "${name.slice(0, 80)}"; one directory has it`,
        );
      owners.set(name, entry);
    }
  }
  return entries;
}

function positiveInt(obj: Record<string, unknown>, key: string, where: string, fallback: number): number {
  if (!(key in obj)) return fallback;
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`config: ${where}${key} must be a positive integer`);
  }
  return value;
}

export const DEFAULT_LANES: Lane[] = [{ name: 'general', skills: ['*'], slots: 3 }];

function parseLanes(raw: unknown): Lane[] {
  if (raw === undefined) return DEFAULT_LANES;
  if (!isRecord(raw) || Object.keys(raw).length === 0)
    throw new ConfigError('config: lanes must be an object with at least one lane');
  const owner = new Map<string, string>();
  return Object.entries(raw).map(([name, entry]): Lane => {
    const where = `lanes.${name}.`;
    if (!isSafeMachineName(name))
      throw new ConfigError(`config: lane name "${name.slice(0, 40)}" must be ${MACHINE_NAME_RULE}`);
    if (!isRecord(entry)) throw new ConfigError(`config: lanes.${name} must be an object`);
    const skills = entry['skills'];
    if (!isStringList(skills) || skills.length === 0)
      throw new ConfigError(`config: ${where}skills must be a non-empty list of skill names (or "*")`);
    for (const skill of skills) {
      const key = skill === '*' ? '*' : shortSkill(skill.replace(/^\//, ''));
      const other = owner.get(key);
      if (other !== undefined)
        throw new ConfigError(
          `config: ${key === '*' ? '"*"' : `skill "${skill}"`} is in lanes ${other} and ${name}; it belongs to one lane`,
        );
      owner.set(key, name);
    }
    const cwd = entry['cwd'];
    if (cwd !== undefined && (typeof cwd !== 'string' || !expandHome(cwd).startsWith('/')))
      throw new ConfigError(`config: ${where}cwd must be an absolute path (or ~/...)`);
    return {
      name,
      skills: skills.map((skill) => (skill === '*' ? '*' : shortSkill(skill.replace(/^\//, '')))),
      slots: positiveInt(entry, 'slots', where, 1),
      ...(cwd === undefined ? {} : { cwd: expandHome(cwd) }),
    };
  });
}

function parseIntake(raw: unknown): IntakeConfig {
  const obj = raw === undefined ? {} : raw;
  if (!isRecord(obj)) throw new ConfigError('config: intake must be an object');
  const prompt = obj['prompt'] ?? '/review-pr {url} --auto';
  if (typeof prompt !== 'string' || !prompt.includes('{url}'))
    throw new ConfigError('config: intake.prompt must be a prompt with {url} in it');
  const priority = obj['priority'] ?? DEFAULT_PRIORITY;
  if (!isPriority(priority)) throw new ConfigError(`config: intake.priority must be one of ${PRIORITIES.join(', ')}`);
  const tools = (key: string): string[] => {
    const value = obj[key] ?? [];
    if (!isStringList(value)) throw new ConfigError(`config: intake.${key} must be a list of strings`);
    return value;
  };
  const env = tools('env');
  const badName = env.find((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (badName !== undefined)
    throw new ConfigError(`config: intake.env names "${badName}", which is not a variable name`);
  return {
    prompt,
    priority,
    allowedTools: tools('allowedTools'),
    disallowedTools: tools('disallowedTools'),
    env,
    mcpServers: tools('mcpServers'),
  };
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new ConfigError('config: top level must be an object');
  const rawRepos = raw['repos'] ?? {};
  if (!isRecord(rawRepos)) throw new ConfigError('config: repos must be an object');
  const repos: Record<string, string> = {};
  for (const [repo, dir] of Object.entries(rawRepos)) {
    if (!REPO_PATTERN.test(repo)) throw new ConfigError(`config: repos key "${repo}" must look like owner/name`);
    if (typeof dir !== 'string' || dir === '') throw new ConfigError(`config: repos.${repo} must be a directory`);
    repos[repo] = expandHome(dir);
  }

  const defaultCwd = raw['defaultCwd'] ?? '~';
  if (typeof defaultCwd !== 'string' || !expandHome(defaultCwd).startsWith('/'))
    throw new ConfigError('config: defaultCwd must be an absolute path (or ~/...)');
  const machine = raw['machine'] ?? hostname().split('.')[0] ?? '';
  if (typeof machine !== 'string' || !isSafeMachineName(machine)) {
    throw new ConfigError(
      `config: machine must be a name of ${MACHINE_NAME_RULE} (defaults to the host name), not "${String(machine).slice(0, 40)}" (${String(machine).length} characters)`,
    );
  }
  const autoUpdate = 'autoUpdate' in raw ? raw['autoUpdate'] : 'incompatible';
  if (!isAutoUpdate(autoUpdate)) throw new ConfigError(`config: autoUpdate must be one of ${AUTO_UPDATES.join(', ')}`);
  const lanes = parseLanes(raw['lanes']);
  const dirs = parseDirs(
    raw['dirs'],
    lanes.map(({ name }) => name),
  );
  // A setting of a directory wins over the old key it stands for, which every other module goes on reading.
  for (const { path, repo } of dirs ?? []) if (repo !== undefined) repos[repo] = path;
  const defaultDir = dirs?.find((entry) => entry.default === true);
  return {
    machine,
    lanes: lanes.map((lane) => {
      const dir = dirs?.find((entry) => entry.lane === lane.name);
      return dir === undefined ? lane : { ...lane, cwd: dir.path };
    }),
    defaultCwd: defaultDir?.path ?? expandHome(defaultCwd),
    pauseAfterMinutes: positiveInt(raw, 'pauseAfterMinutes', '', 5),
    inactivityMinutes: positiveInt(raw, 'inactivityMinutes', '', 15),
    maxRunHours: positiveInt(raw, 'maxRunHours', '', 6),
    autoUpdate,
    intake: parseIntake(raw['intake']),
    intakeEnabled: 'intake' in raw,
    repos,
    ...(dirs === undefined ? {} : { dirs }),
  };
}

// The keys parseConfig reads at each level. Anything else is ignored, so a misspelt key would silently keep its default.
const TOP_KEYS = [
  'machine',
  'lanes',
  'defaultCwd',
  'pauseAfterMinutes',
  'inactivityMinutes',
  'maxRunHours',
  'autoUpdate',
  'intake',
  'repos',
  'dirs',
] as const;
const LANE_KEYS = ['skills', 'slots', 'cwd'] as const;
const INTAKE_KEYS = ['prompt', 'priority', 'allowedTools', 'disallowedTools', 'env', 'mcpServers'] as const;

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function unknownKeys(obj: Record<string, unknown>, known: readonly string[], where: string): string[] {
  return Object.keys(obj)
    .filter((key) => !known.includes(key))
    .map((key) => {
      const [nearest] = known
        .map((name) => ({ name, distance: editDistance(key.toLowerCase(), name.toLowerCase()) }))
        .sort((a, b) => a.distance - b.distance);
      const close = nearest !== undefined && nearest.distance <= Math.max(2, Math.floor(nearest.name.length / 3));
      const shown = JSON.stringify(`${where}${key}`.slice(0, 80));
      return close
        ? `unknown key ${shown}, ignored; did you mean "${where}${nearest.name}"?`
        : `unknown key ${shown}, ignored; known here: ${known.join(', ')}`;
    });
}

const OVERRIDDEN = ' is overridden by ';

export const isOverrideWarning = (warning: string): boolean => warning.includes(OVERRIDDEN);

// A setting of a `dirs` entry that replaces a different path under the old key it stands for: repos, defaultCwd, a lane's cwd.
function overrideWarnings(raw: Record<string, unknown>): string[] {
  const dirs = raw['dirs'];
  if (!isRecord(dirs)) return [];
  const repos = isRecord(raw['repos']) ? raw['repos'] : {};
  const lanes = isRecord(raw['lanes']) ? raw['lanes'] : {};
  return Object.entries(dirs).flatMap(([key, settings]) => {
    const path = dirKeyPath(key);
    if (path === undefined || !isRecord(settings)) return [];
    const shown = JSON.stringify(key.slice(0, 80));
    const elsewhere = (old: unknown): boolean =>
      typeof old === 'string' && old !== '' && resolve(expandHome(old)) !== path;
    const lane = settings['lane'];
    const laneEntry = typeof lane === 'string' ? lanes[lane] : undefined;
    const repo = settings['repo'];
    return [
      ...(typeof repo === 'string' && elsewhere(repos[repo])
        ? [`repos.${repo.slice(0, 80)}${OVERRIDDEN}dirs[${shown}].repo`]
        : []),
      ...(settings['default'] === true && elsewhere(raw['defaultCwd'])
        ? [`defaultCwd${OVERRIDDEN}dirs[${shown}].default`]
        : []),
      ...(typeof lane === 'string' && isRecord(laneEntry) && elsewhere(laneEntry['cwd'])
        ? [`lanes.${lane.slice(0, 40)}.cwd${OVERRIDDEN}dirs[${shown}].lane`]
        : []),
    ];
  });
}

// The keys of a config parseConfig ignores, one line each. Not an error: every machine reads this file, and a key a newer
// or older CLI dropped must not stop its workers; doctor and dispatch print these instead. A `dirs` setting that overrides a
// different path under an old key is listed too.
export function configWarnings(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const warnings = unknownKeys(raw, TOP_KEYS, '');
  const lanes = raw['lanes'];
  if (isRecord(lanes))
    for (const [name, entry] of Object.entries(lanes))
      if (isRecord(entry)) warnings.push(...unknownKeys(entry, LANE_KEYS, `lanes.${name.slice(0, 40)}.`));
  const intake = raw['intake'];
  if (isRecord(intake)) warnings.push(...unknownKeys(intake, INTAKE_KEYS, 'intake.'));
  warnings.push(...overrideWarnings(raw));
  return warnings;
}

// configWarnings for the file at path; nothing when it is missing or does not parse, which loadConfig reports.
export function loadConfigWarnings(path: string): string[] {
  try {
    return configWarnings(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return [];
  }
}

export function loadConfig(path: string, options: { optionalConfig?: boolean } = {}): Config {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    if (!missing) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error';
      throw new ConfigError(`cannot read the config file ${path} (${code})`);
    }
    if (options.optionalConfig) return parseConfig({});
    throw new ConfigError(`config file missing: ${path} (run "board init")`);
  }
  try {
    return parseConfig(JSON.parse(content));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConfigError(`config file is not valid JSON: ${path}`);
    throw error;
  }
}

export function isSafeMode(mode: number): boolean {
  const permissions = mode & 0o777;
  return permissions === 0o600 || permissions === 0o400;
}

// Reads a file that holds a secret, refusing anything readable by group or others.
export function readSecretFile(path: string, what: string): string {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new ConfigError(`${what} missing: ${path}`);
  }
  if (!isSafeMode(mode)) {
    throw new ConfigError(`${what} must be mode 600 or 400, is ${(mode & 0o777).toString(8)}: ${path}`);
  }
  return readFileSync(path, 'utf8');
}
