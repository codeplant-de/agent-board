import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@agent-board/shared';
import type { Backend } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { ConfigError, DEFAULT_LANES, configWarnings, parseConfig } from '../config/config.mts';
import type { Config } from '../config/config.mts';
import { configTarget, readConfigFile, readConfigText, writeConfigFile } from '../config/config-file.mts';
import { UNCOVERED_HINT, isAllowedDir, isDirectory, routedDirs } from '../config/dirs.mts';
import { plainLine } from '../output/terminal.mts';
import { errorText } from '../output/text.mts';
import { reportDirsSync } from './dirs.mts';

export interface ConfigDeps {
  configFile: string;
  dryRun: boolean;
  print: (line: string) => void;
  // JSON on stdout alone, for `show --json`.
  printJson: (value: unknown) => void;
  // A change to `dirs` is sent to the board like `board dirs` does.
  backend: Pick<Backend, 'checkDirs' | 'setDirs'>;
  // $VISUAL, else $EDITOR: the command line of the editor, read by the shell, or undefined when neither is set.
  editor: string | undefined;
  // Whether stdin is a terminal, which an editor needs.
  interactive: boolean;
  // Runs the editor with the terminal and returns its exit status; undefined when it could not be started.
  runEditor: (argv: string[]) => number | undefined;
}

// The settings with a default of their own, which `get` answers for when the file leaves them out.
const DEFAULTED = [
  'machine',
  'defaultCwd',
  'pauseAfterMinutes',
  'inactivityMinutes',
  'maxRunHours',
  'autoUpdate',
] as const;
type Defaulted = (typeof DEFAULTED)[number];
const isDefaulted = (key: string): key is Defaulted => DEFAULTED.some((name) => name === key);

const DIRS_POINTER =
  'the entries of dirs are changed with "board dirs" (add, rm, set, unset); "board config set dirs <json>" replaces the whole list';

const shown = (text: string): string => plainLine(text).slice(0, 80);
const compact = (value: unknown): string => plainLine(JSON.stringify(value) ?? 'undefined');

function warn(deps: Pick<ConfigDeps, 'print'>, line: string): void {
  deps.print(`warning: ${plainLine(line)}`);
}

// What a typed key means as a path into the document. A name that holds dots (a lane, a `dirs` path, `owner/name.js` under
// `repos`) is told from the dots between names by what the document has: the longest key that fits wins.
function pathOf(raw: Record<string, unknown>, key: string): string[] {
  const path: string[] = [];
  let node: unknown = raw;
  let rest = key;
  while (rest !== '') {
    const own = isRecord(node)
      ? Object.keys(node)
          .filter((name) => rest === name || rest.startsWith(`${name}.`))
          .sort((a, b) => b.length - a.length)[0]
      : undefined;
    const wholeKey = path.length === 1 && path[0] === 'repos';
    const segment = wholeKey ? rest : (own ?? rest.split('.')[0] ?? rest);
    path.push(segment);
    rest = rest.slice(segment.length + 1);
    node = isRecord(node) && Object.hasOwn(node, segment) ? node[segment] : undefined;
  }
  return path;
}

function checkedPath(raw: Record<string, unknown>, key: string): string[] {
  const path = pathOf(raw, key);
  if (path.length === 0 || path.some((segment) => segment === '' || segment === '__proto__'))
    throw new UsageError(
      `"${shown(key)}" is not a key of config.json: use names joined by dots, such as lanes.reviews.slots`,
    );
  return path;
}

type Found = { found: true; value: unknown } | { found: false };

function valueAt(raw: Record<string, unknown>, path: string[]): Found {
  let node: unknown = raw;
  for (const segment of path) {
    if (Array.isArray(node) && /^\d+$/.test(segment) && Number(segment) < node.length) node = node[Number(segment)];
    else if (isRecord(node) && Object.hasOwn(node, segment)) node = node[segment];
    else return { found: false };
  }
  return { found: true, value: node };
}

const bare = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? ''));

// What the typed value is: JSON when it parses, else the text itself.
function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** What is wrong with each route of `config` (a directory work is sent to), by the route's label and path. */
function routeProblems(config: Config): Map<string, string> {
  const problems = new Map<string, string>();
  for (const { label, path } of routedDirs(config)) {
    const where = `${label} ${plainLine(path)}`;
    if (!isDirectory(path))
      problems.set(`${label} ${path}`, `${where} is not an existing directory: tasks routed there stop in Needs me`);
    else if (!isAllowedDir(config.dirs, path))
      problems.set(`${label} ${path}`, `${where} is in no listed directory: ${UNCOVERED_HINT}`);
  }
  return problems;
}

