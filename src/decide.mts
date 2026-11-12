import type { LabelEntry } from "./config.mts";
import type { TrelloCard, TrelloComment } from "./trello.mts";

export const START_MARKER = "agent-board: started";
// The worker enforces the timeout itself; the sweep only catches a worker that cannot.
const SWEEP_GRACE_MINUTES = 5;

export function unitName(shortLink: string): string {
  return `agent-board-${shortLink}`;
}

export type LabelResolution =
  | { known: true; label: string; entry: LabelEntry }
  | { known: false; reason: string };

export function resolveLabel(card: TrelloCard, labels: Record<string, LabelEntry>): LabelResolution {
  for (const { name } of card.labels) {
    const entry = Object.hasOwn(labels, name) ? labels[name] : undefined;
    if (entry) return { known: true, label: name, entry };
  }
  const names = card.labels.map((label) => label.name);
  const have = names.length > 0 ? `its labels are ${names.join(", ")}` : "it has no label";
  return { known: false, reason: `No worker is configured for this card: ${have}. Known labels: ${Object.keys(labels).join(", ")}.` };
}

export function freeSlots(runningCount: number, maxParallel: number): number {
  return Math.max(0, maxParallel - runningCount);
}

// A card's position in its list is its priority: lowest first.
export function byPriority(cards: TrelloCard[]): TrelloCard[] {
  return [...cards].sort((a, b) => a.pos - b.pos);
}

export function startedAt(comments: TrelloComment[]): Date | undefined {
  const starts = comments.filter((comment) => comment.text.startsWith(START_MARKER));
  return starts.sort((a, b) => b.date.getTime() - a.date.getTime())[0]?.date;
}

export type StaleDecision = { stale: false } | { stale: true; reason: string; stopUnit: boolean };

export function decideStale(input: {
  unitActive: boolean;
  startedAt: Date | undefined;
  now: Date;
  timeoutMinutes: number;
}): StaleDecision {
  if (!input.unitActive) return { stale: true, reason: "The worker is no longer running.", stopUnit: false };
  if (input.startedAt === undefined) return { stale: false };
  const ageMinutes = (input.now.getTime() - input.startedAt.getTime()) / 60_000;
  if (ageMinutes > input.timeoutMinutes + SWEEP_GRACE_MINUTES) {
    return {
      stale: true,
      reason: `The worker has been running for ${Math.round(ageMinutes)} minutes, over the timeout of ${input.timeoutMinutes}.`,
      stopUnit: true,
    };
  }
  return { stale: false };
}

export interface CardInput {
  input: string;
  head: string | undefined;
}

// First line is the input (the PR URL); intake adds a `head: <sha>` line.
export function parseDesc(desc: string): CardInput {
  const lines = desc.split("\n").map((line) => line.trim());
  const head = lines.map((line) => /^head:\s*([0-9a-f]{7,40})$/i.exec(line)?.[1]).find((sha) => sha !== undefined);
  return { input: lines[0] ?? "", head };
}

export function formatDesc(url: string, head: string): string {
  return `${url}\nhead: ${head}`;
}

export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/.exec(url);
  if (!match?.[1] || !match[2]) return undefined;
  return { repo: match[1], number: Number(match[2]) };
}

export const PLUGIN_PLACEHOLDER = "{pr-review}";

export function usesPluginPlaceholder(entry: LabelEntry): boolean {
  return entry.kind === "skill" && [...entry.allowedTools, ...entry.disallowedTools].some((rule) => rule.includes(PLUGIN_PLACEHOLDER));
}

// `~/` is expanded inside Bash rules only: Read rules read `~/` themselves, and an absolute path there would mean "from the project root".
export function expandRule(rule: string, home: string, prReviewPath: string | undefined): string {
  if (!rule.startsWith("Bash(")) return rule;
  const expanded = rule.replaceAll("~/", `${home}/`);
  return prReviewPath === undefined ? expanded : expanded.replaceAll(PLUGIN_PLACEHOLDER, prReviewPath);
}

export type Outcome = { kind: "ok" } | { kind: "failed"; reason: string } | { kind: "unreported" };

export function decideOutcome(input: {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  timeoutMinutes: number;
  // The worker (or the skill) moved the card to Needs me or Done.
  reported: boolean;
}): Outcome {
  if (input.timedOut) return { kind: "failed", reason: `Timed out after ${input.timeoutMinutes} minutes and was stopped.` };
  if (input.exitCode !== 0) {
    const how = input.signal ? `was killed by ${input.signal}` : `exited with code ${input.exitCode}`;
    return { kind: "failed", reason: `The worker ${how}.` };
  }
  return input.reported ? { kind: "ok" } : { kind: "unreported" };
}

export interface Invocation {
  command: string;
  args: string[];
  cwd: string;
}

export type InvocationPlan = { ok: true; invocation: Invocation } | { ok: false; reason: string };

export function buildInvocation(input: {
  entry: LabelEntry;
  card: TrelloCard;
  repos: Record<string, string>;
  home: string;
  fallbackCwd: string;
  // Install path of the pr-review plugin; undefined when it could not be resolved.
  prReviewPath: string | undefined;
}): InvocationPlan {
  const { entry, card, repos, home } = input;
  if (entry.kind === "command") {
    const [command, ...args] = entry.command;
    if (command === undefined) return { ok: false, reason: "The label's command is empty." };
    return { ok: true, invocation: { command, args, cwd: entry.cwd ?? input.fallbackCwd } };
  }
  const prompt = parseDesc(card.desc).input;
  let cwd = entry.cwd;
  if (cwd === "pr-repo") {
    const pr = parsePrUrl(prompt);
    if (!pr) return { ok: false, reason: `The first line of the description is not a GitHub PR URL: ${prompt || "(empty)"}` };
    const dir = repos[pr.repo];
    if (!dir) return { ok: false, reason: `No checkout is configured for ${pr.repo}. Add it to "repos" in config.json.` };
    cwd = dir;
  }
  if (usesPluginPlaceholder(entry) && input.prReviewPath === undefined) {
    return { ok: false, reason: `The pr-review plugin path is unknown, but the allow rules need ${PLUGIN_PLACEHOLDER}.` };
  }
  const expand = (rule: string): string => expandRule(rule, home, input.prReviewPath);
  // Prompt first: --allowedTools and --disallowedTools take every following argument.
  const args = [
    "-p",
    `/${entry.skill} ${card.shortLink} ${prompt}`,
    "--permission-mode",
    "dontAsk",
    // Project and local settings of the checkout carry their own allow rules and tokens; only the user's settings load.
    "--setting-sources",
    "user",
    "--allowedTools",
    ...entry.allowedTools.map(expand),
  ];
  if (entry.disallowedTools.length > 0) args.push("--disallowedTools", ...entry.disallowedTools.map(expand));
  return { ok: true, invocation: { command: "claude", args, cwd } };
}
