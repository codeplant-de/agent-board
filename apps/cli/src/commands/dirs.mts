import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRecord } from '@agent-board/shared';
import type { Backend, Schedule, Task } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { ConfigError, dirKeyPath, expandHome, MAX_DIRS, parseConfig } from '../config/config.mts';
import type { Config, DirEntry } from '../config/config.mts';
import { plainLine } from '../output/terminal.mts';

export const FIRST_ADD_NOTE = [
  'created the dirs list: workers on this machine now run tasks only in listed directories.',
  '"board dirs add --from-config" adds the directories this config already routes to.',
];
export const STOP_NOTE = 'stops in Needs me at its next start';
export const EMPTY_NOTE = 'it allows nothing, so every task on this machine will stop in Needs me';
export const UNCOVERED_HINT = 'tasks routed there stop in Needs me';

/** The listed entry that equals `path` or is a parent of it, by path segment; the longest wins. `path` should be a realpath. */
export function coveringDir(dirs: readonly DirEntry[], path: string): DirEntry | undefined {
  const covers = (entry: DirEntry): boolean =>
    path === entry.path || path.startsWith(entry.path.endsWith('/') ? entry.path : `${entry.path}/`);
  return dirs
    .filter(covers)
    .reduce<DirEntry | undefined>(
      (best, entry) => (best === undefined || entry.path.length > best.path.length ? entry : best),
      undefined,
    );
}

/** The realpath of an existing path, or undefined when it is not there. */
export function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Whether workers may run in `path`: always without a `dirs` list, else when the real path of `path` is in a listed
 * directory, compared with the entry as written and with its real path. A path that is not there is not allowed.
 */
export function isAllowedDir(
  dirs: readonly DirEntry[] | undefined,
  path: string,
  realpath: (path: string) => string | undefined = tryRealpath,
): boolean {
  if (dirs === undefined) return true;
  const real = realpath(path);
  if (real === undefined) return false;
  const resolved = dirs.flatMap(({ path: entry }) => {
    const realEntry = realpath(entry);
    return realEntry === undefined || realEntry === entry ? [] : [{ path: realEntry }];
  });
  return coveringDir([...dirs, ...resolved], real) !== undefined;
}

export function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

// One key of `dirs` as written in the file, and the path it names.
interface DirKey {
  key: string;
  path: string;
}

interface ConfigFile {
  raw: Record<string, unknown>;
  config: Config;
  mode: number;
  // undefined: no `dirs` key.
  keys: DirKey[] | undefined;
}

