import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isRecord } from "@agent-board/shared";

export class PluginError extends Error {}

const CLAUDE_PLUGINS_DIR = join(homedir(), ".claude", "plugins");
export const INSTALLED_PLUGINS_FILE = join(CLAUDE_PLUGINS_DIR, "installed_plugins.json");
export const KNOWN_MARKETPLACES_FILE = join(CLAUDE_PLUGINS_DIR, "known_marketplaces.json");

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

// known_marketplaces.json maps a marketplace name to its source. Only a directory source has a root to return.
export function parseDirectoryMarketplace(raw: unknown, marketplace: string): string | undefined {
  const entry = isRecord(raw) ? raw[marketplace] : undefined;
  const source = isRecord(entry) ? entry["source"] : undefined;
  if (!isRecord(source) || source["source"] !== "directory") return undefined;
  const path = source["path"];
  return typeof path === "string" && isAbsolute(path) ? path : undefined;
}

// `<root>/.claude-plugin/marketplace.json` lists the plugins with a `source` relative to the marketplace root.
export function parseMarketplaceSource(raw: unknown, plugin: string): string | undefined {
  const plugins = isRecord(raw) ? raw["plugins"] : undefined;
  if (!Array.isArray(plugins)) return undefined;
  for (const entry of plugins) {
    if (!isRecord(entry) || entry["name"] !== plugin) continue;
    const source = entry["source"];
    return typeof source === "string" && source.startsWith("./") ? source : undefined;
  }
  return undefined;
}

export interface PluginFiles {
  installedPlugins: unknown;
  knownMarketplaces: unknown;
  // The parsed marketplace manifest of a directory marketplace; undefined when it cannot be read.
  marketplaceManifest: (root: string) => unknown;
  dirExists: (path: string) => boolean;
}

// The root Claude Code gives a plugin as ${CLAUDE_PLUGIN_ROOT}. For a plugin from a directory marketplace Claude
// Code loads it straight from that directory, not from the cache copy that installed_plugins.json points at
// (checked against Claude Code 2.1.x: the Skill tool reports the checkout's path as the base directory).
export function resolvePluginRoot(key: string, files: PluginFiles): string {
  const at = key.lastIndexOf("@");
  if (at <= 0) throw new PluginError(`plugin key ${key} is not <plugin>@<marketplace>`);
  const plugin = key.slice(0, at);
  const marketplace = key.slice(at + 1);
  const marketplaceRoot = parseDirectoryMarketplace(files.knownMarketplaces, marketplace);
  if (marketplaceRoot !== undefined) {
    const source = parseMarketplaceSource(files.marketplaceManifest(marketplaceRoot), plugin);
    if (source !== undefined) {
      const dir = resolve(marketplaceRoot, source);
      // A source such as "./../x" must not leave the marketplace.
      if (dir.startsWith(marketplaceRoot + sep) && files.dirExists(dir)) return dir;
    }
  }
  return parseInstallPath(files.installedPlugins, key);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function resolvePluginPath(key: string): string {
  const installedPlugins = readJson(INSTALLED_PLUGINS_FILE);
  if (installedPlugins === undefined) throw new PluginError(`cannot read ${INSTALLED_PLUGINS_FILE}`);
  return resolvePluginRoot(key, {
    installedPlugins,
    knownMarketplaces: readJson(KNOWN_MARKETPLACES_FILE),
    marketplaceManifest: (root) => readJson(join(root, ".claude-plugin", "marketplace.json")),
    dirExists: existsSync,
  });
}
