import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./guards.mts";

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

export interface Config {
  // Executable and fixed arguments of the task backend; the core appends the contract's subcommand.
  backendCommand: string[];
  maxParallel: number;
  timeoutMinutes: number;
  slackWebhookFile: string;
  intakeLabel: string;
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
  return { kind: "skill", skill, allowedTools, disallowedTools: tools("disallowedTools"), cwd: cwd ?? "pr-repo" };
}

function parseBackendCommand(raw: unknown): string[] {
  const command = isRecord(raw) ? raw["command"] : undefined;
  if (!isStringList(command) || command.length === 0 || command.some((part) => part === "")) {
    throw new ConfigError("config: backend.command must be a non-empty list of strings");
  }
  return command.map(expandHome);
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
  const webhook = raw["slackWebhookFile"] ?? "~/.config/watch-review-requests/slack-webhook";
  if (typeof webhook !== "string") throw new ConfigError("config: slackWebhookFile must be a path");
  for (const [name, entry] of Object.entries(labels)) {
    if (entry.kind === "skill" && entry.cwd === "pr-repo" && Object.keys(repos).length === 0) {
      throw new ConfigError(`config: labels.${name} runs in the PR's repo, so repos must not be empty`);
    }
  }
  return {
    backendCommand: parseBackendCommand(field(raw, "backend", "")),
    maxParallel: positiveInt(raw, "maxParallel", "", 2),
    timeoutMinutes: positiveInt(raw, "timeoutMinutes", "", 45),
    slackWebhookFile: expandHome(webhook),
    intakeLabel,
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
