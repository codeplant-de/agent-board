import type { IntakeConfig, Lane } from './config.mts';
import {
  formatAnswers,
  isSafeWorkdir,
  isSessionId,
  MAX_BATCH_EVENTS,
  parsePrUrl,
  prUrlIn,
  promptSkill,
  shortSkill,
} from '@agent-board/shared';
import type { Note, Task, TranscriptEvent, UnreadableField } from '@agent-board/shared';
import { BackendError } from './backend.mts';

// `{<plugin>}` in an allow or deny rule stands for the root Claude Code gives `<plugin>@ccc`, such as {pr-review}.
const PLUGIN_PLACEHOLDER = /\{([a-z0-9][a-z0-9-]*)\}/g;
export const PLUGIN_MARKETPLACE = 'ccc';

export const START_MARKER = 'agent-board: started';
// Half the server's body limit.
const BATCH_MAX_BYTES = 8 * 1024 * 1024;
// The worker enforces the timeout itself; the sweep only catches a worker that cannot.
const SWEEP_GRACE_MINUTES = 5;

export function unitName(taskId: string): string {
  return `agent-board-${taskId}`;
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
  if (!input.unitActive) return { stale: true, reason: 'The worker is no longer running.', stopUnit: false };
  if (input.startedAt === undefined) return { stale: false };
  const minutesSince = (date: Date) => (input.now.getTime() - date.getTime()) / 60_000;
  const age = minutesSince(input.startedAt);
  if (age > input.limits.maxRunHours * 60 + SWEEP_GRACE_MINUTES) {
    return {
      stale: true,
      reason: `The run has gone on for ${Math.round(age)} minutes, over the limit of ${input.limits.maxRunHours} hours.`,
      stopUnit: true,
    };
  }
  const quiet = minutesSince(input.lastActive ?? input.startedAt);
  if (quiet > input.limits.inactivityMinutes + SWEEP_GRACE_MINUTES) {
    return { stale: true, reason: `The agent has made no tool call for ${Math.round(quiet)} minutes.`, stopUnit: true };
  }
  return { stale: false };
}

export type Supervision =
  { kind: 'continue' } | { kind: 'stop'; why: 'inactive' | 'ceiling' | 'pause-forced'; message: string };

// What the worker does with a run that is still going, checked every half minute.
export function supervise(input: {
  now: Date;
  startedAt: Date;
  // The agent's last tool call; undefined before its first one.
  lastActive: Date | undefined;
  pauseRequestedAt: Date | undefined;
  limits: RunLimits;
  // How long a run may take to stop by itself after a pause was asked for.
  pauseGraceMinutes: number;
}): Supervision {
  const minutesSince = (date: Date) => (input.now.getTime() - date.getTime()) / 60_000;
  if (input.pauseRequestedAt !== undefined && minutesSince(input.pauseRequestedAt) > input.pauseGraceMinutes) {
    return {
      kind: 'stop',
      why: 'pause-forced',
      message: `The run did not stop within ${input.pauseGraceMinutes} minutes of the pause request and was stopped.`,
    };
  }
  if (minutesSince(input.startedAt) > input.limits.maxRunHours * 60) {
    return {
      kind: 'stop',
      why: 'ceiling',
      message: `Stopped after ${input.limits.maxRunHours} hours, the longest a run may take.`,
    };
  }
  if (minutesSince(input.lastActive ?? input.startedAt) > input.limits.inactivityMinutes) {
    return {
      kind: 'stop',
      why: 'inactive',
      message: `Stopped: the agent made no tool call for ${input.limits.inactivityMinutes} minutes.`,
    };
  }
  return { kind: 'continue' };
}

