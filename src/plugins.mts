import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./guards.mts";

export class PluginError extends Error {}

export const INSTALLED_PLUGINS_FILE = join(homedir(), ".claude", "plugins", "installed_plugins.json");

// installed_plugins.json maps "<plugin>@<marketplace>" to a list of installs, each with an installPath.
export function parseInstallPath(raw: unknown, key: string): string {
  const plugins = isRecord(raw) ? raw["plugins"] : undefined;
  const installs = isRecord(plugins) ? plugins[key] : undefined;
  if (!Array.isArray(installs)) throw new PluginError(`plugin ${key} is not installed`);
  for (const install of installs) {
    const path = isRecord(install) ? install["installPath"] : undefined;
    if (typeof path === "string" && path.startsWith("/")) return path;
  }
  throw new PluginError(`plugin ${key} has no usable installPath`);
}

export function resolveInstallPath(key: string, file: string = INSTALLED_PLUGINS_FILE): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PluginError(`cannot read ${file}`);
  }
  return parseInstallPath(raw, key);
}
