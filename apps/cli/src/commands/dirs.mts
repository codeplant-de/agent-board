import { resolve } from 'node:path';
import { isRecord } from '@agent-board/shared';
import type { Backend, Schedule, Task } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { DIR_SETTINGS, dirKeyPath, dirSettingProblem, expandHome, MAX_DIRS, parseConfig } from '../config/config.mts';
import type { Config, DirEntry, DirSetting } from '../config/config.mts';
import { readConfigFile, writeConfigFile } from '../config/config-file.mts';
import { coveringDir, isDirectory, routedDirs, syncDirs, tryRealpath } from '../config/dirs.mts';
import { plainLine } from '../output/terminal.mts';
import { errorText } from '../output/text.mts';

export const FIRST_ADD_NOTE = [
  'created the dirs list: workers on this machine now run tasks only in listed directories.',
  '"board dirs add --from-config" adds the directories this config already routes to.',
];
export const STOP_NOTE = 'stops in Needs me at its next start';
export const EMPTY_NOTE = 'it allows nothing, so every task on this machine will stop in Needs me';

// One entry of `dirs` as written in the file: its key and settings object, which a rewrite keeps as they are.
interface DirRecord {
  key: string;
  settings: Record<string, unknown>;
}

// An entry of `dirs` and the path its key names.
interface DirKey extends DirRecord {
  path: string;
}

interface DirsFile {
  raw: Record<string, unknown>;
  config: Config;
  mode: number;
  // undefined: no `dirs` key.
  keys: DirKey[] | undefined;
}

function readDirsFile(configFile: string): DirsFile {
  const { raw, mode } = readConfigFile(configFile, 'fix it before changing the dirs list');
  const config = parseConfig(raw);
  const rawDirs = raw['dirs'];
  const keys = isRecord(rawDirs)
    ? Object.keys(rawDirs).flatMap((key) => {
        const path = dirKeyPath(key);
        const settings = rawDirs[key];
        return path === undefined ? [] : [{ key, path, settings: isRecord(settings) ? settings : {} }];
      })
    : undefined;
  return { raw, config, mode, keys };
}

/**
 * Rewrites the `dirs` key of config.json and nothing else: the file is read again here, `change` maps the entries now in it
 * to the entries to keep, and the result is written beside the file and renamed over it, with the file's mode. An entry
 * `change` passes on keeps its settings as they are. The file is rewritten as JSON with 2 spaces, so hand formatting is
 * lost; every other key keeps its value and its place.
 */
export function changeDirs(configFile: string, change: (keys: DirKey[]) => DirRecord[]): void {
  const { raw, mode, keys } = readDirsFile(configFile);
  const next = change(keys ?? []);
  const dirs = Object.fromEntries(next.map(({ key, settings }) => [key, settings]));
  writeConfigFile(configFile, { ...raw, dirs }, mode);
}

export interface DirsDeps {
  configFile: string;
  cwd: string;
  home: string;
  dryRun: boolean;
  print: (line: string) => void;
  // `rm` asks the board for work, and `add` and `rm` send the list afterwards.
  backend: Pick<Backend, 'listTasks' | 'listSchedules' | 'checkDirs' | 'setDirs'>;
  bold?: (text: string) => string;
}

// What sending the list needs, which `board config` has as well.
export type DirsSyncDeps = Pick<DirsDeps, 'configFile' | 'dryRun' | 'print'> & {
  backend: Pick<Backend, 'checkDirs' | 'setDirs'>;
};

export interface DirsAddFlags {
  fromConfig?: boolean;
}

export interface DirsRemoveFlags {
  force?: boolean;
}

function warn(deps: Pick<DirsDeps, 'print'>, line: string): void {
  deps.print(`warning: ${line}`);
}

// What a typed path means: relative to the working directory, `~` expanded.
const absolute = (deps: DirsDeps, path: string | undefined): string =>
  path === undefined ? deps.cwd : resolve(deps.cwd, expandHome(path));

function write(deps: DirsDeps, line: string, change: (keys: DirKey[]) => DirRecord[]): void {
  if (deps.dryRun) deps.print(`DRY ${line} (in ${deps.configFile})`);
  else changeDirs(deps.configFile, change);
}

export function dirsList(deps: DirsDeps): void {
  const { config } = readDirsFile(deps.configFile);
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
  for (const entry of config.dirs)
    deps.print(`  ${plainLine(entry.path)}${isDirectory(entry.path) ? '' : '  missing'}${settingsText(entry)}`);
}

// An entry's settings as `label=Board  repo=owner/name  default  lane=reviews`, each led by two spaces.
function settingsText(entry: DirEntry): string {
  return DIR_SETTINGS.map((setting) => {
    if (entry[setting] === undefined) return '';
    return `  ${setting === 'default' ? 'default' : `${setting}=${plainLine(String(entry[setting]))}`}`;
  }).join('');
}

/**
 * After `add` or `rm`: sends the new list to the board and says so. A board that cannot be reached or refuses is a warning,
 * never a failure: the list in config.json is what counts, and the next dispatch tick sends it.
 */
