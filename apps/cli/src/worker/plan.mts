import { isModelName, isSafeWorkdir, isSessionId, parsePrUrl, prUrlIn } from '@agent-board/shared';
import type { Note, Task } from '@agent-board/shared';
import type { IntakeConfig } from '../config/config.mts';
import { neverRun } from '../task-rules.mts';
import { boardRules, buildResumePrompt, freshThreadBlock, userReply, writtenSincePreviousRun } from './prompts.mts';

// `{<plugin>}` in an allow or deny rule stands for the root Claude Code gives `<plugin>@ccc`, such as {pr-review}.
const PLUGIN_PLACEHOLDER = /\{([a-z0-9][a-z0-9-]*)\}/g;
export const PLUGIN_MARKETPLACE = 'ccc';

export interface RunLimits {
  inactivityMinutes: number;
  maxRunHours: number;
}

export type Supervision =
  { kind: 'continue' } | { kind: 'stop'; why: 'inactive' | 'ceiling' | 'pause-forced'; message: string };

// What the worker does with a run that is still going, checked on every worker tick (15 s).
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
      message: `The run did not end its turn within ${input.pauseGraceMinutes} minutes of the pause request and was interrupted.`,
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

// What the worker starts: a new Claude session, or the task's last one with the user's reply; or why it starts nothing.
export type RunPlan =
  | { kind: 'fresh'; sessionId: string; thread?: string }
  | { kind: 'resume'; sessionId: string; prompt: string }
  | { kind: 'blocked'; reason: string };

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
      if (userReply(notes, task.runStartedAt).some((note) => note.unreadable))
        return { kind: 'blocked', reason: UNREADABLE_NOTE_REASON };
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

export type Outcome =
  | { kind: 'ok' }
  | { kind: 'failed'; reason: string }
  | { kind: 'unreported' }
  | { kind: 'paused' }
  | { kind: 'stopped' };

export function decideOutcome(input: {
  exitCode: number | null;
  signal: string | null;
  // Why the worker stopped the run itself, if it did.
  stopped: Exclude<Supervision, { kind: 'continue' }> | undefined;
  // The dispatcher asked the run to give up its slot.
  pauseRequested: boolean;
  // The worker ended the run because the user asked it to stop.
  stopRequested: boolean;
  // The task is no longer Running: the agent reported, the user answered, or the task was taken back.
  reported: boolean;
}): Outcome {
  // A run that reported before it noticed the pause or the stop is simply done.
  if (input.reported)
    return input.exitCode === 0 || input.pauseRequested || input.stopRequested ? { kind: 'ok' } : failed(input);
  if (input.stopRequested) return { kind: 'stopped' };
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
  // The prompt, from the board (a sealed prompt, a reply). It reaches `claude` on stdin as the first user message of the
  // stream-json input, JSON-encoded, so it is only ever text.
  prompt: string;
  cwd: string;
}

export type InvocationPlan = { ok: true; invocation: Invocation } | { ok: false; reason: string };

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
  // The PreToolUse hook command (heartbeat, working directory, questions).
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
  if (task.model !== null && !isModelName(task.model))
    return { ok: false, reason: 'The task model is not a model name.' };

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
    // One argument, like the session id.
    ...(task.model === null ? [] : [`--model=${task.model}`]),
    // Every event as a JSON line: the worker keeps a readable log and sends the transcript to the board.
    '--output-format',
    'stream-json',
    // Messages and an interrupt can follow the prompt on stdin while the run goes on.
    '--input-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    boardRules(task),
    // The heartbeat and question hook, inline.
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
