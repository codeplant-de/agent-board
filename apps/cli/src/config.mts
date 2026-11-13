import { readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { DEFAULT_PRIORITY, isPriority, isRecord, isSafeMachineName, PRIORITIES } from "@agent-board/shared";
import type { Priority } from "@agent-board/shared";

export class ConfigError extends Error {}

export type LabelEntry =
  | {
      kind: "skill";
      skill: string;
      allowedTools: string[];
      disallowedTools: string[];
      // "pr-repo" runs in the checkout that `repos` maps the PR's repository to.
      cwd: string;
    }
  | { kind: "command"; command: string[]; cwd: string | undefined };

// Slots of one kind of work on this machine. A lane runs its own labels first and borrows any other work when it has
// none; it takes its slot back by pausing borrowed work once its own work waits.
export interface Lane {
  name: string;
  labels: string[];
  slots: number;
}

export interface Config {
  // Executable and fixed arguments of the task backend; the core appends the contract's subcommand.
  backendCommand: string[];
  // This machine's name on the board: it claims tasks under it, and a resume runs only on the machine that ran the session.
  machine: string;
  // In config order. Every label is in at most one lane; a label in none is only ever borrowed.
  lanes: Lane[];
  // A borrowed run is paused for its lane's own work only after it has run this long.
  pauseAfterMinutes: number;
  // A run whose agent made no tool call for this long is stopped as stuck.
  inactivityMinutes: number;
  // A run is stopped after this long however busy it is: a guard against runaways.
  maxRunHours: number;
  slackWebhookFile: string;
  intakeLabel: string;
  // Priority of the tasks intake creates.
  intakePriority: Priority;
  labels: Record<string, LabelEntry>;
  repos: Record<string, string>;
}

export interface Paths {
  configDir: string;
  configFile: string;
  logDir: string;
}

export function getPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configDir = env["AGENT_BOARD_CONFIG_DIR"] ?? join(homedir(), ".config", "agent-board");
  const stateDir =
    env["AGENT_BOARD_STATE_DIR"] ?? join(env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "agent-board");
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    logDir: join(stateDir, "logs"),
  };
}

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function field(obj: Record<string, unknown>, key: string, where: string): unknown {
  if (!(key in obj)) throw new ConfigError(`config: ${where}${key} is missing`);
  return obj[key];
}

function text(obj: Record<string, unknown>, key: string, where: string): string {
  const value = field(obj, key, where);
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`config: ${where}${key} must be a non-empty string`);
  }
  return value;
}

function positiveInt(obj: Record<string, unknown>, key: string, where: string, fallback: number): number {
  if (!(key in obj)) return fallback;
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`config: ${where}${key} must be a positive integer`);
  }
  return value;
}

function parseLabelEntry(name: string, raw: unknown): LabelEntry {
  const where = `labels.${name}.`;
  if (!isRecord(raw)) throw new ConfigError(`config: labels.${name} must be an object`);
  const cwd = raw["cwd"];
  if (cwd !== undefined && (typeof cwd !== "string" || cwd === "")) {
    throw new ConfigError(`config: ${where}cwd must be a non-empty string`);
  }
  if ("command" in raw) {
    const command = raw["command"];
    if (!isStringList(command) || command.length === 0) {
      throw new ConfigError(`config: ${where}command must be a non-empty list of strings`);
    }
    return { kind: "command", command, cwd };
  }
  const skill = text(raw, "skill", where);
  const tools = (key: string): string[] => {
    const value = raw[key] ?? [];
    if (!isStringList(value)) throw new ConfigError(`config: ${where}${key} must be a list of strings`);
    return value;
  };
  const allowedTools = tools("allowedTools");
  if (allowedTools.length === 0) throw new ConfigError(`config: ${where}allowedTools must not be empty`);
  return {
    kind: "skill",
    skill,
    allowedTools,
    disallowedTools: tools("disallowedTools"),
    cwd: cwd ?? "pr-repo",
  };
}

// An absolute path or a bare command name. A relative path with a slash would depend on the cwd of whoever runs it.
function parseExecutable(command: string[], where: string): string[] {
  const [file] = command;
  if (file !== undefined && file.includes("/") && !file.startsWith("/")) {
    throw new ConfigError(`config: ${where}[0] must be an absolute path (or ~/...) or a bare command name, not "${file}"`);
  }
  return command;
}

