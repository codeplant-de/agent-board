import type { LabelEntry, MaskedEnv } from "./config.mts";
import { formatAnswers } from "@agent-board/shared";
import type { Note, Task } from "@agent-board/shared";
import { buildSandboxSettings, PLUGIN_PLACEHOLDER, usesPlaceholder } from "./sandbox.mts";

export const START_MARKER = "agent-board: started";
// The worker enforces the timeout itself; the sweep only catches a worker that cannot.
const SWEEP_GRACE_MINUTES = 5;

export function unitName(taskId: string): string {
  return `agent-board-${taskId}`;
}

export type LabelResolution =
  | { known: true; label: string; entry: LabelEntry }
  | { known: false; reason: string };

export function resolveLabel(task: Task, labels: Record<string, LabelEntry>): LabelResolution {
  for (const name of task.labels) {
    const entry = Object.hasOwn(labels, name) ? labels[name] : undefined;
    if (entry) return { known: true, label: name, entry };
  }
  const have = task.labels.length > 0 ? `its labels are ${task.labels.join(", ")}` : "it has no label";
  return { known: false, reason: `No worker is configured for this task: ${have}. Known labels: ${Object.keys(labels).join(", ")}.` };
}

export function freeSlots(runningCount: number, maxParallel: number): number {
  return Math.max(0, maxParallel - runningCount);
}

export function startedAt(notes: Note[]): Date | undefined {
  const starts = notes.filter((note) => note.text.startsWith(START_MARKER));
  return starts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.createdAt;
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

export interface ParsedInput {
  // First line: the PR URL.
  input: string;
  head: string | undefined;
}

// First line is the input (the PR URL); intake adds a `head: <sha>` line.
export function parseInput(input: string): ParsedInput {
  const lines = input.split("\n").map((line) => line.trim());
  const head = lines.map((line) => /^head:\s*([0-9a-f]{7,40})$/i.exec(line)?.[1]).find((sha) => sha !== undefined);
  return { input: lines[0] ?? "", head };
}

export function formatInput(url: string, head: string): string {
  return `${url}\nhead: ${head}`;
}

export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/.exec(url);
  if (!match?.[1] || !match[2]) return undefined;
  return { repo: match[1], number: Number(match[2]) };
}

export function usesPluginPlaceholder(entry: LabelEntry): boolean {
  return (
    entry.kind === "skill" &&
    ([...entry.allowedTools, ...entry.disallowedTools].some((rule) => rule.includes(PLUGIN_PLACEHOLDER)) ||
      (entry.sandbox !== undefined && usesPlaceholder(entry.sandbox, PLUGIN_PLACEHOLDER)))
  );
}

// `~/` is expanded inside Bash rules only: Read rules read `~/` themselves, and an absolute path there would mean "from the project root".
export function expandRule(rule: string, home: string, prReviewPath: string | undefined): string {
  if (!rule.startsWith("Bash(")) return rule;
  const expanded = rule.replaceAll("~/", `${home}/`);
  return prReviewPath === undefined ? expanded : expanded.replaceAll(PLUGIN_PLACEHOLDER, prReviewPath);
}

// Why this machine leaves a todo task to another one, or undefined when it can run it.
export function notServableHere(task: Task, machine: string, labels: Record<string, LabelEntry>, repos: Record<string, string>): string | undefined {
  // The Claude session of a resume lives on the machine that ran it.
  if (task.next === "resume" && task.sessionId !== null && task.machine !== null && task.machine !== machine) return `resume pinned to ${task.machine}`;
  const resolved = resolveLabel(task, labels);
  if (!resolved.known) return "no worker for its labels here";
  if (resolved.entry.kind === "skill" && resolved.entry.cwd === "pr-repo") {
    const pr = parsePrUrl(parseInput(task.input).input);
    // A task without a PR URL is claimed and fails with the reason; one for a repo without a checkout here waits for another machine.
    if (pr !== undefined && !Object.hasOwn(repos, pr.repo)) return `no checkout of ${pr.repo} here`;
  }
  return undefined;
}

// What the worker starts: a new Claude session, or the task's last one with the user's reply.
export type RunPlan = { kind: "fresh"; sessionId: string } | { kind: "resume"; sessionId: string; prompt: string };