// The lane of this machine whose own work the task is: the lane naming the skill its prompt starts with, else the lane
// with "*". Undefined when no lane owns it; any lane may still borrow it.
export function ownLane(task: Task, lanes: Lane[]): string | undefined {
  const skill = promptSkill(task.input);
  const short = skill === undefined ? undefined : shortSkill(skill);
  return (
    lanes.find((lane) => short !== undefined && lane.skills.includes(short)) ??
    lanes.find((lane) => lane.skills.includes('*'))
  )?.name;
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
export function planStarts(input: {
  lanes: Lane[];
  running: LaneRun[];
  candidates: Task[];
  ownLaneOf: (task: Task) => string | undefined;
}): Start[] {
  const free = new Map(
    input.lanes.map((lane) => [lane.name, lane.slots - input.running.filter((run) => run.lane === lane.name).length]),
  );
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
export function planPauses(input: {
  lanes: Lane[];
  running: LaneRun[];
  waitingOwn: Map<string, number>;
  now: Date;
  pauseAfterMinutes: number;
}): LaneRun[] {
  const pauses: LaneRun[] = [];
  for (const lane of input.lanes) {
    const inLane = input.running.filter((run) => run.lane === lane.name);
    if (inLane.length < lane.slots || (input.waitingOwn.get(lane.name) ?? 0) === 0) continue;
    if (inLane.some((run) => run.pauseRequested)) continue;
    const pausable = inLane
      .filter(
        (run) =>
          run.borrowed &&
          run.startedAt !== undefined &&
          input.now.getTime() - run.startedAt.getTime() >= input.pauseAfterMinutes * 60_000,
      )
      .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
    if (pausable[0]) pauses.push(pausable[0]);
  }
  return pauses;
}

// The plugins whose roots the rules name, such as ["pr-review", "engineering"].
export function pluginPlaceholders(rules: string[]): string[] {
  return [
    ...new Set(rules.flatMap((rule) => [...rule.matchAll(PLUGIN_PLACEHOLDER)].map((match) => match[1] ?? ''))),
  ].filter(Boolean);
}

// `~/` and `{<plugin>}` are expanded inside Bash rules only: Read rules read `~/` themselves, and an absolute path
// there would mean "from the project root".
export function expandRule(rule: string, home: string, pluginRoots: Record<string, string>): string {
  if (!rule.startsWith('Bash(')) return rule;
  return rule
    .replaceAll('~/', `${home}/`)
    .replace(PLUGIN_PLACEHOLDER, (match, name: string) => pluginRoots[name] ?? match);
}

// A refusal that sending the same thing again cannot change: a malformed, oversized, unknown or conflicting request. Anything
// else (no network, a 5xx, a revoked token) is worth another try.
export function isPermanentRefusal(error: unknown): boolean {
  return error instanceof BackendError && [400, 404, 409, 413, 422].includes(error.status ?? 0);
}

// The fields this machine could not open that a run needs: its prompt and the directory it works in. A task listed here must
// not be started, since an empty prompt or a missing directory would run something else than the user wrote.
export function unreadableForRun(task: Task): UnreadableField[] {
  return task.unreadable.filter((field) => field !== 'title');
}

/**
 * Why this task is never run, whatever the board says, or undefined. An agent's proposal is the user's to start: starting it seals
 * its prompt again as the user's (creator "user"), so a task that still names the agent as its creator was not started by the
 * user, and its prompt must never get the user's permissions.
 */
export function neverRun(task: Task): string | undefined {
  return task.createdBy === 'agent'
    ? 'An agent proposed this task and you have not started it: a worker only runs what you started or your own machines created.'
    : undefined;
}

// A task with its own directory runs only on the machine it was scheduled on (intake's tasks have none of their own).
export function pinnedMachine(task: Task): string | undefined {
  if (task.next === 'resume' && task.sessionId !== null && task.machine !== null) return task.machine;
  if (task.createdBy !== 'intake' && task.workdir !== null && task.machine !== null) return task.machine;
  return undefined;
}

// Why this machine leaves a todo task to another one, or undefined when it can run it.
export function notServableHere(task: Task, machine: string, repos: Record<string, string>): string | undefined {
  const pinned = pinnedMachine(task);
  if (pinned !== undefined && pinned !== machine) return `pinned to ${pinned}`;
  if (task.createdBy === 'intake') {
    const pr = parsePrUrl(prUrlIn(task.input) ?? '');
    // An intake task without a PR URL is claimed and fails with the reason; one for a repo without a checkout here waits.
    if (pr !== undefined && !Object.hasOwn(repos, pr.repo)) return `no checkout of ${pr.repo} here`;
  }
  return undefined;
}

// What the worker starts: a new Claude session, or the task's last one with the user's reply; or why it starts nothing.
export type RunPlan =
  | { kind: 'fresh'; sessionId: string; thread?: string }
  | { kind: 'resume'; sessionId: string; prompt: string }
  | { kind: 'blocked'; reason: string };

const byTime = (notes: Note[]): Note[] => [...notes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

// What the user wrote: answers to the agent's questions and free comments.
const userNotes = (notes: Note[]): Note[] =>
  notes.filter((note) => note.author === 'user' && (note.kind === 'answer' || note.kind === 'comment'));

// The user's reply since the agent last spoke, oldest first.
export function userReply(notes: Note[]): Note[] {
  const sorted = byTime(notes);
  return userNotes(sorted.slice(sorted.findLastIndex((note) => note.author === 'agent') + 1));
}

// A note as the agent reads it; an answer comes with the questions the user was shown, from its own envelope.
function noteText(note: Note): string {
  if (note.kind !== 'answer') return note.text.trim();
  const answers = formatAnswers(note.questions, note.answers ?? []);
  return note.text.trim() === '' ? `Answers:\n${answers}` : `Answers:\n${answers}\n\n${note.text.trim()}`;
}

// When the run before this one started, from the dispatcher's start notes; `before` is when this run was claimed.
function previousRunStart(notes: Note[], before: Date | null): Date | undefined {
  const starts = notes.filter(
    (note) =>
      note.author === 'system' && note.text.startsWith(START_MARKER) && (before === null || note.createdAt < before),
  );
  return starts.map((note) => note.createdAt).sort((a, b) => b.getTime() - a.getTime())[0];
}

// What the user wrote since the previous run started, oldest first: what a fresh run is told of the thread.
function writtenSincePreviousRun(task: Task, notes: Note[]): Note[] {
  const lastStart = previousRunStart(notes, task.runStartedAt);
  return byTime(userNotes(notes.filter((note) => lastStart === undefined || note.createdAt > lastStart)));
}

/**
 * What a fresh run is told of the thread on top of its prompt: the user's notes since the previous run started, as
 * written, and where to read the rest. Undefined when only the board wrote to the thread.
 */
export function freshThreadBlock(task: Task, notes: Note[]): string | undefined {
  if (!notes.some((note) => note.author !== 'system' && note.author !== 'server')) return undefined;
  const written = writtenSincePreviousRun(task, notes);
  return [
    ...(written.length > 0
      ? [
          `The user wrote on board task ${task.id} since its last run started:`,
          '',
          ...written.flatMap((note) => [noteText(note), '']),
        ]
      : []),
    `The thread holds earlier notes: run \`board show ${task.id}\` first to read it.`,
  ].join('\n');
}

const CONTINUE_LINE = "The board's rules from the start of this session still hold.";

export function buildResumePrompt(task: Task, notes: Note[]): string | undefined {
  const reply = userReply(notes);
  const paused = task.paused;
  if (reply.length === 0 && !paused) return undefined;
  const pausedLine = `You were paused on board task ${task.id} to free the slot for other work. Continue where you left off; check the state of anything you were in the middle of before you go on.`;
  if (reply.length === 0) {
    return [pausedLine, '', CONTINUE_LINE].join('\n');
  }
  const parts = reply.map((note) => noteText(note));
  return [
    ...(paused ? [pausedLine, ''] : []),
    `The user replied on board task ${task.id}:`,
    '',
    ...parts.flatMap((part) => [part, '']),
    `Continue the task with this. ${CONTINUE_LINE}`,
  ].join('\n');
}

const UNREADABLE_NOTE_REASON =
  "A comment or answer in this task's thread could not be decrypted with this machine's data key, and this run would have handed it to the agent, so it was not run. Check AGENT_BOARD_DATA_KEY, or use Re-run fresh: a fresh run starts after this attempt and is not handed the note.";

export interface RunPlanOptions {
  newSessionId: () => string;
  // Whether this machine started that Claude session for that task. The board names the session to resume in the clear, so
  // a session this machine has no record of is never resumed: the id could be another task's, or another conversation.
  isOwnSession: (taskId: string, sessionId: string) => boolean;
}

/**
 * Resume when the user asked for it, a session exists and there is a reply to give it; otherwise start over. A run is blocked
 * when it would resume a session this machine did not start for the task, or hand the agent a note of the user's that could
 * not be opened: the agent would act on less than the user wrote.
 */
export function planRun(task: Task, notes: Note[], options: RunPlanOptions): RunPlan {
  if (task.next === 'resume' && task.sessionId !== null) {
    const prompt = buildResumePrompt(task, notes);
    if (prompt !== undefined) {
      if (!options.isOwnSession(task.id, task.sessionId))
        return {
          kind: 'blocked',
          reason: `The board asks to resume Claude session ${task.sessionId}, which this machine did not start for this task, so the run was not started. Use Re-run fresh to start over.`,
        };
      if (userReply(notes).some((note) => note.unreadable)) return { kind: 'blocked', reason: UNREADABLE_NOTE_REASON };
      return { kind: 'resume', sessionId: task.sessionId.toLowerCase(), prompt };
    }
  }
  if (writtenSincePreviousRun(task, notes).some((note) => note.unreadable))
    return { kind: 'blocked', reason: UNREADABLE_NOTE_REASON };
  const thread = freshThreadBlock(task, notes);
  return { kind: 'fresh', sessionId: options.newSessionId(), ...(thread === undefined ? {} : { thread }) };
}

/**
 * The run this worker started is no longer the task's to report on: the task was closed (archived, parked by hand: nobody
 * is waiting), or it was taken back and run again, so the `running` it shows is another run's. A task that left Running
 * is still this run's: the board drops `runStartedAt` with the move, so only a running task's start tells runs apart.
 */
export function isRunOver(
  started: Pick<Task, 'runStartedAt'>,
  after: Pick<Task, 'closed' | 'status' | 'runStartedAt'>,
): boolean {
  if (after.closed) return true;
  return after.status === 'running' && after.runStartedAt?.getTime() !== started.runStartedAt?.getTime();
}

export type Outcome = { kind: 'ok' } | { kind: 'failed'; reason: string } | { kind: 'unreported' } | { kind: 'paused' };

export function decideOutcome(input: {
  exitCode: number | null;
  signal: string | null;
  // Why the worker stopped the run itself, if it did.
  stopped: Exclude<Supervision, { kind: 'continue' }> | undefined;
  // The dispatcher asked the run to give up its slot.
  pauseRequested: boolean;
  // The task is no longer Running: the agent reported, the user answered, or the task was taken back.
  reported: boolean;
}): Outcome {
  // A run that reported before it noticed the pause is simply done.
  if (input.reported) return input.exitCode === 0 || input.pauseRequested ? { kind: 'ok' } : failed(input);
  if (input.pauseRequested) return { kind: 'paused' };
  if (input.stopped) return { kind: 'failed', reason: input.stopped.message };
  if (input.exitCode !== 0) return failed(input);
  return { kind: 'unreported' };
}

function failed(input: { exitCode: number | null; signal: string | null }): Outcome {
  const how = input.signal ? `was killed by ${input.signal}` : `exited with code ${input.exitCode}`;
  return { kind: 'failed', reason: `The worker ${how}.` };
}

export interface Invocation {
  command: string;
  // Options only, and never the prompt: `claude` would read a prompt that starts with a dash as an option, and some options
  // start things (`--mcp-config`) before any permission applies.
  args: string[];
  // The prompt, from the board (a sealed prompt, a reply). It reaches `claude` on stdin, which is only ever text.
  prompt: string;
  cwd: string;
}

export type InvocationPlan = { ok: true; invocation: Invocation } | { ok: false; reason: string };

// What every run is told about the board, on top of its prompt.
export function boardRules(task: Task): string {
  return [
    `You are running headless as agent-board task ${task.id}. Nobody watches this terminal; the user reads the task's thread on the board.`,
    `- Report progress and results with \`board comment ${task.id} "<text>"\` (markdown; \`--file <path>\` for long text in /tmp, or \`-\` for stdin).`,
    `- AskUserQuestion is not available in this headless run. Wherever you would use it, also where a skill says to: write the same questions with the Write tool to /tmp/pr-${task.id}-questions.json as {"questions": [{"header": "<at most 16 chars>", "question": "...", "multiSelect": false, "options": [{"label": "...", "description": "...", "recommended": true}, ...]}]} (1 to 4 questions, 2 to 4 options each, at most one recommended), run \`board ask ${task.id} --file /tmp/pr-${task.id}-questions.json\`, then end your turn. The user answers on the board, and you are resumed in this session with the answers.`,
    `- When the work is done, post a short summary with \`board comment\`, then \`board move ${task.id} needs-me\`. Attach to that comment the reply you expect the user to send next, in their voice (for example a go-ahead for your proposed next step): \`board comment --suggest "<reply>" ${task.id} "<summary>"\`. Skip it when no single reply is obvious, and if the board refuses \`--suggest\`, post the comment without it.`,
    `- To suggest follow-up work, write it to a file in /tmp and run \`board add --title "<title>" --file <path> --parent ${task.id}\`; the user starts it.`,
    '- Do not end your turn while a background agent or background command you started is still running: this run ends when your turn does. Run subagents in the foreground, or wait for their result before ending your turn.',
    '- If a tool call is refused with "Pause requested", post a one-line status with `board comment` and end your turn; you will be resumed here.',
    ...(task.createdBy === 'intake'
      ? [
          "- This run allows only a fixed list of commands, and each matches only when it stands alone: run every Bash command on its own, without pipes, `;`, `&&`, redirects or `cd`, by its full path, and filter output with the command's own options. A refused call is a result; report it instead of working around it, and go on with the other steps.",
        ]
      : []),
  ].join('\n');
}

export function buildInvocation(input: {
  task: Task;
  run: RunPlan;
  repos: Record<string, string>;
  // Where a task without a directory of its own runs.
  defaultCwd: string;
  intake: IntakeConfig;
  // The directory a task without its own runs in when no PR in its prompt names a checkout (its lane's, if set).
  laneCwd?: string | undefined;
  home: string;
  // Roots of the plugins intake's rules name ({pr-review} and the like).
  pluginRoots: Record<string, string>;
  // The PreToolUse hook command (heartbeat, pause, questions).
  hookCommand?: string;
}): InvocationPlan {
  const { task, intake } = input;
  const fromIntake = task.createdBy === 'intake';
  const prompt = task.input.trim();
  const refused = neverRun(task);
  if (refused !== undefined) return { ok: false, reason: refused };
  if (input.run.kind === 'blocked') return { ok: false, reason: input.run.reason };
  if (input.run.kind === 'fresh' && prompt === '') return { ok: false, reason: 'The task has no prompt.' };
  if (!isSessionId(input.run.sessionId)) return { ok: false, reason: 'The session id is not a UUID.' };
  if (task.workdir !== null && !isSafeWorkdir(task.workdir))
    return { ok: false, reason: 'The task directory is not an absolute path.' };

  // Where it runs: a resume where the session stopped; a scheduled task in its own directory; a task whose prompt
  // names a PR in that repo's checkout (an intake review always); else its lane's directory, else the default one.
  const pr = parsePrUrl(prUrlIn(task.input) ?? '');
  const checkout = pr === undefined ? undefined : input.repos[pr.repo];
  let cwd: string;
  if (task.workdir !== null && (input.run.kind === 'resume' || !fromIntake)) {
    cwd = task.workdir;
  } else if (fromIntake) {
    if (!pr)
      return {
        ok: false,
        reason: `The intake task's prompt names no GitHub PR: ${prompt.split('\n')[0] || '(empty)'}`,
      };
    if (!checkout)
      return { ok: false, reason: `No checkout is configured for ${pr.repo}. Add it to "repos" in config.json.` };
    cwd = checkout;
  } else {
    cwd = checkout ?? input.laneCwd ?? input.defaultCwd;
  }

  const settings =
    input.hookCommand === undefined
      ? {}
      : { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: input.hookCommand }] }] } };
  // One argument each, so an id can never be read as a flag of its own.
  const session =
    input.run.kind === 'fresh' ? `--session-id=${input.run.sessionId}` : `--resume=${input.run.sessionId}`;
  const promptText =
    input.run.kind === 'fresh'
      ? [prompt, input.run.thread].filter((part) => part !== undefined).join('\n\n')
      : input.run.prompt;
  const args = [
    '-p',
    session,
    // Every event as a JSON line: the worker keeps a readable log and sends the transcript to the board.
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    boardRules(task),
    // The heartbeat, pause and question hook, inline.
    '--settings',
    JSON.stringify(settings),
  ];
  if (!fromIntake) {
    // As if the user ran it: their settings (user, project, local) and auto mode, which lets safe actions through and
    // refuses risky ones. Headless, a refusal cannot become a prompt; it shows in the log.
    args.push('--permission-mode', 'auto');
    return { ok: true, invocation: { command: 'claude', args, prompt: promptText, cwd } };
  }
  // Intake runs unattended on PR text nobody chose to read: only the user's own settings, and only what intake allows.
  const missing = pluginPlaceholders([...intake.allowedTools, ...intake.disallowedTools]).filter(
    (name) => !Object.hasOwn(input.pluginRoots, name),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `The path of the plugin ${missing.join(', ')} is unknown, but intake's rules name {${missing[0]}}.`,
    };
  }
  const expand = (rule: string): string => expandRule(rule, input.home, input.pluginRoots);
  const allowed = intake.allowedTools.map(expand);
  const disallowed = intake.disallowedTools.map(expand);
  // The two lists take every following argument that does not start with `-`: a rule that does would read as an option.
  const optionLike = [...allowed, ...disallowed].find((rule) => rule.startsWith('-'));
  if (optionLike !== undefined)
    return {
      ok: false,
      reason: `An intake tool rule starts with "-" and would be read as an option: ${optionLike.slice(0, 40)}`,
    };
  args.push('--permission-mode', 'dontAsk', '--setting-sources', 'user');
  if (allowed.length > 0) args.push('--allowedTools', ...allowed);
  if (disallowed.length > 0) args.push('--disallowedTools', ...disallowed);
  return { ok: true, invocation: { command: 'claude', args, prompt: promptText, cwd } };
}

