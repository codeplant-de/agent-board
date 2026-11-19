// The link rules of the user (`links`): one sealed document of all of them, `{"version":n,"rules":[{"pattern":"…","url":"…"}]}`,
// bound to its version. A rule turns the text its pattern matches into a link wherever the browser renders markdown. Only the
// browser seals and opens it; no machine and no agent sees a rule, and the server holds nothing it can read. One document
// rather than one row per rule keeps the patterns out of the clear and makes a save atomic: the server can neither relabel an
// old document as a newer one (the version is in the binding) nor drop or reorder a rule (the list is inside the ciphertext).
import { ContractError, MAX_INT32 } from './contract.mts';
import { isRecord } from './guards.mts';
import type { Binding, Opener, Sealer } from './sealing.mts';
import { sealChecked } from './sealing.mts';

export interface LinkRule {
  /** A JavaScript regular expression. Matching is always global; capture groups feed the URL template. */
  pattern: string;
  /** The link target: `$1`..`$9`, `$<name>`, `$&` and `$$` are replaced by the match. Starts with https:// or http://. */
  url: string;
  /** `i` for a case-insensitive pattern; left out otherwise. */
  flags?: 'i';
}

export interface LinkRulesDocument {
  version: number;
  rules: LinkRule[];
}

export const MAX_LINK_RULES = 50;
export const MAX_LINK_PATTERN_CHARS = 300;
export const MAX_LINK_URL_CHARS = 1000;

/** A version of the link rules: a counter from 1 that only goes up. */
export const isLinkRulesVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_INT32;

/** The binding of the document of version `version`: a document sealed for one version never opens as another. */
export function linkRulesBinding(version: number): Binding {
  if (!isLinkRulesVersion(version)) throw new ContractError('the version of the link rules must be a positive integer');
  return { field: 'links', context: `links:v${version}` };
}

/** What is wrong with one rule, in words for the person who wrote it, or undefined when it is fine. */
export function linkRuleProblem(rule: LinkRule): string | undefined {
  if (rule.pattern === '') return 'the pattern is empty';
  if (rule.pattern.length > MAX_LINK_PATTERN_CHARS)
    return `the pattern is longer than ${MAX_LINK_PATTERN_CHARS} characters`;
  if (rule.flags !== undefined && rule.flags !== 'i') return 'the only flag is i';
  try {
    new RegExp(rule.pattern, `${rule.flags ?? ''}g`);
  } catch {
    return 'the pattern is not a valid regular expression';
  }
  if (rule.url.length > MAX_LINK_URL_CHARS) return `the URL is longer than ${MAX_LINK_URL_CHARS} characters`;
  if (!/^https?:\/\/./i.test(rule.url)) return 'the URL must start with https:// or http://';
  return undefined;
}

/** The document as text, the rules in their order. */
export function linkRulesJson(document: LinkRulesDocument): string {
  return JSON.stringify({
    version: document.version,
    rules: document.rules.map(({ pattern, url, flags }) => ({
      pattern,
      url,
      ...(flags === undefined ? {} : { flags }),
    })),
  });
}

function documentProblem(document: LinkRulesDocument): string | undefined {
  if (!isLinkRulesVersion(document.version)) return 'a version that is not a positive integer';
  if (document.rules.length > MAX_LINK_RULES) return `more than ${MAX_LINK_RULES} rules`;
  for (const [index, rule] of document.rules.entries()) {
    const problem = linkRuleProblem(rule);
    if (problem !== undefined) return `a rule (number ${index + 1}) where ${problem}`;
  }
  return undefined;
}

/** Seals the document under its own version; refuses more rules than the board takes and a rule that does not work. */
export async function sealLinkRules(seal: Sealer, document: LinkRulesDocument): Promise<string> {
  const problem = documentProblem(document);
  if (problem !== undefined) throw new ContractError(`the link rules have ${problem}`);
  return sealChecked(seal, linkRulesBinding(document.version), linkRulesJson(document), 'the link rules');
}

function parseRule(value: unknown): LinkRule | undefined {
  if (!isRecord(value)) return undefined;
  const { pattern, url, flags } = value;
  if (typeof pattern !== 'string' || typeof url !== 'string') return undefined;
  if (flags !== undefined && flags !== 'i') return undefined;
  const rule: LinkRule = flags === undefined ? { pattern, url } : { pattern, url, flags };
  return linkRuleProblem(rule) === undefined ? rule : undefined;
}

/**
 * The document the board holds as version `version`, or undefined when it is unreadable: it does not open under exactly that
 * version's binding, says another version inside, or is not `{"version":n,"rules":[…]}` of rules that work.
 */
export async function openLinkRules(
  open: Opener,
  version: number,
  wire: string,
): Promise<LinkRulesDocument | undefined> {
  if (!isLinkRulesVersion(version)) return undefined;
  const text = await open(linkRulesBinding(version), wire);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(json) || json['version'] !== version) return undefined;
  const list = json['rules'];
  if (!Array.isArray(list) || list.length > MAX_LINK_RULES) return undefined;
  const rules = list.map(parseRule);
  return rules.every((rule) => rule !== undefined) ? { version, rules } : undefined;
}
