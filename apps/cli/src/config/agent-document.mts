// An agent definition as a document of its own, YAML or JSON: what `board agents export` prints, `board agents add` reads
// and the files of the agents/ directory hold. The keys are those of a config.json `agents` entry plus `name`.
import { parse, stringify } from 'yaml';
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
