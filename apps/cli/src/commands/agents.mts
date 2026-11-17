// `board agents`: list, show, export, add and remove the agents of this machine. An agent definition is a permission
// grant (what a restricted run may do here), so `add` shows all of it and asks before it writes.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { AGENT_NAME_RULE, isAgentName, isRecord } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { parseAgentDocument, renderAgentDocument } from '../config/agent-document.mts';
import type { AgentFormat } from '../config/agent-document.mts';
import { fetchAgentText, parseAgentUrl } from '../config/agent-fetch.mts';
import type { FetchOptions } from '../config/agent-fetch.mts';
import { agentFileName, agentsDirOf, ConfigError, expandHome, loadConfig, parseAgent } from '../config/config.mts';
import type { AgentConfig, Config } from '../config/config.mts';
import { plainLine, plainText } from '../output/terminal.mts';
import { errorText } from '../output/text.mts';
import { pluginPlaceholders } from '../worker/plan.mts';
import { resolvePluginPath } from '../worker/plugins.mts';
import { rewriteConfigFile } from './dirs.mts';
import { exampleNames, exampleText } from './example.mts';

export interface AgentsDeps {
  configFile: string;
  cwd: string;
  home: string;
  dryRun: boolean;
  print: (line: string) => void;
  // Raw output: a document, written as it is.
  write: (text: string) => void;
  readStdin: () => Promise<string>;
  // Asks a person at a terminal; undefined when there is none, so only --yes can confirm.
  confirm: ((question: string) => Promise<boolean>) | undefined;
  fetch?: FetchOptions;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what this machine has

function machineAgents(deps: Pick<AgentsDeps, 'configFile'>): Config {
  return loadConfig(deps.configFile, { optionalConfig: true });
}

// Where an agent is defined: its agents/ file, or config.json.
const whereOf = (config: Config, name: string): string => {
  const file = config.agentFiles?.[name];
  return file === undefined ? 'config.json' : `agents/${basename(file)}`;
};

/** The plugin placeholders of an agent's rules, each with its root here or the reason it does not resolve. */
export function pluginRoots(
  agent: Pick<AgentConfig, 'allowedTools' | 'disallowedTools'>,
  home: string,
): { placeholder: string; root?: string; problem?: string }[] {
  return pluginPlaceholders([...agent.allowedTools, ...agent.disallowedTools]).map((placeholder) => {
    try {
      return { placeholder, root: resolvePluginPath(placeholder, join(home, '.claude', 'plugins')) };
    } catch (error) {
      return { placeholder, problem: errorText(error) };
    }
  });
}

// Why a defined agent cannot run here, or undefined when it can.
function unusable(config: Config, name: string, home: string): string | undefined {
  const problem = config.agentErrors[name];
  if (problem !== undefined) return problem;
  const agent = config.agents[name];
  if (agent === undefined) return 'not defined';
  const missing = pluginRoots(agent, home).find((plugin) => plugin.problem !== undefined);
  return missing === undefined ? undefined : `{${missing.placeholder}} does not resolve (${missing.problem})`;
}

export interface AgentRow {
  name: string;
  from: string;
  tools: string[];
  allowed: number;
  denied: number;
  version?: string;
  source?: string;
  usable: boolean;
  problem?: string;
}

export function agentRows(config: Config, home: string): AgentRow[] {
  const names = [...new Set([...Object.keys(config.agents), ...Object.keys(config.agentErrors)])].sort();
  return names.map((name) => {
    const agent = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
    const problem = unusable(config, name, home);
    return {
      name,
      from: whereOf(config, name),
      tools: agent?.tools ?? [],
      allowed: agent?.allowedTools.length ?? 0,
      denied: agent?.disallowedTools.length ?? 0,
      ...(agent?.version === undefined ? {} : { version: agent.version }),
      ...(agent?.source === undefined ? {} : { source: agent.source }),
      usable: problem === undefined,
      ...(problem === undefined ? {} : { problem }),
    };
  });
}

export function agentsList(deps: AgentsDeps, json: boolean): void {
  const rows = agentRows(machineAgents(deps), deps.home);
  if (json) {
    deps.write(`${JSON.stringify({ agents: rows }, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    deps.print('no agents are defined on this machine.');
    deps.print('"board agents add example:reviewer" adds the shipped reviewer; "board help agents" says more.');
    return;
  }
  for (const row of rows) {
    const head = `${plainLine(row.name)}${row.version === undefined ? '' : ` ${plainLine(row.version)}`}`;
    deps.print(
      `${head}  ${row.usable ? 'usable' : `NOT USABLE: ${plainLine(row.problem ?? '')}`}  (${plainLine(row.from)})`,
    );
    if (row.tools.length > 0)
      deps.print(
        `  tools ${row.tools.length}: ${plainLine(row.tools.join(', '))}; allow ${row.allowed}, deny ${row.denied}`,
      );
    if (row.source !== undefined) deps.print(`  source: ${plainLine(row.source)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Documents

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

function definedAgent(config: Config, name: string): AgentConfig {
  const agent = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
  if (agent !== undefined) return agent;
  const problem = config.agentErrors[name];
  if (problem !== undefined) throw new UsageError(`agent ${plainLine(name)} cannot be read: ${plainLine(problem)}`);
  const known = Object.keys(config.agents).sort();
  throw new UsageError(
    `no agent "${plainLine(name).slice(0, 40)}" here; ${known.length === 0 ? 'none is defined' : `the agents are ${known.join(', ')}`}`,
  );
}

/** `show` prints where the agent came from as well; `export` leaves that out, since it is this machine's history. */
export function agentsShow(deps: AgentsDeps, name: string, format: AgentFormat, { withSource = true } = {}): void {
  const agent = definedAgent(machineAgents(deps), name);
  deps.write(renderAgentDocument(agentDocument(name, agent, { withSource }), format));
}

// ---------------------------------------------------------------------------------------------------------------------
// What a definition grants

const BROAD_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'Read']);
const EVERYTHING = new Set(['*', '**', '/**', '//**', '~', '~/', '~/*', '~/**', '//', '/']);
// Commands that run whatever they are given, or reach out of the machine: a rule that allows them allows nearly anything.
const RUNS_ANYTHING =
  /^(?:bash|sh|zsh|fish|dash|python3?|node|bun|deno|perl|ruby|php|eval|exec|env|xargs|sudo|su|doas|ssh|scp|curl|wget|nc|npx|pnpx|bunx)(?:[\s:]|$)/;

/** Why an allow rule is broad, or undefined when it is narrow enough to read for itself. */
export function broadRule(rule: string): string | undefined {
  const open = rule.indexOf('(');
  if (open === -1) {
    if (BROAD_TOOLS.has(rule))
      return rule === 'Read' ? 'reads every file the deny list does not name' : `allows every ${rule} call`;
    if (/^mcp__[^_]+(?:__\*)?$/.test(rule) || /^mcp__.+__\*$/.test(rule)) return 'allows every tool of the MCP server';
    return undefined;
  }
  const tool = rule.slice(0, open);
  const argument = rule.slice(open + 1, rule.endsWith(')') ? -1 : undefined).trim();
  if (EVERYTHING.has(argument)) return `allows ${tool} on everything`;
  if (tool === 'Bash') {
    if (argument.startsWith('*')) return 'starts with *: matches any command that merely contains the rest';
    if (/^board(?::\*|\s+\*)/.test(argument))
      return 'covers every board command: board schedule and board agents add too, which start or grant work';
    if (RUNS_ANYTHING.test(argument)) return `runs ${argument.split(/[\s:]/)[0]}, which can run or reach anything`;
  }
  if ((tool === 'Read' || tool === 'Edit' || tool === 'Write') && /^(?:~\/?|\/\/?)\*\*?$/.test(argument))
    return `allows ${tool} on a whole tree`;
  return undefined;
}

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|COOKIE|SESSION|AUTH|(?:^|_)KEY(?:_|$)|APIKEY/i;

export const looksSecret = (name: string): boolean => SECRET_NAME.test(name);

/** Every line a person must see before the agent is written: what it may do, flagged where it is broad. */
export function grantSummary(name: string, agent: AgentConfig, home: string): { lines: string[]; warnings: string[] } {
  const lines: string[] = [];
  const warnings: string[] = [];
  const line = (text: string): number => lines.push(plainLine(text));
  line(`agent ${name}${agent.version === undefined ? '' : ` ${agent.version}`}: ${agent.description}`);
  if (agent.source !== undefined) line(`  source: ${agent.source}`);
  if (agent.model !== undefined) line(`  model: ${agent.model}`);
  line(`  tools (${agent.tools.length}): ${agent.tools.join(', ')}`);
  line(`  allowedTools (${agent.allowedTools.length}):`);
  for (const rule of agent.allowedTools) {
    const broad = broadRule(rule);
    line(`    ${broad === undefined ? '  ' : '! '}${rule}${broad === undefined ? '' : `   <- broad: ${broad}`}`);
    if (broad !== undefined) warnings.push(`allow rule ${rule}: ${broad}`);
  }
  line(`  disallowedTools (${agent.disallowedTools.length}):${agent.disallowedTools.length === 0 ? ' none' : ''}`);
  for (const rule of agent.disallowedTools) line(`      ${rule}`);
  if (agent.disallowedTools.length === 0)
    warnings.push('the deny list is empty: nothing is denied beyond what the allow rules leave out');
  line(
    `  env, copied from the working directory's settings (${agent.env.length}):${agent.env.length === 0 ? ' none' : ''}`,
  );
  for (const variable of agent.env) {
    const secret = looksSecret(variable);
    line(`    ${secret ? '! ' : '  '}${variable}${secret ? '   <- looks like a secret' : ''}`);
    if (secret) warnings.push(`env ${variable} looks like a secret: the run gets its value`);
  }
  line(
    `  mcpServers, from the working directory's .mcp.json: ${agent.mcpServers.length === 0 ? 'none' : agent.mcpServers.join(', ')}`,
  );
  for (const plugin of pluginRoots(agent, home)) {
    if (plugin.root !== undefined) line(`  {${plugin.placeholder}} resolves to ${plugin.root}`);
    else {
      line(`  {${plugin.placeholder}} does not resolve here: ${plugin.problem ?? ''}`);
      warnings.push(
        `{${plugin.placeholder}} does not resolve (${plugin.problem ?? ''}): a run as ${name} fails until it does`,
      );
    }
  }
  const dead = [
    ...new Set(
      agent.allowedTools
        .map((rule) => rule.split('(')[0] ?? rule)
        .filter((tool) => !tool.startsWith('mcp__') && !agent.tools.includes(tool)),
    ),
  ];
  if (dead.length > 0) warnings.push(`allowedTools has rules for ${dead.join(', ')}, which tools leaves out`);
  return { lines, warnings: warnings.map(plainLine) };
}

// ---------------------------------------------------------------------------------------------------------------------
// add

export interface AddFlags {
  name?: string;
  replace?: boolean;
  yes?: boolean;
}

// The text of a definition, and what to record as its source.
async function readSource(deps: AgentsDeps, from: string): Promise<{ text: string; source: string; stem?: string }> {
  if (from === '-') return { text: await deps.readStdin(), source: 'stdin' };
  if (from.startsWith('example:')) {
    const example = from.slice('example:'.length);
    const text = exampleText(`agents/${example}.yaml`);
    if (text === undefined) {
      const known = exampleNames()
        .filter((file) => file.startsWith('agents/'))
        .map((file) => `example:${file.slice('agents/'.length).replace(/\.yaml$/, '')}`);
      throw new UsageError(`no example agent "${plainLine(example).slice(0, 40)}"; there are ${known.join(', ')}`);
    }
    return { text, source: from, stem: example };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(from)) {
    const { url, sha256 } = parseAgentUrl(from);
    const text = await fetchAgentText(url, sha256, deps.fetch);
    return { text, source: url.href, stem: agentFileName(basename(url.pathname)) };
  }
  const path = resolve(deps.cwd, expandHome(from));
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error';
    throw new UsageError(`cannot read ${plainLine(path)} (${code})`);
  }
  return { text, source: path, stem: agentFileName(basename(path)) };
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

export async function agentsAdd(deps: AgentsDeps, from: string, flags: AddFlags): Promise<void> {
  const { text, source, stem } = await readSource(deps, from);
  const label = source === 'stdin' ? 'the definition on stdin' : plainLine(source).slice(0, 200);
  const document = parseAgentDocument(text, label);
  if (!isRecord(document)) throw new ConfigError(`${label} must hold a mapping of the agent's keys`);
  const { name: written, source: _theirs, ...entry } = document;
  if (written !== undefined && (typeof written !== 'string' || !isAgentName(written)))
    throw new ConfigError(`${label}: name must be ${AGENT_NAME_RULE}`);
  const name = flags.name ?? (typeof written === 'string' ? written : undefined) ?? stem;
  if (name === undefined) throw new UsageError(`${label} has no name; give it one with --name`);
  if (!isAgentName(name))
    throw new UsageError(`the agent name "${plainLine(name).slice(0, 40)}" must be ${AGENT_NAME_RULE}`);
  // The source is where this machine got the file, never what the file says about itself.
  const agent = parseAgent(name, { ...entry, source }, label);

  const config = machineAgents(deps);
  const defined = Object.hasOwn(config.agents, name) || Object.hasOwn(config.agentErrors, name);
  const inFile = Object.hasOwn(config.agentFiles ?? {}, name);
  if (defined && !inFile)
    throw new ConfigError(
      `agent ${name} is defined in config.json; remove it there (board agents rm ${name}) or add this one under another --name`,
    );
  if (defined && !flags.replace)
    throw new ConfigError(`agent ${name} exists (${whereOf(config, name)}); --replace overwrites it`);

  const rendered = renderAgentDocument(agentDocument(name, agent), 'yaml');
  deps.print(`The definition, as it would be written:`);
  deps.print('');
  for (const row of plainText(rendered).trimEnd().split('\n')) deps.print(`  ${row}`);
  deps.print('');
  const { lines, warnings } = grantSummary(name, agent, deps.home);
  deps.print('What a run as this agent may do on this machine:');
  for (const row of lines) deps.print(row);
  if (warnings.length > 0) {
    deps.print('');
    deps.print(`Check these (${warnings.length}):`);
    for (const warning of warnings) deps.print(`  ! ${warning}`);
  }
  deps.print('');
  const dir = agentsDirOf(deps.configFile);
  const target = join(dir, `${name}.yaml`);
  const action = `${defined ? 'replace' : 'write'} ${target}`;
  if (deps.dryRun) {
    deps.print(`DRY ${action}`);
    return;
  }
  if (!flags.yes) {
    if (deps.confirm === undefined)
      throw new ConfigError(
        'nothing was written: confirm at a terminal, or pass --yes once you have read the definition',
      );
    if (!(await deps.confirm(`${defined ? 'Replace' : 'Add'} agent ${name}?`))) {
      deps.print('nothing was written.');
      return;
    }
  }
  writeAgentFile(dir, name, rendered);
  deps.print(`${defined ? 'replaced' : 'added'} agent ${name}: ${target}`);
  deps.print(`tasks that name it run as it on this machine: board schedule --agent ${name} "<prompt>"`);
}

// ---------------------------------------------------------------------------------------------------------------------
// rm

export function agentsRemove(deps: AgentsDeps, name: string): void {
  const config = machineAgents(deps);
  const file = config.agentFiles?.[name];
  const inConfig = (() => {
    try {
      const raw: unknown = JSON.parse(readFileSync(deps.configFile, 'utf8'));
      return isRecord(raw) && isRecord(raw['agents']) && Object.hasOwn(raw['agents'], name);
    } catch {
      return false;
    }
  })();
  if (file === undefined && !inConfig) definedAgent(config, name);
  if (file !== undefined) {
    if (deps.dryRun) deps.print(`DRY remove ${file}`);
    else {
      rmSync(file, { force: true });
      deps.print(`removed agent ${name}: ${file}`);
    }
  }
  if (inConfig) {
    if (deps.dryRun) deps.print(`DRY remove agents.${name} from ${deps.configFile}`);
    else {
      rewriteConfigFile(deps.configFile, ({ raw }) => {
        const agents = isRecord(raw['agents']) ? { ...raw['agents'] } : {};
        delete agents[name];
        return { ...raw, agents };
      });
      deps.print(`removed agents.${name} from ${deps.configFile}`);
    }
  }
  deps.print(`tasks that name ${name} no longer run on this machine.`);
}