function readConfigFile(configFile: string): ConfigFile {
  let text: string;
  let mode: number;
  try {
    text = readFileSync(configFile, 'utf8');
    mode = statSync(configFile).mode & 0o777;
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    throw new ConfigError(
      missing
        ? `config file missing: ${configFile} (run "board init")`
        : `cannot read the config file ${configFile} (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown error'})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`config file is not valid JSON: ${configFile}; fix it before changing the dirs list`);
  }
  const config = parseConfig(raw);
  if (!isRecord(raw)) throw new ConfigError('config: top level must be an object');
  const rawDirs = raw['dirs'];
  const keys = isRecord(rawDirs)
    ? Object.keys(rawDirs).flatMap((key) => {
        const path = dirKeyPath(key);
        return path === undefined ? [] : [{ key, path }];
      })
    : undefined;
  return { raw, config, mode, keys };
}

/**
 * Rewrites the `dirs` key of config.json and nothing else: the file is read again here, `change` maps the keys now in it to
 * the keys to keep, and the result is written beside the file and renamed over it, with the file's mode. The file is
 * rewritten as JSON with 2 spaces, so hand formatting is lost; every other key keeps its value and its place.
 */
export function changeDirs(configFile: string, change: (keys: DirKey[]) => string[]): void {
  // A config.json that is a link (a dotfiles checkout) is changed where it points, not replaced by a plain file.
  const target = tryRealpath(configFile) ?? configFile;
  const { raw, mode, keys } = readConfigFile(target);
  const next = change(keys ?? []);
  const dirs = Object.fromEntries(next.map((key) => [key, {}]));
  const temp = `${target}.tmp-${process.pid}`;
  try {
    rmSync(temp, { force: true });
    writeFileSync(temp, `${JSON.stringify({ ...raw, dirs }, null, 2)}\n`, { mode, flag: 'wx' });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

export interface DirsDeps {
  configFile: string;
  cwd: string;
  home: string;
  dryRun: boolean;
  print: (line: string) => void;
  // Only `rm` asks the board.
  backend: Pick<Backend, 'listTasks' | 'listSchedules'>;
  bold?: (text: string) => string;
}

export interface DirsAddFlags {
  fromConfig?: boolean;
}

export interface DirsRemoveFlags {
  force?: boolean;
}

function warn(deps: DirsDeps, line: string): void {
  deps.print(`warning: ${line}`);
}

// What a typed path means: relative to the working directory, `~` expanded.
const absolute = (deps: DirsDeps, path: string | undefined): string =>
  path === undefined ? deps.cwd : resolve(deps.cwd, expandHome(path));

function write(deps: DirsDeps, line: string, change: (keys: DirKey[]) => string[]): void {
  if (deps.dryRun) deps.print(`DRY ${line} (in ${deps.configFile})`);
  else changeDirs(deps.configFile, change);
}

export function dirsList(deps: DirsDeps): void {
  const { config } = readConfigFile(deps.configFile);
  const bold = deps.bold ?? ((text: string) => text);
  if (config.dirs === undefined) {
    deps.print(
      'no directories are listed: the dirs key is not set, so workers on this machine may run in any directory.',
    );
    deps.print(
      `"board dirs add" lists the current directory; "board dirs add --from-config" lists those the config routes to.`,
    );
    return;
  }
  deps.print(bold(`dirs (${config.dirs.length}), enforced: workers on this machine run only in these`));
  for (const { path } of config.dirs) deps.print(`  ${plainLine(path)}${isDirectory(path) ? '' : '  missing'}`);
}

function refusal(path: string, real: string | undefined): string | undefined {
  if (real === undefined || !isDirectory(real)) return `${plainLine(path)} is not an existing directory`;
  if (real === '/') return '/ would allow every directory; list the directories you work in';
  return undefined;
}

const isHome = (deps: DirsDeps, real: string): boolean => real === (tryRealpath(deps.home) ?? deps.home);

export function dirsAdd(deps: DirsDeps, path: string | undefined, flags: DirsAddFlags = {}): void {
  if (flags.fromConfig) {
    if (path !== undefined) throw new UsageError('--from-config takes no path');
    return addFromConfig(deps);
  }
  const { config } = readConfigFile(deps.configFile);
  const entries = config.dirs ?? [];
  const wanted = absolute(deps, path);
  const real = tryRealpath(wanted);
  const refused = refusal(wanted, real);
  if (refused !== undefined || real === undefined) throw new UsageError(refused ?? `${wanted} is not there`);
  const listed = entries.find((entry) => entry.path === real || tryRealpath(entry.path) === real);
  if (listed !== undefined) {
    deps.print(`${plainLine(real)} is already listed`);
    return;
  }
  if (entries.length >= MAX_DIRS)
    throw new UsageError(`the list already has ${MAX_DIRS} directories, the most it can hold`);
  const parent = coveringDir(entries, real);
  if (isHome(deps, real)) warn(deps, `${real} is your home directory: listing it allows every directory below it`);
  write(deps, `list ${real}`, (keys) => [...keys.map(({ key }) => key), real]);
  if (deps.dryRun) return;
  deps.print(`listed ${real}`);
  if (parent !== undefined) deps.print(`note: it was already allowed through ${plainLine(parent.path)}`);
  if (config.dirs === undefined) for (const line of FIRST_ADD_NOTE) deps.print(line);
}

// Where the config sends work: the default directory, every lane's, every repo's checkout.
export function routedDirs(config: Config): { label: string; path: string }[] {
  return [
    { label: 'defaultCwd', path: config.defaultCwd },
    ...config.lanes.flatMap(({ name, cwd }) => (cwd === undefined ? [] : [{ label: `lane ${name} cwd`, path: cwd }])),
    ...Object.entries(config.repos).map(([repo, path]) => ({ label: `repos ${repo}`, path })),
  ];
}

function addFromConfig(deps: DirsDeps): void {
  const { config } = readConfigFile(deps.configFile);
  const entries = config.dirs ?? [];
  const added: string[] = [];
  const known: DirEntry[] = [...entries];
  for (const { label, path } of routedDirs(config)) {
    const real = tryRealpath(path);
    const shown = `${label}: ${plainLine(path)}`;
    if (real === undefined || !isDirectory(real)) {
      deps.print(`skipped ${shown} (not an existing directory)`);
    } else if (real === '/' || isHome(deps, real)) {
      deps.print(
        `skipped ${shown} (${real === '/' ? '/' : 'your home directory'} would allow too much; list the directories you work in)`,
      );
    } else {
      const covering = coveringDir(known, real);
      if (covering !== undefined) {
        deps.print(`skipped ${shown} (already allowed through ${plainLine(covering.path)})`);
      } else {
        known.push({ path: real });
        added.push(real);
        deps.print(`${deps.dryRun ? 'would list' : 'listed'} ${shown}${real === path ? '' : ` (${plainLine(real)})`}`);
      }
    }
  }
  if (added.length === 0) return;
  if (entries.length + added.length > MAX_DIRS)
    throw new UsageError(
      `that would make ${entries.length + added.length} directories, more than the ${MAX_DIRS} the list can hold`,
    );
  write(deps, `list ${added.length} directories`, (keys) => [...keys.map(({ key }) => key), ...added]);
  if (!deps.dryRun && config.dirs === undefined) for (const line of FIRST_ADD_NOTE) deps.print(line);
}

interface Users {
  tasks: Task[];
  schedules: Schedule[];
}

// The work of this machine that runs in `removed` and nowhere else the remaining entries allow.
export function workLosingDir(
  machine: string,
  removed: DirEntry,
  remaining: readonly DirEntry[],
  work: Users,
): { tasks: Task[]; schedules: Schedule[] } {
  const loses = (workdir: string | null): boolean =>
    workdir !== null && coveringDir([removed], workdir) !== undefined && coveringDir(remaining, workdir) === undefined;
  return {
    tasks: work.tasks.filter(
      (task) => !task.closed && task.status !== 'done' && task.machine === machine && loses(task.workdir),
    ),
    schedules: work.schedules.filter(
      (schedule) => !schedule.ended && schedule.machine === machine && loses(schedule.workdir),
    ),
  };
}

export async function dirsRemove(deps: DirsDeps, path: string | undefined, flags: DirsRemoveFlags = {}): Promise<void> {
  const { config } = readConfigFile(deps.configFile);
  if (config.dirs === undefined) throw new UsageError('no directories are listed');
  const wanted = absolute(deps, path);
  const real = tryRealpath(wanted);
  const match =
    real === undefined
      ? config.dirs.find((entry) => entry.path === wanted)
      : config.dirs.find((entry) => entry.path === real || tryRealpath(entry.path) === real);
  if (match === undefined) throw new UsageError(`${plainLine(real ?? wanted)} is not listed`);
  const remaining = config.dirs.filter((entry) => entry !== match);
  if (flags.force !== true) {
    const losing = await losingWork(deps, config.machine, match, remaining);
    const named = [
      ...losing.tasks.map((task) => `task ${task.id} in ${plainLine(task.workdir ?? '')}`),
      ...losing.schedules.map((schedule) => `schedule ${schedule.id} in ${plainLine(schedule.workdir ?? '')}`),
    ];
    if (named.length > 0)
      throw new UsageError(
        `${plainLine(match.path)} is still used by work on this machine that no other listed directory covers:\n${named.map((line) => `  ${line}`).join('\n')}\nIt ${STOP_NOTE}. Move or finish it, or remove the directory anyway with --force.`,
      );
  }
  write(deps, `unlist ${match.path}`, (keys) =>
    keys.filter(({ path: kept }) => kept !== match.path).map(({ key }) => key),
  );
  if (deps.dryRun) return;
  deps.print(`unlisted ${plainLine(match.path)}`);
  if (remaining.length === 0) deps.print(`the list is now empty: ${EMPTY_NOTE}`);
}

async function losingWork(deps: DirsDeps, machine: string, removed: DirEntry, remaining: DirEntry[]): Promise<Users> {
  let work: Users;
  try {
    work = { tasks: await deps.backend.listTasks(), schedules: await deps.backend.listSchedules() };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
    throw new UsageError(
      `could not check whether work still uses ${plainLine(removed.path)} (${plainLine(reason ?? '')}); try again, or remove it anyway with --force`,
    );
  }
  return workLosingDir(machine, removed, remaining, work);
}
