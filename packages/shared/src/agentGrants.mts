// The flags on an agent's grants that a person must see before they trust it: allow rules that allow nearly anything, env
// variables that look like secrets, an empty deny list, and allow rules for tools the agent does not have. `board agents
// add` and `push` print them before they ask, and the browser's Agents page shows them beside the board's definitions, so
// both read the same definition the same way.

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

/** Whether an env variable's name says it holds a secret; the run gets its value. */
export const looksSecret = (name: string): boolean => SECRET_NAME.test(name);

/** The tools `allowedTools` has rules for that `tools` leaves out, once each: those rules allow nothing. MCP rules aside. */
export function deadAllowTools(agent: { tools: readonly string[]; allowedTools: readonly string[] }): string[] {
  return [
    ...new Set(
      agent.allowedTools
        .map((rule) => rule.split('(')[0] ?? rule)
        .filter((tool) => !tool.startsWith('mcp__') && !agent.tools.includes(tool)),
    ),
  ];
}

export interface GrantFlags {
  // Each broad allow rule, with why it is broad.
  broad: { rule: string; reason: string }[];
  // The env variables that look like secrets.
  secrets: string[];
  emptyDenyList: boolean;
  // See `deadAllowTools`.
  deadTools: string[];
}

/** Every flag on an agent's grants. */
export function grantFlags(agent: {
  tools: readonly string[];
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  env: readonly string[];
}): GrantFlags {
  return {
    broad: agent.allowedTools.flatMap((rule) => {
      const reason = broadRule(rule);
      return reason === undefined ? [] : [{ rule, reason }];
    }),
    secrets: agent.env.filter(looksSecret),
    emptyDenyList: agent.disallowedTools.length === 0,
    deadTools: deadAllowTools(agent),
  };
}
