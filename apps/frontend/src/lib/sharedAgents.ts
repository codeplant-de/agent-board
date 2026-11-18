// What the Agents page shows of the board's agent definitions: each definition read for display, with the CLI's grant flags,
// and what every machine reports of it in its catalogue. Read only: the CLI's `board agents push` is the one writer.
import {
  agentHash,
  grantFlags,
  INVALID_VALUE,
  isStringList,
  type GrantFlags,
  type SharedAgentEntry,
} from '@agent-board/shared';
import type { OpenedCatalog } from './opening';
import { shownName } from './shapes';

/** The first 12 hex digits of a hash, as `board agents` prints it. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

const LISTS = ['tools', 'allowedTools', 'disallowedTools', 'env', 'mcpServers'] as const;
type ListKey = (typeof LISTS)[number];
const TEXTS = ['description', 'prompt', 'model', 'version', 'source'] as const;
type TextKey = (typeof TEXTS)[number];

export type SharedAgentView = Record<ListKey, string[]> &
  Record<TextKey, string | null> & {
    name: string;
    // `agentHash` of the definition, as the machines report it for the agent they run.
    hash: string;
    flags: GrantFlags;
    // Keys whose value is not of the shape an agent file takes; a machine refuses the definition with them.
    problems: string[];
    // The definition as pushed, as indented JSON.
    definition: string;
  };

/** One definition of the document, read for display. A key of the wrong shape is shown empty and named in `problems`. */
export async function viewSharedAgent(name: string, entry: SharedAgentEntry): Promise<SharedAgentView> {
  const problems: string[] = [];
  const list = (key: ListKey): string[] => {
    const value = entry[key] ?? [];
    if (isStringList(value)) return value;
    problems.push(`${key} is not a list of strings`);
    return [];
  };
  const text = (key: TextKey): string | null => {
    const value = entry[key];
    if (value === undefined || typeof value === 'string') return value ?? null;
    problems.push(`${key} is not text`);
    return null;
  };
  const lists = Object.fromEntries(LISTS.map((key) => [key, list(key)])) as Record<ListKey, string[]>;
  const texts = Object.fromEntries(TEXTS.map((key) => [key, text(key)])) as Record<TextKey, string | null>;
  if (texts.description === null || texts.description.trim() === '') problems.push('description is missing');
  if (lists.tools.length === 0) problems.push('tools is empty');
  return {
    name,
    ...lists,
    ...texts,
    hash: await agentHash(entry),
    flags: grantFlags(lists),
    problems,
    definition: JSON.stringify(entry, null, 2),
  };
}

/** The document's definitions, by name. */
export function viewSharedAgents(agents: Record<string, SharedAgentEntry>): Promise<SharedAgentView[]> {
  return Promise.all(
    Object.keys(agents)
      .sort()
      .map((name) => viewSharedAgent(name, agents[name] ?? {})),
  );
}

/** What one machine has of the board's agents, from its catalogue. */
export interface MachineAgents {
  machine: string;
  // False when the catalogue has no agents part: a CLI from before shared agents, or a catalogue that did not open.
  reports: boolean;
  // The version of the board's definitions it applied last; null when none.
  version: number | null;
  hashes: Record<string, string>;
  replaced: string[];
}

/** Every machine with a catalogue, by name; revoked machines have none. */
export function machineAgents(catalogs: readonly OpenedCatalog[]): MachineAgents[] {
  return catalogs.map(({ name, catalog }) => ({
    machine: shownName(name) ?? INVALID_VALUE,
    reports: catalog?.agents !== undefined,
    version: catalog?.agents?.version ?? null,
    hashes: catalog?.agents?.hashes ?? {},
    replaced: catalog?.agents?.replaced ?? [],
  }));
}

export type AgentOnMachine =
  { kind: 'silent' } | { kind: 'same' } | { kind: 'missing' } | { kind: 'other'; hash: string };

/** Whether a machine runs exactly the board's definition of an agent, another one, or none. */
export function agentOnMachine(machine: MachineAgents, agent: Pick<SharedAgentView, 'name' | 'hash'>): AgentOnMachine {
  if (!machine.reports) return { kind: 'silent' };
  const hash = machine.hashes[agent.name];
  if (hash === undefined) return { kind: 'missing' };
  return hash === agent.hash ? { kind: 'same' } : { kind: 'other', hash };
}
