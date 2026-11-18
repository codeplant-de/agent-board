import { realpathSync, statSync } from 'node:fs';
import { dirname, parse } from 'node:path';
import { isSafeWorkdir } from '@agent-board/shared';
import type { Backend, MachineDir } from '@agent-board/shared';
import type { Config, DirEntry } from './config.mts';

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

/**
 * The `ciIgnore` patterns of the listed directory that covers `path`, compared as written and by real path like
 * isAllowedDir, so a worktree below a checkout gets its checkout's patterns. None when no entry covers it.
 */
export function dirCiIgnore(
  dirs: readonly DirEntry[] | undefined,
  path: string,
  realpath: (path: string) => string | undefined = tryRealpath,
): string[] {
  if (dirs === undefined) return [];
  const resolved = dirs.flatMap((entry) => {
    const real = realpath(entry.path);
    return real === undefined || real === entry.path ? [] : [{ ...entry, path: real }];
  });
  const all = [...dirs, ...resolved];
  const covering = coveringDir(all, realpath(path) ?? path) ?? coveringDir(all, path);
  return covering?.ciIgnore ?? [];
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

// Whether a directory is there; a path that cannot be looked at is not.
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The nearest parent of `path` with a `.git` in it (a directory in a main checkout, a file in a linked worktree), never
 * the filesystem root: the checkout that held a worktree folder below it.
 */
export function checkoutAbove(path: string, hasGit: (dir: string) => boolean): string | undefined {
  const { root } = parse(path);
  for (let dir = dirname(path); dir !== root && dir !== dirname(dir); dir = dirname(dir)) {
    if (hasGit(`${dir}/.git`)) return dir;
  }
  return undefined;
}

/** What `syncDirs` did: sent the list, found the board's copy current, found the server unable to hold one, or had no list. */
export type DirsSync = { result: 'sent'; count: number } | { result: 'unchanged' | 'unsupported' | 'not-listed' };

/** The listed directories that exist now, as written in the config: what the board is told. */
export function dirsToSend(dirs: readonly DirEntry[], exists: (path: string) => boolean = isDirectory): MachineDir[] {
  return dirs
    .filter(({ path }) => isSafeWorkdir(path) && exists(path))
    .map(({ path, label }) => (label === undefined ? { path } : { path, label }));
}

/**
 * Tells the board this machine's directory list when it differs from the board's copy (by blind index). The board's copy
 * is advice for the New task form: nothing here reads it back, and the machine's own config.json stays the only list that
 * is enforced. Throws what the board call throws; callers decide how loud that is.
 */
export async function syncDirs(
  deps: { backend: Pick<Backend, 'checkDirs' | 'setDirs'>; config: Pick<Config, 'machine' | 'dirs'> },
  exists?: (path: string) => boolean,
): Promise<DirsSync> {
  const { backend, config } = deps;
  if (config.dirs === undefined) return { result: 'not-listed' };
  const dirs = dirsToSend(config.dirs, exists);
  const state = await backend.checkDirs(config.machine, dirs);
  if (state !== 'stale') return { result: state === 'current' ? 'unchanged' : 'unsupported' };
  await backend.setDirs(config.machine, dirs);
  return { result: 'sent', count: dirs.length };
}

// Where the config sends work: the default directory, every lane's, every repo's checkout.
export function routedDirs(config: Pick<Config, 'defaultCwd' | 'lanes' | 'repos'>): { label: string; path: string }[] {
  return [
    { label: 'defaultCwd', path: config.defaultCwd },
    ...config.lanes.flatMap(({ name, cwd }) => (cwd === undefined ? [] : [{ label: `lane ${name} cwd`, path: cwd }])),
    ...Object.entries(config.repos).map(([repo, path]) => ({ label: `repos ${repo}`, path })),
  ];
}
