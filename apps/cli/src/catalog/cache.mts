// What this machine learned of each directory's skills and models, one file per directory so that the dispatcher and the
// workers never write the same file. Advice for the board's catalogue; nothing here is read for a run.
//   <state dir>/catalog/<hash of the path>.json        the dispatcher's: the newest probe of the directory
//   <state dir>/catalog/<hash of the path>.init.json   a worker's: the skills its newest run reported at its start
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, isSafeSkillName } from '@agent-board/shared';
import { getPaths } from '../config/config.mts';
import { readProbeAnswer } from './probe.mts';
import type { ProbeResult } from './probe.mts';

const INIT_SUFFIX = '.init.json';
const MAX_INIT_SKILLS = 2000;

// A probe that failed is not tried again for this long, unless what it depends on changed.
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

export interface CatalogEntry {
  path: string;
  // The fingerprint of the directory when `result` was probed; '' while nothing was probed.
  fingerprint: string;
  probedAt: string;
  // The hash of the skills a run reported (`InitRecord.hash`) when this was probed; null when none had.
  probedForInit: string | null;
  // null: no probe of this directory has worked yet.
  result: ProbeResult | null;
  // The newest probe that failed, with the fingerprint it was made at.
  failure?: { at: string; fingerprint: string };
}

export interface InitRecord {
  hash: string;
  skills: string[];
}

export interface CatalogStore {
  read: (dir: string) => CatalogEntry | undefined;
  write: (entry: CatalogEntry) => void;
  readInit: (dir: string) => InitRecord | undefined;
  writeInit: (dir: string, record: InitRecord) => void;
  // The skills runs reported, of every directory.
  initSkills: () => Set<string>;
}

/** The hash of a set of skill names, which differs when a run sees other skills than the last one did. */
export function hashSkillNames(names: readonly string[]): string {
  return createHash('sha256')
    .update([...new Set(names)].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
}

const fileId = (dir: string): string => createHash('sha256').update(dir).digest('hex').slice(0, 32);

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// Whole or not at all: a reader never sees a half-written file.
function writeJson(dir: string, file: string, value: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function parseEntry(value: unknown, dir: string): CatalogEntry | undefined {
  if (!isRecord(value) || value['path'] !== dir) return undefined;
  const { fingerprint, probedAt, probedForInit, failure } = value;
  if (typeof fingerprint !== 'string' || !isTime(probedAt)) return undefined;
  if (probedForInit !== null && typeof probedForInit !== 'string') return undefined;
  const raw = value['result'];
  const result =
    raw === null
      ? null
      : isRecord(raw)
        ? readProbeAnswer({ claude_code_version: raw['claude'], models: raw['models'], commands: raw['commands'] })
        : undefined;
  if (result === undefined) return undefined;
  const failed =
    isRecord(failure) && isTime(failure['at']) && typeof failure['fingerprint'] === 'string'
      ? { at: failure['at'], fingerprint: failure['fingerprint'] }
      : undefined;
  return {
    path: dir,
    fingerprint,
    probedAt,
    probedForInit,
    result,
    ...(failed === undefined ? {} : { failure: failed }),
  };
}

function parseInit(value: unknown): InitRecord | undefined {
  if (!isRecord(value) || typeof value['hash'] !== 'string' || !Array.isArray(value['skills'])) return undefined;
  const skills: unknown[] = value['skills'];
  return {
    hash: value['hash'],
    skills: skills.filter((name): name is string => typeof name === 'string' && isSafeSkillName(name)),
  };
}

export function createCatalogStore(dir: string = getPaths().catalogDir): CatalogStore {
  const entryFile = (path: string): string => join(dir, `${fileId(path)}.json`);
  const initFile = (path: string): string => join(dir, `${fileId(path)}${INIT_SUFFIX}`);
  return {
    read: (path) => parseEntry(readJson(entryFile(path)), path),
    write: (entry) => writeJson(dir, entryFile(entry.path), entry),
    readInit: (path) => parseInit(readJson(initFile(path))),
    writeInit: (path, record) => writeJson(dir, initFile(path), record),
    initSkills() {
      let names: string[];
      try {
        names = readdirSync(dir).filter((name) => name.endsWith(INIT_SUFFIX));
      } catch {
        return new Set();
      }
      return new Set(
        names.flatMap((name) => parseInit(readJson(join(dir, name)))?.skills ?? []).slice(0, MAX_INIT_SKILLS),
      );
    },
  };
}

// What a directory's skills depend on, looked at without starting a process.
export interface FingerprintDeps {
  // The `claude` on the PATH; undefined when there is none.
  claude: string | undefined;
  // The modification time of a path, undefined when it is not there.
  mtime: (path: string) => number | undefined;
  // Where Claude Code keeps the user's settings, skills and plugins (~/.claude).
  claudeDir: string;
}

export const realMtime = (path: string): number | undefined => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * A line of text that changes when the program, the installed plugins, or the user's or the directory's settings and skills
 * do: the mtimes of the `claude` program and of those few paths (a missing one counts as one value).
 */
export function catalogFingerprint(dir: string, { claude, mtime, claudeDir }: FingerprintDeps): string {
  const watched = [
    ...(claude === undefined ? [] : [claude]),
    join(claudeDir, 'plugins', 'installed_plugins.json'),
    join(claudeDir, 'settings.json'),
    join(claudeDir, 'skills'),
    join(dir, '.claude', 'skills'),
    join(dir, '.claude', 'settings.json'),
  ];
  const parts = [claude ?? 'no claude', ...watched.map((path) => `${path}=${mtime(path) ?? 'missing'}`)];
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

/**
 * Whether `dir` is to be probed now: never probed, or its fingerprint changed, or a run reported other skills than the last
 * probe saw. A probe that failed at this fingerprint waits out `RETRY_AFTER_FAILURE_MS` first.
 */
export function isStale(
  entry: CatalogEntry | undefined,
  now: Date,
  fingerprint: string,
  init: InitRecord | undefined,
): boolean {
  if (entry === undefined) return true;
  const outdated =
    entry.result === null ||
    entry.fingerprint !== fingerprint ||
    (init !== undefined && init.hash !== entry.probedForInit);
  if (!outdated) return false;
  const { failure } = entry;
  return !(
    failure !== undefined &&
    failure.fingerprint === fingerprint &&
    now.getTime() - Date.parse(failure.at) < RETRY_AFTER_FAILURE_MS
  );
}
