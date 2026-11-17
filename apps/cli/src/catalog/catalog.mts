// The machine catalogue: which skills and models this machine has, found by asking `claude` (probe.mts), kept per directory
// (cache.mts) and sent to the board as one document. The board's copy is advice for the browser's completion and model list:
// nothing here reads it back, and no run depends on it. Every failure is logged by the caller and never fails a tick or a run.
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isRecord,
  isSafeSkillName,
  isSafeWorkdir,
  machineCatalogJson,
  MAX_CATALOG_DIR_SKILLS,
  MAX_CATALOG_SKILLS,
  SEALED_LIMITS,
} from '@agent-board/shared';
import type { Backend, CatalogSkill, MachineCatalog } from '@agent-board/shared';
import { coveringDir, dirsToSend, isDirectory, routedDirs, tryRealpath } from '../config/dirs.mts';
import type { Config } from '../config/config.mts';
import { errorText } from '../output/text.mts';
import { catalogFingerprint, hashSkillNames, isStale, realMtime } from './cache.mts';
import type { CatalogEntry, CatalogStore, FingerprintDeps } from './cache.mts';
import { CLAUDE_COMMAND } from './probe.mts';
import type { ProbeResult } from './probe.mts';
import { whichOnPath } from '../setup/setup.mts';

// A machine with many directories is probed at one per tick, so a bound keeps the first full catalogue near.
export const MAX_PROBED_DIRS = 20;
const MAX_REPORTED_SKILLS = 2000;

type CatalogConfig = Pick<Config, 'machine' | 'dirs' | 'defaultCwd' | 'lanes' | 'repos'>;

/**
 * The directories to ask `claude` in: the listed ones that exist, and for a machine without a `dirs` list those the config
 * routes work to. Without duplicates, at most `MAX_PROBED_DIRS`.
 */
export function catalogDirs(config: CatalogConfig, exists: (path: string) => boolean = isDirectory): string[] {
  const paths =
    config.dirs === undefined
      ? routedDirs(config)
          .map(({ path }) => path)
          .filter((path) => isSafeWorkdir(path) && exists(path))
      : dirsToSend(config.dirs, exists).map(({ path }) => path);
  return [...new Set(paths)].slice(0, MAX_PROBED_DIRS);
}

function skillsOf(result: ProbeResult, reported: ReadonlySet<string>): CatalogSkill[] {
  const seen = new Set<string>();
  return result.commands.flatMap(({ name, description, argumentHint, builtin }) => {
    // Claude Code lists its own commands next to the skills; only a skill a run reported is one.
    if ((builtin && !reported.has(name)) || seen.has(name)) return [];
    seen.add(name);
    return [
      {
        name,
        ...(description === undefined ? {} : { description }),
        ...(argumentHint === undefined ? {} : { argumentHint }),
      },
    ];
  });
}

const byName = (a: CatalogSkill, b: CatalogSkill): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const nameOnly = ({ name }: CatalogSkill): CatalogSkill => ({ name });

// Cuts the lists to `keep` skills each; a directory left with none is left out.
const truncated = (catalog: MachineCatalog, keep: number): MachineCatalog => ({
  ...catalog,
  skills: catalog.skills.slice(0, keep),
  dirs: Object.fromEntries(
    Object.entries(catalog.dirs).flatMap(([path, list]) => (keep === 0 ? [] : [[path, list.slice(0, keep)] as const])),
  ),
});

/**
 * The catalogue as it is when it fits the board's limit for a sealed catalogue, else with less in it, in this order: the
 * descriptions and hints of the skills of single directories, then those of the skills every directory has, then the lists
 * cut to half as many skills each time. `onTrim` hears what was left out.
 */
function fitToSeal(catalog: MachineCatalog, onTrim?: (what: string) => void): MachineCatalog {
  const fits = (candidate: MachineCatalog): boolean =>
    Buffer.byteLength(machineCatalogJson(candidate)) <= SEALED_LIMITS['machine.catalog'];
  if (fits(catalog)) return catalog;
  const withoutDirText = {
    ...catalog,
    dirs: Object.fromEntries(Object.entries(catalog.dirs).map(([path, list]) => [path, list.map(nameOnly)])),
  };
  if (fits(withoutDirText)) {
    onTrim?.('the descriptions of the skills of single directories');
    return withoutDirText;
  }
  const withoutText = { ...withoutDirText, skills: withoutDirText.skills.map(nameOnly) };
  if (fits(withoutText)) {
    onTrim?.('the descriptions of all skills');
    return withoutText;
  }
  onTrim?.('descriptions and part of the skills');
  for (let keep = MAX_CATALOG_SKILLS >> 1; keep > 0; keep >>= 1) {
    const cut = truncated(withoutText, keep);
    if (fits(cut)) return cut;
  }
  return truncated(withoutText, 0);
}

