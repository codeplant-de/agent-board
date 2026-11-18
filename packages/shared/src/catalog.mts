// The machine catalogue: the skills (slash commands) and Claude models a machine's CLI found by asking `claude`, sent to the
// board as one sealed document (`machine.catalog`, see sealing.mts) so the browser can complete `/skill` and offer the models.
// It is advice for what a form offers and is never acted on. Everything in it came from a program's output, so every text is
// cleaned before it is sent and shape-checked again when it is opened.
import { hasControlCharacter, isAgentName, isModelName, isSafeWorkdir, isSharedAgentsVersion } from './contract.mts';
import { isRecord } from './guards.mts';

export interface CatalogModel {
  value: string;
  label: string;
  description?: string;
}

export interface CatalogSkill {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** What a machine has of the agents: which version of the board's definitions it applied, and the hash of each agent it has. */
export interface CatalogAgents {
  // The version of the board's agent definitions the machine applied last; null when it applied none.
  version: number | null;
  // `agentHash` of every agent the machine has, wherever it is defined, by name: the browser tells from it who runs what.
  hashes: Record<string, string>;
  // The agents whose definition on the machine an apply moved aside for the board's, while the moved file is kept.
  replaced: string[];
}

/**
 * `skills` are those every probed directory has; `dirs[path]` are the skills only that directory has (a path with none is
 * left out). With one probed directory everything is in `skills`.
 */
export interface MachineCatalog {
  claude?: string;
  models: CatalogModel[];
  skills: CatalogSkill[];
  dirs: Record<string, CatalogSkill[]>;
  // Absent from a CLI before shared agents.
  agents?: CatalogAgents;
}

export const MAX_CATALOG_MODELS = 50;
export const MAX_CATALOG_SKILLS = 500;
export const MAX_CATALOG_DIRS = 200;
export const MAX_CATALOG_DIR_SKILLS = 200;
export const MAX_CATALOG_VERSION_CHARS = 64;
export const MAX_CATALOG_LABEL_CHARS = 64;
export const MAX_CATALOG_DESCRIPTION_CHARS = 200;
export const MAX_CATALOG_HINT_CHARS = 100;
export const MAX_CATALOG_AGENTS = 500;

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

/** A skill name as a user types it after `/`: no spaces, so an MCP prompt entry like `Notion:… (MCP)` is not one. */
export function isSafeSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

/** One line of plain text from an untrusted source: control characters gone, whitespace collapsed, cut to `max` characters. */
export function cleanCatalogText(text: string, max: number): string {
  // A control character separates like whitespace does, so `a\u0007b` is not glued into `ab`.
  const line = Array.from(text, (char) => (hasControlCharacter(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(line).slice(0, max).join('').trim();
}

// What a cleaned text looks like: a non-empty line of at most `max` characters.
function isCatalogText(value: unknown, max: number): value is string {
  if (typeof value !== 'string') return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= max && value === value.trim() && !hasControlCharacter(value);
}

function optionalText(value: unknown, max: number): string | undefined {
  return isCatalogText(value, max) ? value : undefined;
}

function parseSkill(entry: unknown): CatalogSkill | undefined {
  if (!isRecord(entry)) return undefined;
  const { name } = entry;
  if (typeof name !== 'string' || !isSafeSkillName(name)) return undefined;
  const description = optionalText(entry['description'], MAX_CATALOG_DESCRIPTION_CHARS);
  const argumentHint = optionalText(entry['argumentHint'], MAX_CATALOG_HINT_CHARS);
  return {
    name,
    ...(description === undefined ? {} : { description }),
    ...(argumentHint === undefined ? {} : { argumentHint }),
  };
}

function parseModel(entry: unknown): CatalogModel | undefined {
  if (!isRecord(entry)) return undefined;
  const { value } = entry;
  if (typeof value !== 'string' || !isModelName(value)) return undefined;
  const description = optionalText(entry['description'], MAX_CATALOG_DESCRIPTION_CHARS);
  return {
    value,
    label: optionalText(entry['label'], MAX_CATALOG_LABEL_CHARS) ?? value,
    ...(description === undefined ? {} : { description }),
  };
}

// A list of entries `parse` keeps or drops one by one; undefined when it is not a list or has more than `max` entries.
function parseList<T>(value: unknown, max: number, parse: (entry: unknown) => T | undefined): T[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return undefined;
  const entries: unknown[] = value;
  return entries.flatMap((entry) => parse(entry) ?? []);
}

const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// The agents part of a catalogue: undefined when it is absent or not of its shape, which loses only this part.
function parseAgents(value: unknown): CatalogAgents | undefined {
  if (!isRecord(value)) return undefined;
  const { version, hashes, replaced } = value;
  if (version !== null && !isSharedAgentsVersion(version)) return undefined;
  if (!isRecord(hashes) || Object.keys(hashes).length > MAX_CATALOG_AGENTS) return undefined;
  if (!Array.isArray(replaced) || replaced.length > MAX_CATALOG_AGENTS) return undefined;
  const names: unknown[] = replaced;
  return {
    version,
    hashes: Object.fromEntries(
      Object.entries(hashes).flatMap(([name, hash]) => (isAgentName(name) && isHash(hash) ? [[name, hash]] : [])),
    ),
    replaced: names.filter((name): name is string => typeof name === 'string' && isAgentName(name)),
  };
}

/**
 * The catalogue in a decoded document, or undefined when it is unreadable: not an object, `models`, `skills` or `dirs` of
 * another shape, or more entries than the caps allow. An entry that is not of its shape (a skill without a safe name, a model
 * without a model name, a path that is not a safe absolute one) is dropped without losing the document, and so is a text that
 * is not a clean one. A missing list is empty and other keys are ignored, so a later CLI can add some.
 */
export function parseMachineCatalog(json: unknown): MachineCatalog | undefined {
  if (!isRecord(json)) return undefined;
  const models = parseList(json['models'], MAX_CATALOG_MODELS, parseModel);
  const skills = parseList(json['skills'], MAX_CATALOG_SKILLS, parseSkill);
  const rawDirs = json['dirs'] ?? {};
  if (models === undefined || skills === undefined || !isRecord(rawDirs)) return undefined;
  const paths = Object.keys(rawDirs);
  if (paths.length > MAX_CATALOG_DIRS) return undefined;
  const dirs: Record<string, CatalogSkill[]> = {};
  for (const path of paths) {
    if (!isSafeWorkdir(path)) continue;
    const list = parseList(rawDirs[path], MAX_CATALOG_DIR_SKILLS, parseSkill);
    if (list === undefined) return undefined;
    if (list.length > 0) dirs[path] = list;
  }
  const claude = optionalText(json['claude'], MAX_CATALOG_VERSION_CHARS);
  const agents = parseAgents(json['agents']);
  return {
    ...(claude === undefined ? {} : { claude }),
    models,
    skills,
    dirs,
    ...(agents === undefined ? {} : { agents }),
  };
}

/** The one document a catalogue is sealed as, and the bytes its blind index is made of: known fields only, in a fixed order. */
export function machineCatalogJson(catalog: MachineCatalog): string {
  const skill = ({ name, description, argumentHint }: CatalogSkill): CatalogSkill => ({
    name,
    ...(description === undefined ? {} : { description }),
    ...(argumentHint === undefined ? {} : { argumentHint }),
  });
  return JSON.stringify({
    ...(catalog.claude === undefined ? {} : { claude: catalog.claude }),
    models: catalog.models.map(({ value, label, description }) => ({
      value,
      label,
      ...(description === undefined ? {} : { description }),
    })),
    skills: catalog.skills.map(skill),
    dirs: Object.fromEntries(Object.entries(catalog.dirs).map(([path, list]) => [path, list.map(skill)])),
    ...(catalog.agents === undefined
      ? {}
      : {
          agents: {
            version: catalog.agents.version,
            hashes: Object.fromEntries(
              Object.keys(catalog.agents.hashes)
                .sort()
                .map((name) => [name, catalog.agents?.hashes[name]]),
            ),
            replaced: [...catalog.agents.replaced].sort(),
          },
        }),
  });
}

/** What is wrong with a catalogue the board would not take, or undefined; the sender checks before it seals. */
export function catalogProblem(catalog: MachineCatalog): string | undefined {
  if (catalog.models.length > MAX_CATALOG_MODELS) return `more than ${MAX_CATALOG_MODELS} models`;
  if (catalog.skills.length > MAX_CATALOG_SKILLS) return `more than ${MAX_CATALOG_SKILLS} skills`;
  const paths = Object.keys(catalog.dirs);
  if (paths.length > MAX_CATALOG_DIRS) return `more than ${MAX_CATALOG_DIRS} directories`;
  if (paths.some((path) => (catalog.dirs[path]?.length ?? 0) > MAX_CATALOG_DIR_SKILLS))
    return `a directory with more than ${MAX_CATALOG_DIR_SKILLS} skills`;
  if (catalog.agents !== undefined && Object.keys(catalog.agents.hashes).length > MAX_CATALOG_AGENTS)
    return `more than ${MAX_CATALOG_AGENTS} agents`;
  // What a round trip through the document keeps is what the board will show; anything it would drop is a mistake of the sender.
  const kept = parseMachineCatalog(JSON.parse(machineCatalogJson(catalog)));
  if (kept === undefined || machineCatalogJson(kept) !== machineCatalogJson(catalog)) {
    return 'an entry that is not of its shape: a skill name, a model name, an absolute path or a clean one-line text';
  }
  return undefined;
}
