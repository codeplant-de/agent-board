#!/usr/bin/env node
/**
 * One task: run `claude -p` for it, keep its log and transcript, and report failures on the task.
 * Started by the dispatcher as the transient unit agent-board-<id>. While the run goes on it checks every 15 seconds:
 * no tool call for inactivityMinutes, or a run longer than maxRunHours, stops it; a pause request that the
 * agent does not follow within a few minutes stops it too. It passes the agent's liveness on to the board.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildContext, print, rejectExtraArgs, runMain, UsageError } from './cli.mts';
import type { Context } from './cli.mts';
import { isSafeTaskId } from '@agent-board/shared';
import { logLine, StreamCondenser } from '@agent-board/shared';
import type { Task, TranscriptEvent } from '@agent-board/shared';
import {
  buildInvocation,
  decideOutcome,
  isPermanentRefusal,
  isRunOver,
  ownLane,
  PLUGIN_MARKETPLACE,
  planRun,
  pluginPlaceholders,
  splitBatches,
  supervise,
  unreadableForRun,
} from './decide.mts';
import { pickEnv, readMcpServers, readSettingsEnv } from './settings-env.mts';
import type { Invocation, Supervision } from './decide.mts';
import { createRunFiles } from './runtime.mts';
import type { RunFiles } from './runtime.mts';
import { createSessionStore } from './sessions.mts';
import type { SessionStore } from './sessions.mts';
import { appendLog, closeLog, logPath, openLog, readLogTail, resetLog } from './logs.mts';
import { resolvePluginPath } from './plugins.mts';
import { postSlack, slackText } from './notify.mts';
import { sendToNeedsMe } from './report.mts';
import { fence } from './text.mts';

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  // Set when the watch stopped the run.
  stopped?: Exclude<Supervision, { kind: 'continue' }>;
}

// Called every `everyMs` while the process runs; a stop decision ends it (SIGTERM, then SIGKILL).
export interface Watch {
  everyMs: number;
  tick: () => Promise<Supervision>;
}

// How long a run may take to stop by itself after a pause was asked for.
const PAUSE_GRACE_MINUTES = 5;
// The board's liveness is updated at most this often.
const HEARTBEAT_EVERY_MS = 15_000;
// Events waiting for the board past this are dropped from the front: the board is down, the run goes on.
const MAX_PENDING_EVENTS = 20_000;

export interface WorkerDeps extends Context {
  // `env` is added to the process's environment: the secrets of the invocation's masked variables.
  // `onLine` gets each line the process prints and returns what goes into the log for it (nothing when undefined).
  run: (
    invocation: Invocation,
    taskId: string,
    env: Record<string, string>,
    watch: Watch,
    onLine: (line: string) => string | undefined,
  ) => Promise<RunResult>;
  logTail: (taskId: string) => string;
  notify: (task: Task, text: string) => Promise<void>;
  resetLog: (taskId: string) => void;
  appendLog: (taskId: string, text: string) => void;
  // Root of a plugin such as "pr-review@ccc"; throws with the reason when it cannot be resolved.
  pluginPath: (key: string) => string;
  dirExists: (path: string) => boolean;
  // The `env` blocks of a checkout's .claude/settings*.json.
  settingsEnv: (dir: string) => Record<string, string>;
  // The named servers of a checkout's .mcp.json.
  mcpServers: (dir: string, names: string[]) => { config: { mcpServers: Record<string, unknown> }; missing: string[] };
  home: string;
  newSessionId: () => string;
  // The sessions this machine started, per task: only those are ever resumed.
  sessions: SessionStore;
  files: RunFiles;
  // The hook command line for a task, given the run directory.
  hookCommand: (runDir: string, taskId: string) => string;
  now: () => Date;
  watchEveryMs: number;
}

export async function runWorker(deps: WorkerDeps, taskId: string): Promise<void> {
  const { backend, config } = deps;
  deps.resetLog(taskId);
  const task = await backend.getTask(taskId);

  const report = (text: string): Promise<void> => sendToNeedsMe(deps, task, text);

  // A failure before the process starts leaves the log empty, so it goes in the log too.
  const fail = async (reason: string): Promise<void> => {
    deps.appendLog(taskId, reason);
    await report(reason);
  };

  // Never run what could not be opened: an empty prompt or a missing directory would run something else.
  const unreadable = unreadableForRun(task);
  if (unreadable.length > 0)
    return fail(
      `The task's ${unreadable.join(' and ')} could not be decrypted with this machine's data key, so it was not run. Check AGENT_BOARD_DATA_KEY against the board's Settings page.`,
    );

  const fromIntake = task.createdBy === 'intake';
  // What a new directory is sealed against: the task's own creator and schedule, as the board has them.
  const sealing = { createdBy: task.createdBy, scheduleId: task.scheduleId };
  const pluginRoots: Record<string, string> = {};
  for (const name of fromIntake
    ? pluginPlaceholders([...config.intake.allowedTools, ...config.intake.disallowedTools])
    : []) {
    try {
      pluginRoots[name] = deps.pluginPath(`${name}@${PLUGIN_MARKETPLACE}`);
    } catch (error) {
      return fail(`Cannot resolve the ${name} plugin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const notes = await backend.readNotes(task.id);
  const run = planRun(task, notes, { newSessionId: deps.newSessionId, isOwnSession: deps.sessions.has });
  if (run.kind === 'blocked') return fail(run.reason);
  deps.appendLog(taskId, run.kind === 'resume' ? `resuming session ${run.sessionId}` : `new session ${run.sessionId}`);
  // The resume is used up whether or not the run gets going. This is also the update that clears the task's `paused`.
  await backend.updateTask(task.id, { next: 'fresh' });
  const plan = buildInvocation({
    run,
    hookCommand: deps.hookCommand(deps.files.dir, taskId),
    task,
    repos: config.repos,
    defaultCwd: config.defaultCwd,
    intake: config.intake,
    laneCwd: config.lanes.find((lane) => lane.name === ownLane(task, config.lanes))?.cwd,
    home: deps.home,
    pluginRoots,
  });
  if (!plan.ok) return fail(plan.reason);
  // Intake's MCP servers come from the checkout's .mcp.json: intake does not load the settings that switch them on.
  if (fromIntake && config.intake.mcpServers.length > 0) {
    const servers = deps.mcpServers(plan.invocation.cwd, config.intake.mcpServers);
    if (servers.missing.length > 0)
      deps.appendLog(taskId, `not in the checkout's .mcp.json: ${servers.missing.join(', ')}`);
    if (Object.keys(servers.config.mcpServers).length > 0)
      plan.invocation.args.push('--mcp-config', JSON.stringify(servers.config));
  }
  if (!deps.dirExists(plan.invocation.cwd)) {
    const own = task.workdir === plan.invocation.cwd;
    return fail(
      own
        ? `This task's directory is gone: ${plan.invocation.cwd}. Recreate it to run there, or use Re-run fresh to start over${task.createdBy === 'intake' ? '' : ' in the default directory'}.`
        : `The working directory does not exist: ${plan.invocation.cwd}`,
    );
  }
  deps.appendLog(taskId, `working directory ${plan.invocation.cwd}`);
  // Bound to the task from now on: it runs here unless the agent moves on (into a worktree, say).
  if (task.workdir !== plan.invocation.cwd)
    await backend.updateTask(task.id, { workdir: plan.invocation.cwd, seal: sealing });

  // Intake loads only the user's settings; the tokens and endpoints it is allowed come from the checkout's.
  let env: Record<string, string> = { AGENT_BOARD_TASK: taskId };
  if (fromIntake && config.intake.env.length > 0) {
    const picked = pickEnv(deps.settingsEnv(plan.invocation.cwd), config.intake.env);
    env = { ...picked.env, ...env };
    if (picked.missing.length > 0)
      deps.appendLog(taskId, `not in the checkout's settings: ${picked.missing.join(', ')}`);
  }

  const files = deps.files;
  // The dispatcher wrote the lane before it started this worker; a run started without one counts as the first lane's own.
  const record = files.readRun(taskId) ?? {
    lane: config.lanes[0]?.name ?? 'default',
    borrowed: false,
    startedAt: deps.now(),
  };
  const startedAt = deps.now();
  let lastBeat = 0;
  let lastSeen: number | undefined;
  const beat = async (): Promise<void> => {
    const seen = files.lastActive(taskId)?.getTime();
    const due = deps.now().getTime() - lastBeat >= HEARTBEAT_EVERY_MS;
    if (lastBeat !== 0 && (!due || seen === undefined || seen === lastSeen)) return;
    lastBeat = deps.now().getTime();
    lastSeen = seen;
    await backend.heartbeat(task.id, { lane: record.lane, borrowed: record.borrowed }).catch((error: unknown) => {
      deps.appendLog(taskId, `heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  // The transcript: condensed stream-json events, sent in batches with each check and once more at the end.
  const condenser = new StreamCondenser(deps.now);
  const runId = deps.newSessionId();
  let pending: TranscriptEvent[] = [];
  const post = (events: TranscriptEvent[]): Promise<void> =>
    backend.transcript(task.id, {
      runId,
      startedAt: startedAt.toISOString(),
      sessionId: run.sessionId,
      resumed: run.kind === 'resume',
      events,
    });
  // Sends `events`; returns the ones to try again later (all, or none). A batch the board refuses for good is halved until the
  // event it cannot take is alone and dropped, so one bad event never holds the transcript back.
  const sendEvents = async (events: TranscriptEvent[]): Promise<TranscriptEvent[]> => {
    try {
      await post(events);
      return [];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!isPermanentRefusal(error)) {
        deps.appendLog(taskId, `transcript upload failed: ${reason}`);
        return events;
      }
      if (events.length === 1) {
        deps.appendLog(taskId, `transcript event ${events[0]?.seq} was refused and dropped: ${reason}`);
        return [];
      }
      const middle = Math.ceil(events.length / 2);
      const firstBack = await sendEvents(events.slice(0, middle));
      if (firstBack.length > 0) return [...firstBack, ...events.slice(middle)];
      return sendEvents(events.slice(middle));
    }
  };
  const upload = async (): Promise<void> => {
    const batches = splitBatches(pending);
    pending = [];
    for (const [index, events] of batches.entries()) {
      const back = await sendEvents(events);
      if (back.length > 0) {
        // What could not go out, and the batches after it, go again with the next check.
        pending = [...back, ...batches.slice(index + 1).flat(), ...pending].slice(-MAX_PENDING_EVENTS);
        return;
      }
    }
  };
  // One upload at a time, in order: a call that finds one in flight waits for it, then sends what has come in since.
  let uploading: Promise<void> = Promise.resolve();
  const sendTranscript = (): Promise<void> => {
    uploading = uploading.then(upload);
    return uploading;
  };
  const onLine = (line: string): string | undefined => {
    const events = condenser.line(line);
    pending.push(...events);
    if (pending.length > MAX_PENDING_EVENTS) pending = pending.slice(-MAX_PENDING_EVENTS);
    const text = events.map(logLine).filter((part) => part !== undefined);
    return text.length > 0 ? text.join('\n') : undefined;
  };
  const watch: Watch = {
    everyMs: deps.watchEveryMs,
    tick: async () => {
      await beat();
      await sendTranscript();
      return supervise({
        now: deps.now(),
        startedAt,
        lastActive: files.lastActive(taskId),
        pauseRequestedAt: files.pauseRequestedAt(taskId),
        limits: config,
        pauseGraceMinutes: PAUSE_GRACE_MINUTES,
      });
    },
  };

  // Stored only now that the run is about to start: a reply to a run that never began must not resume its session.
  if (run.kind === 'fresh') {
    deps.sessions.record(task.id, run.sessionId);
    await backend.updateTask(task.id, { sessionId: run.sessionId });
  }
  let result: RunResult;
  try {
    await beat();
    result = await deps.run(plan.invocation, taskId, env, watch, onLine);
  } catch (error) {
    files.clear(taskId);
    if (run.kind === 'fresh') await backend.updateTask(task.id, { sessionId: null });
    return fail(error instanceof Error ? error.message : String(error));
  }
  await sendTranscript();
  if (result.stopped) deps.appendLog(taskId, result.stopped.message);
  const pauseRequested = files.pauseRequestedAt(taskId) !== undefined;
  const endedIn = files.lastCwd(taskId);
  files.clear(taskId);
  const after = await backend.getTask(task.id);
  // The core never writes to a task that left the workflow or runs again elsewhere, whatever this run's outcome.
  if (isRunOver(task, after)) return;
  // The session's directory as it stopped: a later resume must start in the same place, worktree included.
  if (endedIn !== undefined && endedIn !== plan.invocation.cwd) {
    await backend.updateTask(task.id, { workdir: endedIn, seal: sealing });
    deps.appendLog(taskId, `the session ended in ${endedIn}`);
  }
  const outcome = decideOutcome({
    exitCode: result.exitCode,
    signal: result.signal,
    stopped: result.stopped,
    pauseRequested,
    reported: after.status !== 'running',
  });
  if (outcome.kind === 'ok') return;
  if (outcome.kind === 'paused') {
    if (after.status === 'running')
      await backend.pause(
        task.id,
        `Paused on ${config.machine}: its ${record.lane} lane needed the slot for its own work. Resumes next, on ${config.machine}.`,
      );
    return;
  }
  const why = outcome.kind === 'failed' ? outcome.reason : 'The worker finished without reporting on the task.';
  await report(`${why}\n\nEnd of the log:\n${fence(deps.logTail(taskId) || '(empty)')}`);
}

export function runProcess(
  invocation: Invocation,
  taskId: string,
  env: Record<string, string>,
  watch: Watch,
  onLine: (line: string) => string | undefined = (line) => line,
): Promise<RunResult> {
  const fd = openLog(taskId);
  return new Promise((resolve, reject) => {
    // A new process group, so a stop also ends what the worker started. stdout comes here, line by line; stderr goes
    // straight into the log.
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ['pipe', 'pipe', fd],
      detached: true,
      env: { ...process.env, ...env },
    });
    // The prompt goes in on stdin, never in argv. A process that exits without reading it must not take the worker down.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(invocation.prompt);
    let buffered = '';
    const emit = (line: string): void => {
      const text = onLine(line);
      if (text !== undefined) writeSync(fd, `${text}\n`);
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        emit(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    });
    let stopped: RunResult['stopped'];
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    let checking = false;
    const timer = setInterval(() => {
      if (checking || stopped) return;
      checking = true;
      watch
        .tick()
        .then((decision) => {
          if (decision.kind === 'continue' || stopped) return;
          stopped = decision;
          killGroup('SIGTERM');
          setTimeout(() => killGroup('SIGKILL'), 10_000).unref();
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, watch.everyMs);
    // On a spawn failure both "error" and "close" fire.
    let finished = false;
    const finish = (): boolean => {
      if (finished) return false;
      finished = true;
      clearInterval(timer);
      if (buffered !== '') emit(buffered);
      closeLog(fd);
      return true;
    };
    child.on('error', (error) => {
      if (!finish()) return;
      reject(new Error(`could not start ${invocation.command}: ${error.message}`));
    });
    child.on('close', (exitCode, signal) => {
      if (!finish()) return;
      resolve(stopped ? { exitCode, signal, stopped } : { exitCode, signal });
    });
  });
}

const HOOK_BIN = fileURLToPath(new URL('../bin/agent-hook', import.meta.url));

// Hook commands run through a shell.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

if (import.meta.main) {
  await runMain(async () => {
    const [taskId, ...extra] = process.argv.slice(2);
    const usage = 'usage: worker <task>';
    if (!taskId || !isSafeTaskId(taskId)) throw new UsageError(usage);
    rejectExtraArgs(extra, usage);
    const context = buildContext(false);
    print(`worker ${taskId} log=${logPath(taskId)}`);
    const deps: WorkerDeps = {
      ...context,
      run: runProcess,
      logTail: readLogTail,
      notify: (task, text) => postSlack(context.config.slackWebhookFile, slackText(task, text)),
      resetLog,
      appendLog,
      pluginPath: resolvePluginPath,
      dirExists: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
      settingsEnv: readSettingsEnv,
      mcpServers: readMcpServers,
      home: homedir(),
      newSessionId: randomUUID,
      sessions: createSessionStore(),
      files: createRunFiles(),
      hookCommand: (runDir, id) => `${shellQuote(HOOK_BIN)} ${shellQuote(runDir)} ${shellQuote(id)}`,
      now: () => new Date(),
      watchEveryMs: 15_000,
    };
    try {
      await runWorker(deps, taskId);
    } catch (error) {
      appendLog(taskId, `worker failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });
}
