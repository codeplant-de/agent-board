// An agent definition as a document of its own, YAML or JSON: what `board agents export` prints, `board agents add` reads
// and the files of the agents/ directory hold. The keys are those of a config.json `agents` entry plus `name`.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { AgentConfig } from './config.mts';
import { ConfigError } from './config-error.mts';

export type AgentFormat = 'yaml' | 'json';

// A definition is a few kilobytes; anything near this is not one.
export const MAX_AGENT_DOCUMENT_BYTES = 256 * 1024;

/**
 * The value a YAML or JSON document holds. JSON is read as JSON; anything else as YAML 1.2 (core schema), with duplicate keys
 * and aliases refused: an alias can make a small file expand to a huge value, and a duplicate key hides one of two lists.
 */
export function parseAgentDocument(text: string, label: string): unknown {
  if (Buffer.byteLength(text) > MAX_AGENT_DOCUMENT_BYTES)
    throw new ConfigError(
      `${label} is larger than ${MAX_AGENT_DOCUMENT_BYTES / 1024} KB, which no agent definition is`,
    );
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`${label} is not valid JSON (${error instanceof Error ? error.message : 'parse error'})`);
    }
  }
  try {
    return parse(text, { schema: 'core', uniqueKeys: true, maxAliasCount: 0, merge: false, prettyErrors: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'parse error';
    throw new ConfigError(`${label} is not valid YAML or JSON (${reason?.slice(0, 200)})`);
  }
}

/** The document as text: YAML with block lists and a block prompt, or JSON with 2 spaces. Both end in a newline. */
export function renderAgentDocument(document: Record<string, unknown>, format: AgentFormat): string {
  if (format === 'json') return `${JSON.stringify(document, null, 2)}\n`;
  return stringify(document, { lineWidth: 0, blockQuote: 'literal' });
}

/** The shareable document of an agent: its keys in a fixed order, empty optional lists left out. */
export function agentDocument(name: string, agent: AgentConfig, { withSource = true } = {}): Record<string, unknown> {
  return {
    name,
    ...(agent.version === undefined ? {} : { version: agent.version }),
    description: agent.description,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    tools: agent.tools,
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    ...(agent.env.length === 0 ? {} : { env: agent.env }),
    ...(agent.mcpServers.length === 0 ? {} : { mcpServers: agent.mcpServers }),
    ...(agent.prompt === undefined ? {} : { prompt: agent.prompt }),
    ...(withSource && agent.source !== undefined ? { source: agent.source } : {}),
  };
}

/** Writes `<dir>/<name>.yaml` beside a temp file and renames it into place, mode 0600; another file for the name goes. */
export function writeAgentFile(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${name}.yaml`);
  const temp = join(dir, `.${name}.tmp-${process.pid}`);
  try {
    rmSync(temp, { force: true });
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  for (const other of [`${name}.yml`, `${name}.json`]) rmSync(join(dir, other), { force: true });
  return target;
}
