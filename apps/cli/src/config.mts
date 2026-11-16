import { readFileSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_PRIORITY,
  isPriority,
  isRecord,
  isSafeMachineName,
  MACHINE_NAME_RULE,
  isSafeWorkdir,
  isStringList,
  PRIORITIES,
  promptSkill,
  shortSkill,
} from '@agent-board/shared';
import type { Priority } from '@agent-board/shared';

export class ConfigError extends Error {}

// What the built-in review intake creates: its prompt and priority. What its tasks may do is the profile of the prompt's
// skill in `skills`.
export interface IntakeConfig {
  // The task's prompt; {url} is the PR's URL.
  prompt: string;
  priority: Priority;
}

// What a restricted task of one skill (one sealed `createdBy: 'intake'`) may do. It runs unattended on text nobody chose to
// read, so with a narrow allow list instead of the user's own settings.
export interface SkillProfile {
  allowedTools: string[];
  disallowedTools: string[];
  // Variables the worker copies from the run directory's .claude/settings.json and settings.local.json into the run:
  // a restricted run loads only the user's settings, so tokens and endpoints kept in the checkout would be missing.
  env: string[];
  // MCP servers of the run directory's .mcp.json that the run gets (with `--mcp-config`), such as "shortcut".
  mcpServers: string[];
  // Where its tasks run, before the checkout of the PR they name and the lane's cwd.
  cwd?: string;
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

// A directory workers may run in, as listed in config.json under `dirs`. An object, so later per-directory settings fit.
export interface DirEntry {
  path: string;
}

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
  // The profiles of restricted tasks, by short skill name (see `profileFor` in decide.mts). A restricted task of a skill
  // without one does not run.
  skills: Record<string, SkillProfile>;
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

function parseDirs(raw: unknown): DirEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ConfigError('config: dirs must be an object keyed by directory');
  if (Object.keys(raw).length > MAX_DIRS) throw new ConfigError(`config: dirs lists more than ${MAX_DIRS} directories`);
  const seen = new Map<string, string>();
  return Object.entries(raw).map(([key, settings]): DirEntry => {
    const shown = JSON.stringify(key.slice(0, 100));
    const path = dirKeyPath(key);
    if (path === undefined) throw new ConfigError(`config: dirs key ${shown} must be an absolute path (or ~/...)`);
    if (!isRecord(settings)) throw new ConfigError(`config: dirs[${shown}] must be an object`);
    const [unknown] = Object.keys(settings);
    if (unknown !== undefined)
      throw new ConfigError(`config: dirs[${shown}] has no setting "${unknown.slice(0, 40)}" (it takes none yet)`);
    const other = seen.get(path);
    if (other !== undefined)
      throw new ConfigError(
        `config: dirs lists ${shown} and ${JSON.stringify(other.slice(0, 100))}, the same directory`,
      );
    seen.set(path, key);
    return { path };
  });
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

export const INTAKE_LIST_KEYS = ['allowedTools', 'disallowedTools', 'env', 'mcpServers'] as const;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
const PROFILE_KEYS = new Set<string>([...INTAKE_LIST_KEYS, 'cwd']);

function parseIntake(raw: unknown): IntakeConfig {
  const obj = raw === undefined ? {} : raw;
  if (!isRecord(obj)) throw new ConfigError('config: intake must be an object');
  const prompt = obj['prompt'] ?? '/review-pr {url} --auto';
  if (typeof prompt !== 'string' || !prompt.includes('{url}'))
    throw new ConfigError('config: intake.prompt must be a prompt with {url} in it');
  const priority = obj['priority'] ?? DEFAULT_PRIORITY;
  if (!isPriority(priority)) throw new ConfigError(`config: intake.priority must be one of ${PRIORITIES.join(', ')}`);
  if (INTAKE_LIST_KEYS.some((key) => key in obj) && promptSkill(prompt) === undefined)
    throw new ConfigError(
      'config: intake.prompt must start with a /skill: its tasks run under skills.<skill>, and the intake lists would be dropped',
    );
  return { prompt, priority };
}

function parseProfile(raw: unknown, where: string): SkillProfile {
  if (!isRecord(raw)) throw new ConfigError(`config: ${where} must be an object`);
  const unknown = Object.keys(raw).find((key) => !PROFILE_KEYS.has(key));
  if (unknown !== undefined)
    throw new ConfigError(
      `config: ${where} has the unknown key "${unknown.slice(0, 40)}" (known: ${[...PROFILE_KEYS].join(', ')})`,
    );
  const list = (key: string): string[] => {
    const value = raw[key] ?? [];
    if (!isStringList(value)) throw new ConfigError(`config: ${where}.${key} must be a list of strings`);
    return value;
  };
  const env = list('env');
  const badName = env.find((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (badName !== undefined)
    throw new ConfigError(`config: ${where}.env names "${badName}", which is not a variable name`);
  const cwd = raw['cwd'];
  if (cwd !== undefined && (typeof cwd !== 'string' || !expandHome(cwd).startsWith('/')))
    throw new ConfigError(`config: ${where}.cwd must be an absolute path (or ~/...)`);
  return {
    allowedTools: list('allowedTools'),
    disallowedTools: list('disallowedTools'),
    env,
    mcpServers: list('mcpServers'),
    ...(cwd === undefined ? {} : { cwd: expandHome(cwd) }),
  };
}

// The skills' profiles. The `intake` block's tool lists are the old home of the profile of its prompt's skill, read for
// one more release.
function parseSkills(raw: unknown, rawIntake: unknown, intake: IntakeConfig): Record<string, SkillProfile> {
  if (raw !== undefined && !isRecord(raw)) throw new ConfigError('config: skills must be an object');
  const owner = new Map<string, string>();
  const profiles = new Map<string, SkillProfile>();
  for (const [name, entry] of Object.entries(raw ?? {})) {
    const key = shortSkill(name.replace(/^\//, ''));
    if (!SKILL_NAME.test(name.replace(/^\//, '')) || key === '' || key.startsWith('_'))
      throw new ConfigError(`config: skills key "${name.slice(0, 40)}" is not a skill name`);
    const other = owner.get(key);
    if (other !== undefined)
      throw new ConfigError(`config: skills.${other} and skills.${name} are the same skill ("${key}")`);
    owner.set(key, name);
    profiles.set(key, parseProfile(entry, `skills.${name}`));
  }
  if (isRecord(rawIntake) && INTAKE_LIST_KEYS.some((key) => key in rawIntake)) {
    const skill = promptSkill(intake.prompt);
    if (skill !== undefined) {
      const key = shortSkill(skill);
      const named = owner.get(key);
      if (named !== undefined)
        throw new ConfigError(
          `config: intake lists and skills.${named} both set the rules of "${key}"; move the intake lists into skills.${named} and remove them`,
        );
      profiles.set(
        key,
        parseProfile(
          Object.fromEntries(INTAKE_LIST_KEYS.flatMap((k) => (k in rawIntake ? [[k, rawIntake[k]]] : []))),
          'intake',
        ),
      );
    }
  }
  return Object.fromEntries(profiles);
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new ConfigError('config: top level must be an object');
  const rawRepos = raw['repos'] ?? {};
  if (!isRecord(rawRepos)) throw new ConfigError('config: repos must be an object');
  const repos: Record<string, string> = {};
  for (const [repo, dir] of Object.entries(rawRepos)) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo))
      throw new ConfigError(`config: repos key "${repo}" must look like owner/name`);
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
  const intake = parseIntake(raw['intake']);
  const dirs = parseDirs(raw['dirs']);
  return {
    machine,
    lanes: parseLanes(raw['lanes']),
    defaultCwd: expandHome(defaultCwd),
    pauseAfterMinutes: positiveInt(raw, 'pauseAfterMinutes', '', 5),
    inactivityMinutes: positiveInt(raw, 'inactivityMinutes', '', 15),
    maxRunHours: positiveInt(raw, 'maxRunHours', '', 6),
    autoUpdate,
    intake,
    skills: parseSkills(raw['skills'], raw['intake'], intake),
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
  'skills',
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

// The keys of a config parseConfig ignores, one line each. Not an error: every machine reads this file, and a key a newer
// or older CLI dropped must not stop its workers; doctor and dispatch print these instead.
export function configWarnings(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const warnings = unknownKeys(raw, TOP_KEYS, '');
  const lanes = raw['lanes'];
  if (isRecord(lanes))
    for (const [name, entry] of Object.entries(lanes))
      if (isRecord(entry)) warnings.push(...unknownKeys(entry, LANE_KEYS, `lanes.${name.slice(0, 40)}.`));
  const intake = raw['intake'];
  if (isRecord(intake)) warnings.push(...unknownKeys(intake, INTAKE_KEYS, 'intake.'));
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
