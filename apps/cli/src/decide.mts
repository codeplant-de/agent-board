import type { IntakeConfig, Lane } from "./config.mts";
import { formatAnswers, promptSkill, shortSkill } from "@agent-board/shared";
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

// The lane of this machine whose own work the task is: the lane naming the skill its prompt starts with, else the lane
// with "*". Undefined when no lane owns it; any lane may still borrow it.
export function ownLane(task: Task, lanes: Lane[]): string | undefined {
  const skill = promptSkill(task.input);
  const short = skill === undefined ? undefined : shortSkill(skill);
  return (lanes.find((lane) => short !== undefined && lane.skills.includes(short)) ?? lanes.find((lane) => lane.skills.includes("*")))?.name;
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

// Intake adds a `head: <sha>` line under the prompt: the PR head the task was made for.
export function parseHead(input: string): string | undefined {
  return input
    .split("\n")
    .map((line) => /^\s*head:\s*([0-9a-f]{7,40})\s*$/i.exec(line)?.[1])
    .find((sha) => sha !== undefined);
}

// What the agent is given: the prompt as written, without the board's own `head:` line.
export function runPrompt(input: string): string {
  return input
    .split("\n")
    .filter((line) => !/^\s*head:\s*[0-9a-f]{7,40}\s*$/i.test(line))
    .join("\n")
    .trim();
}

export function formatIntakeInput(prompt: string, head: string): string {
  return `${prompt}\nhead: ${head}`;
}

export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/.exec(url);
  if (!match?.[1] || !match[2]) return undefined;
  return { repo: match[1], number: Number(match[2]) };
}

// The first GitHub PR URL in the prompt's first line: the PR an intake task reviews.
export function prUrlIn(input: string): string | undefined {
  const first = input.split("\n")[0] ?? "";
  return /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.exec(first)?.[0];
}

export function usesPluginPlaceholder(rules: string[]): boolean {
  return rules.some((rule) => rule.includes(PLUGIN_PLACEHOLDER));
}

// `~/` is expanded inside Bash rules only: Read rules read `~/` themselves, and an absolute path there would mean "from the project root".
export function expandRule(rule: string, home: string, prReviewPath: string | undefined): string {
  if (!rule.startsWith("Bash(")) return rule;
  const expanded = rule.replaceAll("~/", `${home}/`);
  return prReviewPath === undefined ? expanded : expanded.replaceAll(PLUGIN_PLACEHOLDER, prReviewPath);
}

// A task with its own directory runs only on the machine it was scheduled on (intake's tasks have none of their own).
export function pinnedMachine(task: Task): string | undefined {
  if (task.next === "resume" && task.sessionId !== null && task.machine !== null) return task.machine;
  if (task.createdBy !== "intake" && task.workdir !== null && task.machine !== null) return task.machine;
  return undefined;
}