/**
 * The document for the directories probed so far, or undefined when none is. `skills` are those every directory has, and each
 * directory lists the rest. The program and the models are those of the newest probe. `reported` are the skills runs on this
 * machine have reported, which is what tells a skill from a command of Claude Code itself. A document over the limit of a
 * sealed catalogue is made smaller deterministically (see `fitToSeal`), so that sending it cannot fail for its size.
 */
export function composeCatalog(
  entries: readonly (CatalogEntry & { result: ProbeResult })[],
  reported: ReadonlySet<string>,
  onTrim?: (what: string) => void,
): MachineCatalog | undefined {
  const full = composeFull(entries, reported);
  return full === undefined ? undefined : fitToSeal(full, onTrim);
}

function composeFull(
  entries: readonly (CatalogEntry & { result: ProbeResult })[],
  reported: ReadonlySet<string>,
): MachineCatalog | undefined {
  const [first] = entries;
  if (first === undefined) return undefined;
  const newest = entries.reduce((best, entry) =>
    Date.parse(entry.probedAt) > Date.parse(best.probedAt) ? entry : best,
  );
  const perDir = entries.map((entry) => ({ path: entry.path, skills: skillsOf(entry.result, reported) }));
  const common = perDir.reduce<Set<string> | undefined>((names, { skills }) => {
    const here = new Set(skills.map(({ name }) => name));
    return names === undefined ? here : new Set([...names].filter((name) => here.has(name)));
  }, undefined);
  const inEvery = common ?? new Set<string>();
  const dirs = Object.fromEntries(
    perDir.flatMap(({ path, skills }) => {
      const own = skills.filter(({ name }) => !inEvery.has(name)).sort(byName);
      return own.length === 0 ? [] : [[path, own.slice(0, MAX_CATALOG_DIR_SKILLS)] as const];
    }),
  );
  return {
    ...(newest.result.claude === undefined ? {} : { claude: newest.result.claude }),
    models: newest.result.models,
    skills: (perDir[0]?.skills ?? [])
      .filter(({ name }) => inEvery.has(name))
      .sort(byName)
      .slice(0, MAX_CATALOG_SKILLS),
    dirs: Object.fromEntries(Object.entries(dirs).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

export interface CatalogSyncDeps {
  backend: Pick<Backend, 'checkCatalog' | 'setCatalog'>;
  config: CatalogConfig;
  store: CatalogStore;
  // What a directory's probe result depends on, as `catalogFingerprint` reads it.
  fingerprintDeps: () => FingerprintDeps;
  probe: (dir: string) => Promise<ProbeResult | undefined>;
  now: () => Date;
  // Prints what a probe or a send would do and does neither.
  dryRun: boolean;
  // Sends what is cached without asking `claude` first, for a caller with no time for a probe.
  skipProbe?: boolean;
  log: (line: string) => void;
  exists?: (path: string) => boolean;
}

/** What `syncCatalog` did: sent the catalogue, found the board's copy current or the server unable to hold one, or had nothing to send yet. */
export type CatalogSync =
  { result: 'sent'; skills: number; models: number } | { result: 'unchanged' | 'unsupported' | 'nothing-probed' };

const neverWorked = (entry: CatalogEntry | undefined): boolean => !entry?.result;

// Probes the first directory that needs it (one that never worked first), and stores what it found or that it failed.
async function probeOneStale(deps: CatalogSyncDeps, dirs: string[]): Promise<void> {
  const { store, now, log } = deps;
  const fingerprints = deps.fingerprintDeps();
  const due = dirs
    .map((dir) => ({ dir, entry: store.read(dir), fingerprint: catalogFingerprint(dir, fingerprints) }))
    .filter(({ dir, entry, fingerprint }) => isStale(entry, now(), fingerprint, store.readInit(dir)))
    .sort((a, b) => Number(neverWorked(b.entry)) - Number(neverWorked(a.entry)));
  const [next] = due;
  if (next === undefined) return;
  const { dir, entry, fingerprint } = next;
  if (deps.dryRun) {
    log(`DRY probe claude in ${dir}`);
    return;
  }
  const forInit = store.readInit(dir)?.hash ?? null;
  const result = await deps.probe(dir);
  const at = now().toISOString();
  if (result === undefined) {
    log(`WARN asking claude for its skills in ${dir} failed; the catalogue keeps what it had and tries again later`);
    store.write({
      path: dir,
      fingerprint: entry?.fingerprint ?? '',
      probedAt: entry?.probedAt ?? at,
      probedForInit: entry?.probedForInit ?? null,
      result: entry?.result ?? null,
      failure: { at, fingerprint },
    });
    return;
  }
  store.write({ path: dir, fingerprint, probedAt: at, probedForInit: forInit, result });
  log(`CATALOG probed ${dir}: ${result.commands.length} commands, ${result.models.length} models`);
}

/**
 * Probes at most one directory that needs it, then tells the board the catalogue of the directories probed so far when it
 * differs from the board's copy (by blind index). A failed probe or a failed send is logged and throws nothing.
 */
export async function syncCatalog(deps: CatalogSyncDeps): Promise<CatalogSync> {
  const { backend, config, store } = deps;
  const dirs = catalogDirs(config, deps.exists);
  try {
    if (deps.skipProbe !== true) await probeOneStale(deps, dirs);
  } catch (error) {
    deps.log(`WARN the skill catalogue could not be updated: ${errorText(error)}`);
  }
  const entries = dirs.flatMap((dir) => {
    const entry = store.read(dir);
    return entry?.result ? [{ ...entry, result: entry.result }] : [];
  });
  let trimmed: string | undefined;
  const catalog = composeCatalog(entries, store.initSkills(), (what) => (trimmed = what));
  if (catalog === undefined) return { result: 'nothing-probed' };
  const state = await backend.checkCatalog(config.machine, catalog);
  if (state !== 'stale') return { result: state === 'current' ? 'unchanged' : 'unsupported' };
  await backend.setCatalog(config.machine, catalog);
  if (trimmed !== undefined) deps.log(`CATALOG over the board's size limit: sent without ${trimmed}`);
  return {
    result: 'sent',
    skills: catalog.skills.length + Object.values(catalog.dirs).reduce((n, list) => n + list.length, 0),
    models: catalog.models.length,
  };
}

/**
 * A run reported the skills it has: the directory this machine probes that covers the run's directory remembers them, so that
 * the next tick probes it again when they are not those the last probe saw. A run in no probed directory changes nothing.
 */
export function recordRunSkills(
  deps: {
    store: CatalogStore;
    config: CatalogConfig;
    realpath?: (path: string) => string | undefined;
    exists?: (path: string) => boolean;
  },
  cwd: string,
  skills: unknown,
): boolean {
  if (!Array.isArray(skills)) return false;
  const names = (skills as unknown[]).filter(
    (name): name is string => typeof name === 'string' && isSafeSkillName(name),
  );
  const realpath = deps.realpath ?? tryRealpath;
  const probed = catalogDirs(deps.config, deps.exists);
  // A listed path may be a link: the run's directory is a real path, so both are compared.
  const candidates = probed.flatMap((path) => {
    const real = realpath(path);
    return real === undefined || real === path
      ? [{ path, dir: path }]
      : [
          { path, dir: path },
          { path: real, dir: path },
        ];
  });
  const covering = coveringDir(candidates, realpath(cwd) ?? cwd);
  const dir = candidates.find(({ path }) => path === covering?.path)?.dir;
  if (dir === undefined) return false;
  deps.store.writeInit(dir, { hash: hashSkillNames(names), skills: names.slice(0, MAX_REPORTED_SKILLS) });
  return true;
}

/** The `claude` a worker runs, realpathed so that an update that replaces a link is seen, and where it keeps its configuration. */
export function realFingerprintDeps(env: NodeJS.ProcessEnv = process.env): FingerprintDeps {
  const found = whichOnPath(CLAUDE_COMMAND, env['PATH']);
  return {
    claude: found === undefined ? undefined : (tryRealpath(found) ?? found),
    mtime: realMtime,
    claudeDir: claudeConfigDir(env),
  };
}

/** The `skills` of a line of a run's output when it is the `system/init` event that has them; undefined for any other line. */
export function initSkillsIn(line: string): unknown[] | undefined {
  if (!line.includes('"init"')) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || event['type'] !== 'system' || event['subtype'] !== 'init') return undefined;
  const skills = event['skills'];
  return Array.isArray(skills) ? (skills as unknown[]) : undefined;
}

/** `~/.claude`, or where CLAUDE_CONFIG_DIR puts it: what the probe's own `claude` reads. */
export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string =>
  env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude');