export async function reportDirsSync(deps: DirsSyncDeps): Promise<void> {
  if (deps.dryRun) return;
  try {
    const sync = await syncDirs({ backend: deps.backend, config: readDirsFile(deps.configFile).config });
    if (sync.result === 'unsupported')
      deps.print('the board cannot show this list yet: its server has no directory lists');
    else if (sync.result !== 'not-listed') deps.print('the board has the list');
  } catch (error) {
    const reason = errorText(error).split('\n')[0] ?? '';
    warn(deps, `could not send the list to the board (${plainLine(reason)}); the next dispatch tick will send it`);
  }
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
  const { config } = readDirsFile(deps.configFile);
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
  write(deps, `list ${real}`, (keys) => [...keys, { key: real, settings: {} }]);
  if (deps.dryRun) return;
  deps.print(`listed ${real}`);
  if (parent !== undefined) deps.print(`note: it was already allowed through ${plainLine(parent.path)}`);
  if (config.dirs === undefined) for (const line of FIRST_ADD_NOTE) deps.print(line);
}

function addFromConfig(deps: DirsDeps): void {
  const { config } = readDirsFile(deps.configFile);
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
  write(deps, `list ${added.length} directories`, (keys) => [...keys, ...added.map((key) => ({ key, settings: {} }))]);
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

// The listed entry a typed path names, matched by its real path or as written; throws when there is none.
function listedEntry(deps: DirsDeps, dirs: readonly DirEntry[], path: string | undefined): DirEntry {
  const wanted = absolute(deps, path);
  const real = tryRealpath(wanted);
  const match =
    real === undefined
      ? dirs.find((entry) => entry.path === wanted)
      : dirs.find((entry) => entry.path === real || tryRealpath(entry.path) === real);
  if (match === undefined)
    throw new UsageError(`${plainLine(real ?? wanted)} is not listed; "board dirs add" lists a directory`);
  return match;
}

export async function dirsRemove(deps: DirsDeps, path: string | undefined, flags: DirsRemoveFlags = {}): Promise<void> {
  const { config } = readDirsFile(deps.configFile);
  if (config.dirs === undefined) throw new UsageError('no directories are listed');
  const match = listedEntry(deps, config.dirs, path);
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
  write(deps, `unlist ${match.path}`, (keys) => keys.filter(({ path: kept }) => kept !== match.path));
  const lost = lostSettings(match);
  if (lost.length > 0) deps.print(`note: it no longer has its ${lost.join(', ')}`);
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

// What leaving the list takes from an entry besides its label: where repo, default and lane tasks run.
function lostSettings({ repo, default: isDefault, lane }: DirEntry): string[] {
  return [
    ...(repo === undefined ? [] : [`repo ${plainLine(repo)}`]),
    ...(isDefault === true ? ['default directory role'] : []),
    ...(lane === undefined ? [] : [`lane ${plainLine(lane)}`]),
  ];
}

const settingNames = DIR_SETTINGS.join(', ');

const shellQuote = (text: string): string => `'${plainLine(text).replaceAll("'", `'\\''`)}'`;

function settingKey(key: string): DirSetting {
  const setting = DIR_SETTINGS.find((name) => name === key);
  if (setting === undefined)
    throw new UsageError(`"${plainLine(key).slice(0, 40)}" is not a directory setting: ${settingNames}`);
  return setting;
}

// What a typed value is as the setting: only `default` is not text.
function settingValue(setting: DirSetting, value: string): string | true {
  if (setting === 'default' && value !== 'true')
    throw new UsageError('default takes true; "board dirs unset default" takes it away');
  return setting === 'default' ? true : value.trim();
}

export function dirsSet(deps: DirsDeps, key: string, text: string, path: string | undefined): void {
  const setting = settingKey(key);
  const value = settingValue(setting, text);
  const { config } = readDirsFile(deps.configFile);
  if (config.dirs === undefined) throw new UsageError('no directories are listed; "board dirs add" lists one first');
  const match = listedEntry(deps, config.dirs, path);
  const problem = dirSettingProblem(
    setting,
    value,
    config.lanes.map(({ name }) => name),
  );
  if (problem !== undefined) throw new UsageError(`${setting} ${problem}`);
  if (match[setting] === value) {
    deps.print(`${plainLine(match.path)} already has ${setting}${value === true ? '' : `=${plainLine(value)}`}`);
    return;
  }
  if (setting !== 'label') {
    const holder = config.dirs.find((entry) => entry !== match && entry[setting] === value);
    if (holder !== undefined)
      throw new UsageError(
        `${plainLine(holder.path)} has ${setting}${value === true ? '' : ` ${plainLine(value)}`} already; "board dirs unset ${setting} ${shellQuote(holder.path)}" takes it away first`,
      );
  }
  write(deps, `set ${setting} of ${match.path}`, (keys) =>
    keys.map((entry) =>
      entry.path === match.path ? { ...entry, settings: { ...entry.settings, [setting]: value } } : entry,
    ),
  );
  if (!deps.dryRun) deps.print(`set ${setting} of ${plainLine(match.path)}`);
}

export function dirsUnset(deps: DirsDeps, key: string, path: string | undefined): void {
  const setting = settingKey(key);
  const { config } = readDirsFile(deps.configFile);
  if (config.dirs === undefined) throw new UsageError('no directories are listed');
  const match = listedEntry(deps, config.dirs, path);
  if (match[setting] === undefined) {
    deps.print(`${plainLine(match.path)} has no ${setting}`);
    return;
  }
  write(deps, `unset ${setting} of ${match.path}`, (keys) =>
    keys.map((entry) => {
      if (entry.path !== match.path) return entry;
      const { [setting]: _removed, ...settings } = entry.settings;
      return { ...entry, settings };
    }),
  );
  if (!deps.dryRun) deps.print(`unset ${setting} of ${plainLine(match.path)}`);
}
