import type { Lane, LabelEntry } from "./config.mts";
import { formatAnswers } from "@agent-board/shared";
import type { Note, Task } from "@agent-board/shared";

// Stands for the root Claude Code gives the pr-review plugin, in allow and deny rules.
export const PLUGIN_PLACEHOLDER = "{pr-review}";

export const START_MARKER = "agent-board: started";
// The note of a run that gave up its slot; the next run resumes with "you were paused".
export const PAUSE_MARKER = "Paused on";
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


export function startedAt(notes: Note[]): Date | undefined {
  const starts = notes.filter((note) => note.text.startsWith(START_MARKER));
  return starts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.createdAt;
}

export type StaleDecision = { stale: false } | { stale: true; reason: string; stopUnit: boolean };

export interface RunLimits {
  inactivityMinutes: number;
  maxRunHours: number;
}

// The worker enforces the limits itself; this catches a worker that cannot, a few minutes after it should have.
export function decideStale(input: {
  unitActive: boolean;
  startedAt: Date | undefined;
  // The agent's last tool call; undefined before its first one.
  lastActive: Date | undefined;
  now: Date;
  limits: RunLimits;
}): StaleDecision {
  if (!input.unitActive) return { stale: true, reason: "The worker is no longer running.", stopUnit: false };
  if (input.startedAt === undefined) return { stale: false };
  const minutesSince = (date: Date) => (input.now.getTime() - date.getTime()) / 60_000;
  const age = minutesSince(input.startedAt);
  if (age > input.limits.maxRunHours * 60 + SWEEP_GRACE_MINUTES) {
    return { stale: true, reason: `The run has gone on for ${Math.round(age)} minutes, over the limit of ${input.limits.maxRunHours} hours.`, stopUnit: true };
  }
  const quiet = minutesSince(input.lastActive ?? input.startedAt);
  if (quiet > input.limits.inactivityMinutes + SWEEP_GRACE_MINUTES) {
    return { stale: true, reason: `The agent has made no tool call for ${Math.round(quiet)} minutes.`, stopUnit: true };
  }
  return { stale: false };
}

export type Supervision = { kind: "continue" } | { kind: "stop"; why: "inactive" | "ceiling" | "pause-forced"; message: string };

// What the worker does with a run that is still going, checked every half minute.
export function supervise(input: {
  now: Date;
  startedAt: Date;
  // The agent's last tool call; undefined before its first one. A command label passes `now`.
  lastActive: Date | undefined;
  pauseRequestedAt: Date | undefined;
  limits: RunLimits;
  // How long a run may take to stop by itself after a pause was asked for.
  pauseGraceMinutes: number;
}): Supervision {
  const minutesSince = (date: Date) => (input.now.getTime() - date.getTime()) / 60_000;
  if (input.pauseRequestedAt !== undefined && minutesSince(input.pauseRequestedAt) > input.pauseGraceMinutes) {
    return { kind: "stop", why: "pause-forced", message: `The run did not stop within ${input.pauseGraceMinutes} minutes of the pause request and was stopped.` };
  }
  if (minutesSince(input.startedAt) > input.limits.maxRunHours * 60) {
    return { kind: "stop", why: "ceiling", message: `Stopped after ${input.limits.maxRunHours} hours, the longest a run may take.` };
  }
  if (minutesSince(input.lastActive ?? input.startedAt) > input.limits.inactivityMinutes) {
    return { kind: "stop", why: "inactive", message: `Stopped: the agent made no tool call for ${input.limits.inactivityMinutes} minutes.` };
  }
  return { kind: "continue" };
}

// The lane of this machine whose own work the task is: the lane holding the label that picks its worker.
export function ownLane(task: Task, lanes: Lane[], labels: Record<string, LabelEntry>): string | undefined {
  const resolved = resolveLabel(task, labels);
  if (!resolved.known) return undefined;
  return lanes.find((lane) => lane.labels.includes(resolved.label))?.name;
}

export interface LaneRun {
  taskId: string;
  lane: string;
  borrowed: boolean;
  startedAt: Date | undefined;
  pauseRequested: boolean;
}

export interface Start {
  taskId: string;
  lane: string;
  borrowed: boolean;
}

/**
 * Which todo tasks start in which lane. First every lane takes its own work, in list order; then lanes with slots
 * left borrow what is still waiting, in list order, earlier lanes first. `candidates` are the tasks this machine can
 * serve, in the backend's order (resumes first, then priority).
 */
export function planStarts(input: { lanes: Lane[]; running: LaneRun[]; candidates: Task[]; ownLaneOf: (task: Task) => string | undefined }): Start[] {
  const free = new Map(input.lanes.map((lane) => [lane.name, lane.slots - input.running.filter((run) => run.lane === lane.name).length]));
  const starts: Start[] = [];
  const taken = new Set<string>();
  for (const task of input.candidates) {
    const lane = input.ownLaneOf(task);
    if (lane !== undefined && (free.get(lane) ?? 0) > 0) {
      starts.push({ taskId: task.id, lane, borrowed: false });
      free.set(lane, (free.get(lane) ?? 0) - 1);
      taken.add(task.id);
    }
  }
  for (const task of input.candidates) {
    if (taken.has(task.id)) continue;
    const lane = input.lanes.find((candidate) => (free.get(candidate.name) ?? 0) > 0);
    if (lane === undefined) break;
    starts.push({ taskId: task.id, lane: lane.name, borrowed: true });
    free.set(lane.name, (free.get(lane.name) ?? 0) - 1);
  }
  return starts;
}

