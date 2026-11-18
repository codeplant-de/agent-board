// The agent definitions the board holds for every machine of the user (`agents.shared`): one sealed document of all of them,
// `{"version":n,"agents":{"<name>":{…keys of an agent file…}}}`, bound to its version. Only the CLI writes it (`board agents
// push`); every machine opens it under the version the board reports and applies it. One document rather than one row per
// agent keeps the names out of the clear and makes a push atomic: the server can neither relabel an old document as a newer
// one (the version is in the binding) nor swap one agent's definition for another's (the names are inside the ciphertext).
// The entries are checked here only for their shape; the CLI reads each with the strict parser of an agent file.
import { AGENT_NAME_RULE, ContractError, isAgentName, isSharedAgentsVersion } from './contract.mts';
import { isRecord } from './guards.mts';
import type { Binding, Opener, Sealer } from './sealing.mts';
import { sealChecked } from './sealing.mts';

/** One agent as the document holds it: exactly the keys of an agent file, without `name` and `source`. */
export type SharedAgentEntry = Record<string, unknown>;

export interface SharedAgentsDocument {
  version: number;
  agents: Record<string, SharedAgentEntry>;
}

/** The most agents the document holds; far more than anyone defines. */
export const MAX_SHARED_AGENTS = 200;

/** The binding of the document of version `version`: a document sealed for one version never opens as another. */
export function sharedAgentsBinding(version: number): Binding {
  if (!isSharedAgentsVersion(version))
    throw new ContractError('the version of the shared agents must be a positive integer');
  return { field: 'agents.shared', context: `agents:v${version}` };
}

/** The document as text: the agents by name, in order, so the same definitions always make the same bytes. */
export function sharedAgentsJson(document: SharedAgentsDocument): string {
  const names = Object.keys(document.agents).sort();
  return JSON.stringify({
    version: document.version,
    agents: Object.fromEntries(names.map((name) => [name, document.agents[name]])),
  });
}

function documentProblem(document: SharedAgentsDocument): string | undefined {
  if (!isSharedAgentsVersion(document.version)) return 'a version that is not a positive integer';
  const names = Object.keys(document.agents);
  if (names.length > MAX_SHARED_AGENTS) return `more than ${MAX_SHARED_AGENTS} agents`;
  const bad = names.find((name) => !isAgentName(name));
  if (bad !== undefined) return `the agent name "${bad.slice(0, 40)}", which must be ${AGENT_NAME_RULE}`;
  const notEntry = names.find((name) => !isRecord(document.agents[name]));
  if (notEntry !== undefined) return `an entry for ${notEntry} that is not a mapping of an agent's keys`;
  return undefined;
}

/** Seals the document under its own version; refuses more agents than the board takes and a name that is not an agent's. */
export async function sealSharedAgents(seal: Sealer, document: SharedAgentsDocument): Promise<string> {
  const problem = documentProblem(document);
  if (problem !== undefined) throw new ContractError(`the shared agents have ${problem}`);
  return sealChecked(seal, sharedAgentsBinding(document.version), sharedAgentsJson(document), 'the shared agents');
}

/**
 * The document the board holds as version `version`, or undefined when it is unreadable: it does not open under exactly that
 * version's binding, says another version inside, or is not `{"version":n,"agents":{…}}` with agent names and mappings.
 */
export async function openSharedAgents(
  open: Opener,
  version: number,
  wire: string,
): Promise<SharedAgentsDocument | undefined> {
  if (!isSharedAgentsVersion(version)) return undefined;
  const text = await open(sharedAgentsBinding(version), wire);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(json) || json['version'] !== version || !isRecord(json['agents'])) return undefined;
  const document: SharedAgentsDocument = { version, agents: json['agents'] as Record<string, SharedAgentEntry> };
  return documentProblem(document) === undefined ? document : undefined;
}

// The keys that decide what a run as the agent may do; `version` and `source` are metadata and change nothing.
const RUN_KEYS = ['description', 'prompt', 'model', 'tools', 'allowedTools', 'disallowedTools', 'env', 'mcpServers'];
const LIST_KEYS = new Set(['tools', 'allowedTools', 'disallowedTools', 'env', 'mcpServers']);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** The bytes an agent's hash is made of: its run-relevant keys as canonical JSON, a missing list as an empty one. */
export function agentHashInput(agent: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {};
  for (const key of RUN_KEYS) {
    const value = agent[key] ?? (LIST_KEYS.has(key) ? [] : undefined);
    if (value !== undefined) picked[key] = value;
  }
  return JSON.stringify(canonical(picked));
}

/** SHA-256 of `agentHashInput`, lowercase hex: the same definition has the same hash on every machine and in the browser. */
export async function agentHash(agent: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(agentHashInput(agent)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const isAgentHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