/** The problems of the routes of `config` that `known` did not have already. */
function brokenRoutes(config: Config, known: Config | undefined): string[] {
  const knownKeys = known === undefined ? new Map<string, string>() : routeProblems(known);
  return [...routeProblems(config)].filter(([key]) => !knownKeys.has(key)).map(([, problem]) => problem);
}

/**
 * What stops `after` from replacing `before`, or undefined. The whole document is checked, since a value that is fine alone can
 * break another part (a lane the `dirs` list names). A misspelt key is refused because the CLI would ignore it and keep the
 * default, an agent that would not load is refused because a task naming it would fail closed, and a route that was fine and
 * now is not a directory or not in the `dirs` list is refused because the work sent there would stop in Needs me.
 */
function refusal(before: Config, beforeRaw: unknown, after: Record<string, unknown>): string | undefined {
  let config: Config;
  try {
    config = parseConfig(after);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  const brokenAgent = Object.keys(config.agentErrors).find((name) => !(name in before.agentErrors));
  if (brokenAgent !== undefined) return config.agentErrors[brokenAgent];
  const known = configWarnings(beforeRaw);
  const unknown = configWarnings(after).find(
    (warning) => warning.startsWith('unknown key') && !known.includes(warning),
  );
  return unknown ?? brokenRoutes(config, before)[0];
}

function refuse(reason: string): never {
  throw new UsageError(`${plainLine(reason)}; nothing was written`);
}

// The limits the dispatcher's sweep reads from the file on every tick, so they reach runs that are already going.
const LIMITS = [
  { key: 'maxRunHours', effect: 'a run past it is stopped then' },
  { key: 'inactivityMinutes', effect: 'a run quiet for longer is stopped then' },
  { key: 'pauseAfterMinutes', effect: 'a borrowed run past it can be paused then' },
] as const;

function noteChange(deps: ConfigDeps, before: Config | undefined, after: Config): void {
  if (before !== undefined && before.machine !== after.machine)
    warn(
      deps,
      `this machine's name changed from "${shown(before.machine)}" to "${shown(after.machine)}". The board names a machine by its token, not by this file: claims for "${shown(after.machine)}" are refused until the token was issued for that name, and a task whose session lives under "${shown(before.machine)}" will not resume here`,
    );
  if (before?.dirs !== undefined && after.dirs === undefined)
    deps.print('the dirs list is gone: workers on this machine may run in any directory again');
  const moved = LIMITS.filter(({ key }) => before !== undefined && before[key] !== after[key]);
  if (moved.length > 0)
    deps.print(
      `the dispatcher applies the new ${moved.map(({ key, effect }) => `${key} (${effect})`).join(' and ')} to runs that are already going from its next tick`,
    );
  deps.print(
    'takes effect at the next dispatch tick; a run that is already going keeps the other settings it started with',
  );
  const dropped = (before?.dirs ?? []).filter(({ path }) => !after.dirs?.some((entry) => entry.path === path));
  if (after.dirs !== undefined && dropped.length > 0)
    warn(
      deps,
      `dirs no longer lists ${dropped.map(({ path }) => plainLine(path)).join(', ')}: work still pinned to it will stop in Needs me ("board dirs rm" checks for that)`,
    );
}

async function afterChange(
  deps: ConfigDeps,
  before: { raw: Record<string, unknown>; config: Config } | undefined,
  after: { raw: Record<string, unknown>; config: Config },
): Promise<void> {
  if (deps.dryRun) return;
  noteChange(deps, before?.config, after.config);
  if (!isDeepStrictEqual(before?.raw['dirs'], after.raw['dirs'])) await reportDirsSync(deps);
}

const label = (name: string): string => name.padEnd(19);

function lineOf(config: Config, raw: Record<string, unknown>, key: Defaulted): string {
  const value = config[key];
  const fromDirs = key === 'defaultCwd' && config.dirs?.some((entry) => entry.default === true) === true;
  const origin = key in raw ? '' : fromDirs ? '  (from dirs)' : '  (default)';
  return `${label(key)}${plainLine(String(value))}${origin}`;
}

export function configShow(deps: ConfigDeps, flags: { json?: boolean } = {}): void {
  const { raw } = readConfigFile(deps.configFile);
  if (flags.json) {
    deps.printJson(raw);
    return;
  }
  const config = parseConfig(raw);
  deps.print(plainLine(deps.configFile));
  for (const key of DEFAULTED) deps.print(lineOf(config, raw, key));
  deps.print(`${label('lanes')}${'lanes' in raw ? '' : '(default)'}`.trimEnd());
  for (const lane of config.lanes)
    deps.print(
      `  ${plainLine(lane.name)}  skills ${plainLine(lane.skills.join(', '))}  slots ${lane.slots}${lane.cwd === undefined ? '' : `  cwd ${plainLine(lane.cwd)}`}`,
    );
  const repos = Object.entries(config.repos);
  deps.print(`${label('repos')}${repos.length === 0 ? 'none' : ''}`.trimEnd());
  for (const [repo, dir] of repos) deps.print(`  ${plainLine(repo)}  ${plainLine(dir)}`);
  const rawAgents = isRecord(raw['agents']) ? Object.keys(raw['agents']) : [];
  deps.print(`${label('agents')}${rawAgents.length === 0 ? 'none' : ''}`.trimEnd());
  for (const name of rawAgents) {
    const problem = config.agentErrors[name];
    deps.print(`  ${plainLine(name)}${problem === undefined ? '' : `  broken: ${plainLine(problem)}`}`);
  }
  deps.print(
    `${label('dirs')}${config.dirs === undefined ? 'not set: workers on this machine may run in any directory' : `${config.dirs.length} listed, enforced: workers run only in them`}  ("board dirs" shows and changes them)`,
  );
  for (const warning of configWarnings(raw)) warn(deps, warning);
}

export function configGet(deps: ConfigDeps, key: string): void {
  const { raw } = readConfigFile(deps.configFile);
  const path = checkedPath(raw, key);
  const found = valueAt(raw, path);
  if (found.found) {
    deps.print(bare(found.value));
    return;
  }
  const [top] = path;
  if (path.length === 1 && top !== undefined && isDefaulted(top)) {
    deps.print(bare(parseConfig(raw)[top]));
    return;
  }
  if (path.length === 1 && top === 'lanes') {
    deps.print(bare(defaultLanesInFile()));
    return;
  }
  throw new UsageError(`${shown(key)} is not set in ${plainLine(deps.configFile)}`);
}

// The default lanes the way config.json spells them: an object by lane name.
const defaultLanesInFile = (): Record<string, unknown> =>
  Object.fromEntries(DEFAULT_LANES.map(({ name, ...lane }) => [name, lane]));

function guardWrite(path: string[]): void {
  if (path[0] === 'dirs' && path.length > 1) throw new UsageError(DIRS_POINTER);
}

const kind = (value: unknown): string =>
  Array.isArray(value) ? 'a list' : value === null ? 'null' : `a ${typeof value}`;

// A copy of `raw` with the value at `path` set, the objects on the way created.
function withValue(raw: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const next = structuredClone(raw);
  let node = next;
  path.slice(0, -1).forEach((segment, index) => {
    const child = Object.hasOwn(node, segment) ? node[segment] : undefined;
    if (child === undefined) {
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
    } else if (isRecord(child)) node = child;
    else
      throw new UsageError(
        `${shown(path.slice(0, index + 1).join('.'))} is ${kind(child)}, not an object: set it as a whole instead`,
      );
  });
  node[path[path.length - 1] ?? ''] = value;
  return next;
}

// A copy of `raw` without the value at `path`.
function withoutValue(raw: Record<string, unknown>, path: string[]): Record<string, unknown> {
  const next = structuredClone(raw);
  let node: unknown = next;
  for (const segment of path.slice(0, -1)) node = isRecord(node) ? node[segment] : undefined;
  if (!isRecord(node))
    throw new UsageError(`${shown(path.join('.'))} is inside a list: set the list as a whole instead`);
  delete node[path[path.length - 1] ?? ''];
  return next;
}

function write(deps: ConfigDeps, line: string, next: Record<string, unknown>, mode: number): void {
  if (deps.dryRun) deps.print(`DRY ${line} (in ${plainLine(deps.configFile)})`);
  else writeConfigFile(deps.configFile, next, mode);
}

export async function configSet(deps: ConfigDeps, key: string, text: string): Promise<void> {
  const { raw: file, mode } = readConfigFile(deps.configFile);
  const before = parseConfig(file);
  // Writing one lane into a file without lanes would leave that lane alone, so the default lane is written out first.
  const writesDefaultLanes = key.startsWith('lanes.') && !('lanes' in file);
  const raw = writesDefaultLanes ? { ...file, lanes: defaultLanesInFile() } : file;
  const path = checkedPath(raw, key);
  guardWrite(path);
  const value = parseValue(text);
  const current = valueAt(raw, path);
  const name = shown(path.join('.'));
  if (current.found && isDeepStrictEqual(current.value, value)) {
    deps.print(`${name} is already ${compact(value)}`);
    return;
  }
  const next = withValue(raw, path, value);
  const problem = refusal(before, file, next);
  if (problem !== undefined) refuse(`${name} cannot be ${compact(value).slice(0, 80)}: ${problem}`);
  write(deps, `set ${name} to ${compact(value)}`, next, mode);
  if (!deps.dryRun) deps.print(`set ${name} to ${compact(value)}`);
  if (writesDefaultLanes)
    deps.print(`the default lane ${DEFAULT_LANES.map(({ name: lane }) => lane).join(', ')} is written out too`);
  await afterChange(deps, { raw: file, config: before }, { raw: next, config: parseConfig(next) });
}

export async function configUnset(deps: ConfigDeps, key: string): Promise<void> {
  const { raw, mode } = readConfigFile(deps.configFile);
  const before = parseConfig(raw);
  const path = checkedPath(raw, key);
  guardWrite(path);
  const name = shown(path.join('.'));
  if (!valueAt(raw, path).found) {
    deps.print(`${name} is not set`);
    return;
  }
  const next = withoutValue(raw, path);
  const problem = refusal(before, raw, next);
  if (problem !== undefined) refuse(`${name} cannot be removed: ${problem}`);
  write(deps, `unset ${name}`, next, mode);
  if (!deps.dryRun) deps.print(`unset ${name}; the default applies again`);
  await afterChange(deps, { raw, config: before }, { raw: next, config: parseConfig(next) });
}

export function configPath(deps: Pick<ConfigDeps, 'configFile' | 'print'>): void {
  deps.print(plainLine(deps.configFile));
}

// The text a hand-edited config.json would have to be, or why it is not.
function editedConfig(text: string): { raw: Record<string, unknown>; config: Config } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`it is not valid JSON (${errorText(error).slice(0, 120)})`);
  }
  if (!isRecord(raw)) throw new ConfigError('its top level must be an object');
  return { raw, config: parseConfig(raw) };
}