/**
 * Borrowed runs to pause: one per lane that is full, has its own work waiting and no pause pending, the borrowed run
 * that started last among those that ran at least `pauseAfterMinutes`. Lane bias beats priority, so the priorities
 * of the waiting and the running task do not matter.
 */
export function planPauses(input: { lanes: Lane[]; running: LaneRun[]; waitingOwn: Map<string, number>; now: Date; pauseAfterMinutes: number }): LaneRun[] {
  const pauses: LaneRun[] = [];
  for (const lane of input.lanes) {
    const inLane = input.running.filter((run) => run.lane === lane.name);
    if (inLane.length < lane.slots || (input.waitingOwn.get(lane.name) ?? 0) === 0) continue;
    if (inLane.some((run) => run.pauseRequested)) continue;
    const pausable = inLane
      .filter((run) => run.borrowed && run.startedAt !== undefined && input.now.getTime() - run.startedAt.getTime() >= input.pauseAfterMinutes * 60_000)
      .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
    if (pausable[0]) pauses.push(pausable[0]);
  }
  return pauses;
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
    entry.kind === "skill" && [...entry.allowedTools, ...entry.disallowedTools].some((rule) => rule.includes(PLUGIN_PLACEHOLDER))
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

// The last run gave up its slot: a pause note the agent has not spoken after. Not "after the last start": the
// dispatcher adds the new run's start note while its worker is still reading the thread.
export function wasPaused(notes: Note[]): boolean {
  const sorted = [...notes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const lastAgent = sorted.findLastIndex((note) => note.author === "agent");
  return sorted.slice(lastAgent + 1).some((note) => note.author === "system" && note.text.startsWith(PAUSE_MARKER));
}

export function buildResumePrompt(task: Task, notes: Note[]): string | undefined {
  const reply = userReply(notes);
  const paused = wasPaused(notes);
  if (reply.length === 0 && !paused) return undefined;
  const pausedLine = `You were paused on board task ${task.id} to free the slot for other work. Continue where you left off; check the state of anything you were in the middle of before you go on.`;
  if (reply.length === 0) {
    return [pausedLine, "", `Same rules as before. End the run with \`board ask ${task.id} --file <questions.json>\` if you need the user, or with \`board move ${task.id} needs-me\` (or done) when you are finished, after posting what you did with \`board comment\`.`].join("\n");
  }
  const parts = reply.map((note) => {
    if (note.kind !== "answer") return note.text.trim();
    const questions = notes.find((candidate) => candidate.id === note.questionNoteId)?.questions;
    const answers = formatAnswers(questions, note.answers ?? []);
    return note.text.trim() === "" ? `Answers:\n${answers}` : `Answers:\n${answers}\n\n${note.text.trim()}`;
  });
  return [
    ...(paused ? [pausedLine, ""] : []),
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

export type Outcome = { kind: "ok" } | { kind: "failed"; reason: string } | { kind: "unreported" } | { kind: "paused" };

export function decideOutcome(input: {
  exitCode: number | null;
  signal: string | null;
  // Why the worker stopped the run itself, if it did.
  stopped: Exclude<Supervision, { kind: "continue" }> | undefined;
  // The dispatcher asked the run to give up its slot.
  pauseRequested: boolean;
  // The worker (or the skill) moved the task to Needs me or Done.
  reported: boolean;
}): Outcome {
  // A run that reported before it noticed the pause is simply done.
  if (input.reported) return input.exitCode === 0 || input.pauseRequested ? { kind: "ok" } : failed(input);
  if (input.pauseRequested) return { kind: "paused" };
  if (input.stopped) return { kind: "failed", reason: input.stopped.message };
  if (input.exitCode !== 0) return failed(input);
  return { kind: "unreported" };
}

function failed(input: { exitCode: number | null; signal: string | null }): Outcome {
  const how = input.signal ? `was killed by ${input.signal}` : `exited with code ${input.exitCode}`;
  return { kind: "failed", reason: `The worker ${how}.` };
}

export interface Invocation {
  command: string;
  args: string[];
  cwd: string;
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
  // Ignored by a command label.
  run: RunPlan;
  // Where the task's last run ended up (a worktree it entered, say). A resume starts there.
  workdir?: string | null;
  // The PreToolUse hook command (heartbeat and pause); ignored by a command label.
  hookCommand?: string;
}): InvocationPlan {
  const { entry, task, repos, home } = input;
  if (entry.kind === "command") {
    const [command, ...args] = entry.command;
    if (command === undefined) return { ok: false, reason: "The label's command is empty." };
    return { ok: true, invocation: { command, args, cwd: entry.cwd ?? input.fallbackCwd } };
  }
  const prompt = parseInput(task.input).input;
  let cwd = entry.cwd;
  // A resume continues in the directory the session was in, which may be a worktree the agent entered.
  if (input.run.kind === "resume" && input.workdir) {
    cwd = input.workdir;
  } else if (cwd === "pr-repo") {
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
  const settings = input.hookCommand === undefined ? {} : { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: input.hookCommand }] }] } };
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
    // The heartbeat and pause hook, inline.
    "--settings",
    JSON.stringify(settings),
    "--allowedTools",
    ...entry.allowedTools.map(expand),
  ];
  if (entry.disallowedTools.length > 0) args.push("--disallowedTools", ...entry.disallowedTools.map(expand));
  return { ok: true, invocation: { command: "claude", args, cwd } };
}