// Why this machine leaves a todo task to another one, or undefined when it can run it.
export function notServableHere(task: Task, machine: string, repos: Record<string, string>): string | undefined {
  const pinned = pinnedMachine(task);
  if (pinned !== undefined && pinned !== machine) return `pinned to ${pinned}`;
  if (task.createdBy === "intake") {
    const pr = parsePrUrl(prUrlIn(task.input) ?? "");
    // An intake task without a PR URL is claimed and fails with the reason; one for a repo without a checkout here waits.
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

const CONTINUE_LINE = "The board's rules from the start of this session still hold.";

export function buildResumePrompt(task: Task, notes: Note[]): string | undefined {
  const reply = userReply(notes);
  const paused = wasPaused(notes);
  if (reply.length === 0 && !paused) return undefined;
  const pausedLine = `You were paused on board task ${task.id} to free the slot for other work. Continue where you left off; check the state of anything you were in the middle of before you go on.`;
  if (reply.length === 0) {
    return [pausedLine, "", CONTINUE_LINE].join("\n");
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
    `Continue the task with this. ${CONTINUE_LINE}`,
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

// What every run is told about the board, on top of its prompt.
export function boardRules(task: Task): string {
  return [
    `You are running headless as agent-board task ${task.id}. Nobody watches this terminal; the user reads the task's thread on the board.`,
    `- Report progress and results with \`board comment ${task.id} "<text>"\` (markdown; \`--file <path>\` for long text in /tmp, or \`-\` for stdin).`,
    `- AskUserQuestion is not available in this headless run. Wherever you would use it, also where a skill says to: write the same questions with the Write tool to /tmp/pr-${task.id}-questions.json as {"questions": [{"header": "<at most 16 chars>", "question": "...", "multiSelect": false, "options": [{"label": "...", "description": "...", "recommended": true}, ...]}]} (1 to 4 questions, 2 to 4 options each, at most one recommended), run \`board ask ${task.id} --file /tmp/pr-${task.id}-questions.json\`, then end your turn. The user answers on the board, and you are resumed in this session with the answers.`,
    `- When the work is done, post a short summary with \`board comment\`, then \`board move ${task.id} needs-me\`.`,
    `- To suggest follow-up work, write it to a file in /tmp and run \`board add --title "<title>" --file <path> --parent ${task.id}\`; the user starts it.`,
    '- If a tool call is refused with "Pause requested", post a one-line status with `board comment` and end your turn; you will be resumed here.',
  ].join("\n");
}

export function buildInvocation(input: {
  task: Task;
  run: RunPlan;
  repos: Record<string, string>;
  // Where a task without a directory of its own runs.
  defaultCwd: string;
  intake: IntakeConfig;
  home: string;
  // Install path of the pr-review plugin; undefined when it could not be resolved.
  prReviewPath: string | undefined;
  // The PreToolUse hook command (heartbeat, pause, questions).
  hookCommand?: string;
}): InvocationPlan {
  const { task, intake } = input;
  const fromIntake = task.createdBy === "intake";
  const prompt = runPrompt(task.input);
  if (input.run.kind === "fresh" && prompt === "") return { ok: false, reason: "The task has no prompt." };

  // Where it runs: a resume where the session stopped; a scheduled task in its own directory; an intake review in the
  // PR's checkout; anything else in the default directory.
  let cwd: string;
  if (task.workdir !== null && (input.run.kind === "resume" || !fromIntake)) {
    cwd = task.workdir;
  } else if (fromIntake) {
    const url = prUrlIn(task.input);
    const pr = parsePrUrl(url ?? "");
    if (!pr) return { ok: false, reason: `The intake task's prompt names no GitHub PR: ${prompt.split("\n")[0] || "(empty)"}` };
    const dir = input.repos[pr.repo];
    if (!dir) return { ok: false, reason: `No checkout is configured for ${pr.repo}. Add it to "repos" in config.json.` };
    cwd = dir;
  } else {
    cwd = input.defaultCwd;
  }

  const settings = input.hookCommand === undefined ? {} : { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: input.hookCommand }] }] } };
  const session = input.run.kind === "fresh" ? ["--session-id", input.run.sessionId] : ["--resume", input.run.sessionId];
  // Prompt first: --allowedTools and --disallowedTools take every following argument.
  const args = [
    "-p",
    input.run.kind === "fresh" ? prompt : input.run.prompt,
    ...session,
    // Every event as a JSON line: the worker keeps a readable log and sends the transcript to the board.
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt",
    boardRules(task),
    // The heartbeat, pause and question hook, inline.
    "--settings",
    JSON.stringify(settings),
  ];
  if (!fromIntake) {
    // As if the user ran it: their settings (user, project, local) and auto mode, which lets safe actions through and
    // refuses risky ones. Headless, a refusal cannot become a prompt; it shows in the log.
    args.push("--permission-mode", "auto");
    return { ok: true, invocation: { command: "claude", args, cwd } };
  }
  // Intake runs unattended on PR text nobody chose to read: only the user's own settings, and only what intake allows.
  const rules = [...intake.allowedTools, ...intake.disallowedTools];
  if (usesPluginPlaceholder(rules) && input.prReviewPath === undefined) {
    return { ok: false, reason: `The pr-review plugin path is unknown, but intake's rules need ${PLUGIN_PLACEHOLDER}.` };
  }
  const expand = (rule: string): string => expandRule(rule, input.home, input.prReviewPath);
  args.push("--permission-mode", "dontAsk", "--setting-sources", "user");
  if (intake.allowedTools.length > 0) args.push("--allowedTools", ...intake.allowedTools.map(expand));
  if (intake.disallowedTools.length > 0) args.push("--disallowedTools", ...intake.disallowedTools.map(expand));
  return { ok: true, invocation: { command: "claude", args, cwd } };
}