// The size of one event as it would be sent.
const eventBytes = (event: TranscriptEvent): number => Buffer.byteLength(JSON.stringify(event));

/**
 * A transcript backlog held to a count and a size: past either, the oldest tool outputs go first (the event stays, its output
 * empties), then, when that is not enough, the oldest events. Says how many of each it dropped, so the transcript can note it.
 */
export function boundBacklog(
  events: TranscriptEvent[],
  { maxEvents, maxBytes }: { maxEvents: number; maxBytes: number },
): { events: TranscriptEvent[]; droppedOutputs: number; droppedEvents: number } {
  let kept = events.length > maxEvents ? events.slice(events.length - maxEvents) : events;
  let droppedEvents = events.length - kept.length;
  let droppedOutputs = 0;
  let total = kept.reduce((sum, event) => sum + eventBytes(event), 0);
  if (total > maxBytes) {
    kept = kept.map((event) => {
      if (total <= maxBytes || event.kind !== 'tool_result' || event.output === '') return event;
      const emptied = { ...event, output: '' };
      total -= eventBytes(event) - eventBytes(emptied);
      droppedOutputs += 1;
      return emptied;
    });
  }
  if (total > maxBytes) {
    let first = 0;
    while (first < kept.length && total > maxBytes) {
      total -= eventBytes(kept[first]!);
      first += 1;
    }
    droppedEvents += first;
    kept = kept.slice(first);
  }
  return { events: kept, droppedOutputs, droppedEvents };
}

// Events as the board takes them: batches of at most `maxEvents` events and about `maxBytes` of JSON, so a backlog
// stays under the server's limits. One event larger than `maxBytes` goes alone.
export function splitBatches(
  events: TranscriptEvent[],
  { maxEvents = MAX_BATCH_EVENTS, maxBytes = BATCH_MAX_BYTES }: { maxEvents?: number; maxBytes?: number } = {},
): TranscriptEvent[][] {
  const batches: TranscriptEvent[][] = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event));
    const last = batches.at(-1);
    if (last === undefined || last.length >= maxEvents || bytes + size > maxBytes) {
      batches.push([event]);
      bytes = size;
    } else {
      last.push(event);
      bytes += size;
    }
  }
  return batches;
}