// The user's reply since the agent last spoke: answers to its question and free comments, oldest first.
export function userReply(notes: Note[]): Note[] {
  const sorted = [...notes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const lastAgent = sorted.findLastIndex((note) => note.author === "agent");
  return sorted.slice(lastAgent + 1).filter((note) => note.author === "user" && (note.kind === "answer" || note.kind === "comment"));
}

export function buildResumePrompt(task: Task, notes: Note[]): string | undefined {
  const reply = userReply(notes);
  if (reply.length === 0) return undefined;
  const parts = reply.map((note) => {
    if (note.kind !== "answer") return note.text.trim();
    const questions = notes.find((candidate) => candidate.id === note.questionNoteId)?.questions;
    const answers = formatAnswers(questions, note.answers ?? []);
    return note.text.trim() === "" ? `Answers:\n${answers}` : `Answers:\n${answers}\n\n${note.text.trim()}`;
  });
  return [
    `The user replied on board task ${task.id}:`,
    "",
    ...parts.flatMap((part) => [part, ""]),
    `Continue the task with this under the same rules as before. End the run with \`board ask ${task.id} --file <questions.json>\` if you need the user again, or with \`board move ${task.id} needs-me\` (or done) when you are finished, after posting what you did with \`board comment\`.`,
  ].join("\n");
}

// Resume when the user asked for it, a session exists and there is a reply to give it; otherwise start over.
export function planRun(task: Task, notes: Note[], newSessionId: () => string): RunPlan {
  if (task.next === "resume" && task.sessionId !== null) {
    const prompt = buildResumePrompt(task, notes);
    if (prompt !== undefined) return { kind: "resume", sessionId: task.sessionId, prompt };
  }
  return { kind: "fresh", sessionId: newSessionId() };
}

export type Outcome = { kind: "ok" } | { kind: "failed"; reason: string } | { kind: "unreported" };

export function decideOutcome(input: {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  timeoutMinutes: number;
  // The worker (or the skill) moved the task to Needs me or Done.
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
  // Environment variables the worker fills from commands (never logged) and adds to the process's environment.
  maskedEnv: MaskedEnv[];
}

export type InvocationPlan = { ok: true; invocation: Invocation } | { ok: false; reason: string };

export function buildInvocation(input: {
  entry: LabelEntry;
  task: Task;
  repos: Record<string, string>;
  home: string;
  fallbackCwd: string;
  // Install path of the pr-review plugin; undefined when it could not be resolved.
  prReviewPath: string | undefined;
  // Names directly inside a directory, for the sandbox's read-only list.
  listDir: (dir: string) => string[];
  // Ignored by a command label.
  run: RunPlan;
}): InvocationPlan {
  const { entry, task, repos, home } = input;
  if (entry.kind === "command") {
    const [command, ...args] = entry.command;
    if (command === undefined) return { ok: false, reason: "The label's command is empty." };
    return { ok: true, invocation: { command, args, cwd: entry.cwd ?? input.fallbackCwd, maskedEnv: [] } };
  }
  if (entry.sandbox === undefined) {
    return { ok: false, reason: `The label has no "sandbox" entry in config.json. A headless run is not started without one; copy it from config.example.json.` };
  }
  const prompt = parseInput(task.input).input;
  let cwd = entry.cwd;
  if (cwd === "pr-repo") {
    const pr = parsePrUrl(prompt);
    if (!pr) return { ok: false, reason: `The first line of the task input is not a GitHub PR URL: ${prompt || "(empty)"}` };
    const dir = repos[pr.repo];
    if (!dir) return { ok: false, reason: `No checkout is configured for ${pr.repo}. Add it to "repos" in config.json.` };
    cwd = dir;
  }
  if (usesPluginPlaceholder(entry) && input.prReviewPath === undefined) {
    return { ok: false, reason: `The pr-review plugin path is unknown, but the allow rules need ${PLUGIN_PLACEHOLDER}.` };
  }
  const expand = (rule: string): string => expandRule(rule, home, input.prReviewPath);
  const sandboxSettings = buildSandboxSettings({
    entry: entry.sandbox,
    cwd,
    prReviewPath: input.prReviewPath,
    checkoutEntries: input.listDir(cwd),
  });
  // A PR review gets its PR URL; any other skill reads its task with `board show`.
  const start = entry.cwd === "pr-repo" ? `/${entry.skill} ${task.id} ${prompt}` : `/${entry.skill} ${task.id}`;
  const session = input.run.kind === "fresh" ? ["--session-id", input.run.sessionId] : ["--resume", input.run.sessionId];
  // Prompt first: --allowedTools and --disallowedTools take every following argument.
  const args = [
    "-p",
    input.run.kind === "fresh" ? start : input.run.prompt,
    ...session,
    "--permission-mode",
    "dontAsk",
    // Project and local settings of the checkout carry their own allow rules and tokens; only the user's settings load.
    "--setting-sources",
    "user",
    // The Bash sandbox. Passed inline: it holds no secret, only the names of the masked variables.
    "--settings",
    JSON.stringify(sandboxSettings),
    "--allowedTools",
    ...entry.allowedTools.map(expand),
  ];
  if (entry.disallowedTools.length > 0) args.push("--disallowedTools", ...entry.disallowedTools.map(expand));
  return { ok: true, invocation: { command: "claude", args, cwd, maskedEnv: entry.sandbox.maskedEnv } };
}
