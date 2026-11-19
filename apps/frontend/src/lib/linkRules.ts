// Turns text that a link rule matches into links, for the markdown the browser renders. A remark plugin over the mdast tree:
// only text nodes are split, so code, existing links, definitions and HTML are left as they are.
import { linkRuleProblem, type LinkRule } from '@agent-board/shared';

/** The part of an mdast node this plugin reads and writes. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
}

interface CompiledRule {
  regex: RegExp;
  url: string;
}

/** Text inside these is already a link or is not prose. */
const SKIPPED = new Set(['link', 'linkReference', 'inlineCode', 'code', 'definition', 'html']);

const compiled = new WeakMap<readonly LinkRule[], CompiledRule[]>();

/** The rules ready to match, once per list; a rule that does not work is left out. */
function compile(rules: readonly LinkRule[]): CompiledRule[] {
  const known = compiled.get(rules);
  if (known !== undefined) return known;
  const ready = rules
    .filter((rule) => linkRuleProblem(rule) === undefined)
    .map(({ pattern, url, flags }) => ({ regex: new RegExp(pattern, `${flags ?? ''}g`), url }));
  compiled.set(rules, ready);
  return ready;
}

/** `$1`..`$9`, `$<name>`, `$&` and `$$` of the template, with the captured text percent-encoded. Anything else stays. */
function fill(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(?:([1-9])|<([^>]*)>|(&)|(\$))/g, (whole, digit?: string, name?: string, all?: string) => {
    if (digit !== undefined) {
      const index = Number(digit);
      return index < match.length ? encodeURIComponent(match[index] ?? '') : whole;
    }
    if (name !== undefined) {
      const named = match.groups;
      return named !== undefined && name in named ? encodeURIComponent(named[name] ?? '') : whole;
    }
    return all === undefined ? '$' : encodeURIComponent(match[0]);
  });
}

/** The link target of a match, or undefined when the filled template is not an http or https URL. */
function targetOf(rule: CompiledRule, match: RegExpExecArray): string | undefined {
  try {
    const url = new URL(fill(rule.url, match));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

interface Candidate {
  match: RegExpExecArray;
  url: string;
}

/** The first match of the rule at or after `from` that is not empty and has a valid target; null when there is none. */
function candidateFrom(rule: CompiledRule, text: string, from: number): Candidate | null {
  let at = from;
  while (at <= text.length) {
    rule.regex.lastIndex = at;
    const match = rule.regex.exec(text);
    if (match === null) return null;
    const url = match[0] === '' ? undefined : targetOf(rule, match);
    if (url !== undefined) return { match, url };
    at = match.index + 1;
  }
  return null;
}

/** The nodes a text becomes, or undefined when no rule matches it. The earliest match wins, the earlier rule on a tie. */
function split(text: string, rules: CompiledRule[]): MdNode[] | undefined {
  const found: (Candidate | null | undefined)[] = rules.map(() => undefined);
  const nodes: MdNode[] = [];
  let position = 0;
  for (;;) {
    let best: Candidate | undefined;
    for (const [index, rule] of rules.entries()) {
      const known = found[index];
      const candidate =
        known !== undefined && (known === null || known.match.index >= position)
          ? known
          : candidateFrom(rule, text, position);
      found[index] = candidate;
      if (candidate !== null && (best === undefined || candidate.match.index < best.match.index)) best = candidate;
    }
    if (best === undefined) break;
    const { match, url } = best;
    if (match.index > position) nodes.push({ type: 'text', value: text.slice(position, match.index) });
    nodes.push({ type: 'link', url, title: null, children: [{ type: 'text', value: match[0] }] });
    position = match.index + match[0].length;
  }
  if (nodes.length === 0) return undefined;
  if (position < text.length) nodes.push({ type: 'text', value: text.slice(position) });
  return nodes;
}

function linkIn(parent: MdNode, rules: CompiledRule[]): void {
  if (parent.children === undefined) return;
  parent.children = parent.children.flatMap((child) => {
    if (SKIPPED.has(child.type)) return [child];
    if (child.type === 'text' && child.value !== undefined) return split(child.value, rules) ?? [child];
    linkIn(child, rules);
    return [child];
  });
}

/** The remark plugin: `remarkPlugins={[[remarkLinkRules, { rules }]]}`. Keep `rules` the same array between renders. */
export function remarkLinkRules({ rules }: { rules: readonly LinkRule[] }): (tree: MdNode) => void {
  const ready = compile(rules);
  return (tree) => {
    if (ready.length > 0) linkIn(tree, ready);
  };
}