function parseBackendCommand(raw: unknown): string[] {
  const command = isRecord(raw) ? raw["command"] : undefined;
  if (!isStringList(command) || command.length === 0 || command.some((part) => part === "")) {
    throw new ConfigError("config: backend.command must be a non-empty list of strings");
  }
  return parseExecutable(command.map(expandHome), "backend.command");
}

function parseLanes(raw: unknown, labels: Record<string, LabelEntry>): Lane[] {
  // Without lanes, one lane runs everything, as before lanes existed.
  if (raw === undefined) return [{ name: "default", labels: Object.keys(labels), slots: 2 }];
  if (!isRecord(raw) || Object.keys(raw).length === 0) throw new ConfigError("config: lanes must be an object with at least one lane");
  const owner = new Map<string, string>();
  return Object.entries(raw).map(([name, entry]): Lane => {
    const where = `lanes.${name}.`;
    if (!isSafeMachineName(name)) throw new ConfigError(`config: lane name "${name}" must be letters, digits, '.', '-' and '_'`);
    if (!isRecord(entry)) throw new ConfigError(`config: lanes.${name} must be an object`);
    const laneLabels = entry["labels"];
    if (!isStringList(laneLabels) || laneLabels.length === 0) throw new ConfigError(`config: ${where}labels must be a non-empty list of labels`);
    for (const label of laneLabels) {
      if (!Object.hasOwn(labels, label)) throw new ConfigError(`config: ${where}labels names "${label}", which is not in labels`);
      const other = owner.get(label);
      if (other !== undefined) throw new ConfigError(`config: label "${label}" is in lanes ${other} and ${name}; a label belongs to one lane`);
      owner.set(label, name);
    }
    return { name, labels: laneLabels, slots: positiveInt(entry, "slots", where, 1) };
  });
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new ConfigError("config: top level must be an object");
  const rawLabels = field(raw, "labels", "");
  if (!isRecord(rawLabels) || Object.keys(rawLabels).length === 0) {
    throw new ConfigError("config: labels must be an object with at least one entry");
  }
  const labels: Record<string, LabelEntry> = {};
  for (const [name, entry] of Object.entries(rawLabels)) labels[name] = parseLabelEntry(name, entry);

  const rawRepos = raw["repos"] ?? {};
  if (!isRecord(rawRepos)) throw new ConfigError("config: repos must be an object");
  const repos: Record<string, string> = {};
  for (const [repo, dir] of Object.entries(rawRepos)) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ConfigError(`config: repos key "${repo}" must look like owner/name`);
    if (typeof dir !== "string" || dir === "") throw new ConfigError(`config: repos.${repo} must be a directory`);
    repos[repo] = expandHome(dir);
  }

  const intakeLabel = typeof raw["intakeLabel"] === "string" ? raw["intakeLabel"] : "review-pr";
  const intakePriority = raw["intakePriority"] ?? DEFAULT_PRIORITY;
  if (!isPriority(intakePriority)) throw new ConfigError(`config: intakePriority must be one of ${PRIORITIES.join(", ")}`);
  const webhook = raw["slackWebhookFile"] ?? "~/.config/watch-review-requests/slack-webhook";
  if (typeof webhook !== "string") throw new ConfigError("config: slackWebhookFile must be a path");
  for (const [name, entry] of Object.entries(labels)) {
    if (entry.kind === "skill" && entry.cwd === "pr-repo" && Object.keys(repos).length === 0) {
      throw new ConfigError(`config: labels.${name} runs in the PR's repo, so repos must not be empty`);
    }
  }
  const machine = raw["machine"] ?? hostname().split(".")[0] ?? "";
  if (typeof machine !== "string" || !isSafeMachineName(machine)) {
    throw new ConfigError("config: machine must be a name of letters, digits, '.', '-' and '_' (defaults to the host name)");
  }
  return {
    backendCommand: parseBackendCommand(field(raw, "backend", "")),
    machine,
    lanes: parseLanes(raw["lanes"], labels),
    pauseAfterMinutes: positiveInt(raw, "pauseAfterMinutes", "", 5),
    inactivityMinutes: positiveInt(raw, "inactivityMinutes", "", 15),
    maxRunHours: positiveInt(raw, "maxRunHours", "", 6),
    slackWebhookFile: expandHome(webhook),
    intakeLabel,
    intakePriority,
    labels,
    repos,
  };
}

export function loadConfig(path: string): Config {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`config file missing: ${path} (copy config.example.json there)`);
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
  return readFileSync(path, "utf8");
}
