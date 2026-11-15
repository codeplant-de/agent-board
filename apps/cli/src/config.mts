import { readFileSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PRIORITY,
  isPriority,
  isRecord,
  isSafeMachineName,
  MACHINE_NAME_RULE,
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
  slackWebhookFile: string;
  autoUpdate: AutoUpdate;
  intake: IntakeConfig;
  repos: Record<string, string>;
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
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo))
      throw new ConfigError(`config: repos key "${repo}" must look like owner/name`);
    if (typeof dir !== 'string' || dir === '') throw new ConfigError(`config: repos.${repo} must be a directory`);
    repos[repo] = expandHome(dir);
  }

  const webhook = raw['slackWebhookFile'] ?? '~/.config/watch-review-requests/slack-webhook';
  if (typeof webhook !== 'string') throw new ConfigError('config: slackWebhookFile must be a path');
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
  return {
    machine,
    lanes: parseLanes(raw['lanes']),
    defaultCwd: expandHome(defaultCwd),
    pauseAfterMinutes: positiveInt(raw, 'pauseAfterMinutes', '', 5),
    inactivityMinutes: positiveInt(raw, 'inactivityMinutes', '', 15),
    maxRunHours: positiveInt(raw, 'maxRunHours', '', 6),
    slackWebhookFile: expandHome(webhook),
    autoUpdate,
    intake: parseIntake(raw['intake']),
    repos,
  };
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