function readableBefore(configFile: string): { raw: Record<string, unknown>; config: Config } | undefined {
  try {
    const { raw } = readConfigFile(configFile);
    return { raw, config: parseConfig(raw) };
  } catch (error) {
    if (error instanceof ConfigError) return undefined;
    throw error;
  }
}

export async function configEdit(deps: ConfigDeps): Promise<void> {
  if (deps.dryRun)
    throw new UsageError('--dry-run does not apply to edit: nothing is written until the editor is closed');
  const command = deps.editor?.trim() ?? '';
  const [program] = command.split(/\s+/);
  if (command === '' || program === undefined)
    throw new UsageError('no editor: set $VISUAL or $EDITOR (board config edit does not guess one)');
  if (!deps.interactive) throw new UsageError('board config edit needs a terminal');
  const target = configTarget(deps.configFile);
  const { text, mode } = readConfigText(target);
  const before = readableBefore(deps.configFile);
  const copy = `${target}.edit-${process.pid}`;
  rmSync(copy, { force: true });
  writeFileSync(copy, text, { mode: 0o600, flag: 'wx' });
  chmodSync(copy, 0o600);
  let keep = false;
  try {
    // The way git runs its editor: the shell reads the command line, so quotes and arguments work.
    const status = deps.runEditor(['/bin/sh', '-c', `${command} "$@"`, 'editor', copy]);
    if (status === undefined) throw new UsageError(`could not start the editor "${shown(program)}"`);
    if (status !== 0)
      throw new UsageError(`the editor ended with status ${status}; ${plainLine(deps.configFile)} is unchanged`);
    const edited = readFileSync(copy, 'utf8');
    if (edited === text) {
      deps.print('unchanged');
      return;
    }
    keep = true;
    let after: { raw: Record<string, unknown>; config: Config };
    try {
      after = editedConfig(edited);
    } catch (error) {
      throw new UsageError(
        `${plainLine(deps.configFile)} is unchanged: ${plainLine(errorText(error))}. Your edits are kept in ${plainLine(copy)}`,
      );
    }
    if (readConfigText(target).text !== text)
      throw new UsageError(
        `${plainLine(deps.configFile)} changed while the editor was open and was left as it is. Your edits are kept in ${plainLine(copy)}`,
      );
    chmodSync(copy, mode);
    renameSync(copy, target);
    keep = false;
    deps.print(`edited ${plainLine(deps.configFile)}`);
    for (const warning of configWarnings(after.raw)) warn(deps, warning);
    for (const [name, problem] of Object.entries(after.config.agentErrors))
      warn(deps, `agents.${shown(name)} cannot be used, tasks that name it will fail: ${problem}`);
    for (const route of brokenRoutes(after.config, before?.config)) warn(deps, route);
    await afterChange(deps, before, after);
  } finally {
    if (!keep) rmSync(copy, { force: true });
  }
}
