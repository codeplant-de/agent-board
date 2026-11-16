/**
 * One task: run `claude -p` for it, keep its log and transcript, and report failures on the task.
 * Started by the dispatcher as the transient unit agent-board-<id>. The agent's prompt and what comes after it travel on
 * stdin as stream-json user messages, so the worker can talk to a running agent: it tells it that a pause was requested, and
 * hands it what the user sends from the board, checking the board's run inbox every 15 seconds and whenever the board's event
 * stream says tasks changed. While the run goes on it also checks: no tool call for inactivityMinutes, or a run longer than
 * maxRunHours, interrupts it; so does a pause request that the agent does not follow within a few minutes. It passes the
 * agent's liveness on to the board.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { BackendError, isVocabularyRefusal, loadWebConfig, updateCliHint, verifyContract } from './backend.mts';
import { watchBoardChanges } from './changes.mts';
import { buildContext, print, UsageError } from './cli.mts';
import type { Context } from './cli.mts';
import { isRecord, isSafeTaskId } from '@agent-board/shared';
import { logLine, StreamCondenser } from '@agent-board/shared';
import type { RunInbox, Task } from '@agent-board/shared';
import {
  buildInvocation,
  decideOutcome,
  inboxMessageText,
  isRunOver,
  neverRun,
  ownLane,
  pauseMessageText,
  PLUGIN_MARKETPLACE,
  planRun,
  pluginPlaceholders,
  supervise,
  unreadableForRun,
} from './decide.mts';
import { getPaths } from './config.mts';
import { isAllowedDir, tryRealpath } from './dirs.mts';
import { selfCommand } from './self.mts';
import { pickEnv, readMcpServers, readSettingsEnv } from './settings-env.mts';
import type { Invocation, Supervision } from './decide.mts';
import { createRunFiles } from './runtime.mts';
import type { RunFiles } from './runtime.mts';
import { createSessionStore } from './sessions.mts';
import type { SessionStore } from './sessions.mts';
import { appendLog, closeLog, logPath, openLog, readLogTail, resetLog } from './logs.mts';
import { resolvePluginPath } from './plugins.mts';
import { plainLine } from './terminal.mts';
import { errorText, fence } from './text.mts';
import { createTranscriptUploader } from './transcript-upload.mts';

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  // Set when the watch stopped the run.
  stopped?: Exclude<Supervision, { kind: 'continue' }>;
}

// The worker's way to a running agent: its stdin.
export interface RunChannel {
  // Hands the agent a user message, which it takes up at its next tool boundary. False when stdin was closed already: nothing
  // was written.
  send: (text: string) => boolean;
  // Stops what the agent is doing at once; its session stays resumable, and a message sent after the interrupt carries the run on.
  interrupt: () => void;
  // Closes stdin: the agent exits once its turn is over. Nothing can be sent after that.
  end: () => void;
  // Interrupt, end, and kill the process if it is still there after the kill grace: what a stop decision does.
  stop: () => void;
  readonly open: boolean;
}

// Called every `everyMs` while the process runs; a stop decision interrupts it and closes its stdin, and kills it (SIGTERM, then
// SIGKILL) if it is still there `killGraceMs` later. A tick decides from the clock and the run's own files alone: the calls
// to the board it starts (liveness, transcript, inbox) run on their own, so a board that is slow, down or hostile cannot hold
// the run's limits back.
export interface Watch {
  everyMs: number;
  // Default: 30 seconds.
  killGraceMs?: number;
  // Called once the process runs, with the channel to it.
  start?: (channel: RunChannel) => void;
  tick: () => Promise<Supervision>;
}

// How long a run may take to end its turn by itself after a pause was asked for.
const PAUSE_GRACE_MINUTES = 2;
// How long a stopped process has to exit on its own before it is killed.
const KILL_GRACE_MS = 30_000;
// The board's liveness is updated at most this often.
const HEARTBEAT_EVERY_MS = 15_000;

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
  resetLog: (taskId: string) => void;
  appendLog: (taskId: string, text: string) => void;
  // Root of a plugin such as "pr-review@ccc"; throws with the reason when it cannot be resolved.
  pluginPath: (key: string) => string;
  dirExists: (path: string) => boolean;
  // The real path of an existing path; undefined when it is not there. Decides whether a directory is in the dirs list.
  realpath: (path: string) => string | undefined;
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
  // Calls `onChange` whenever the board says tasks changed; returns the function that stops listening. Without it only the
  // watch's own tick looks at the run inbox.
  watchChanges?: (onChange: () => void) => () => void;
  // The transcript backlog's byte budget; `createTranscriptUploader` has the default.
  maxPendingBytes?: number;
  watchEveryMs: number;
}

export async function runWorker(deps: WorkerDeps, taskId: string): Promise<void> {
  const { backend, config } = deps;
  deps.resetLog(taskId);
  const task = await backend.getTask(taskId);

  const report = async (text: string): Promise<void> => {
    await backend.fail(task.id, text);
  };

  // A failure before the process starts leaves the log empty, so it goes in the log too.
  // It also ends the run, so the dispatcher's run files go.
  const fail = async (reason: string): Promise<void> => {
    deps.appendLog(taskId, reason);
    deps.files.clear(taskId);
    await report(reason);
  };

  // Never run what could not be opened: an empty prompt or a missing directory would run something else.
  const unreadable = unreadableForRun(task);
  if (unreadable.length > 0)
    return fail(
      `The task's ${unreadable.join(' and ')} could not be decrypted with this machine's data key, so it was not run. Check AGENT_BOARD_DATA_KEY against the board's Settings page.`,
    );

  const refused = neverRun(task);
  if (refused !== undefined) return fail(refused);

  const fromIntake = task.createdBy === 'intake';
  if (fromIntake && !config.intakeEnabled)
    return fail(
      'This task came from intake, and config.json on this machine has no intake block: its rules would be missing.',
    );
  // What a new directory is sealed against: the task's own creator and schedule, as the board has them.
  const sealing = { createdBy: task.createdBy, scheduleId: task.scheduleId };
  const pluginRoots: Record<string, string> = {};
  for (const name of fromIntake
    ? pluginPlaceholders([...config.intake.allowedTools, ...config.intake.disallowedTools])
    : []) {
    try {
      pluginRoots[name] = deps.pluginPath(`${name}@${PLUGIN_MARKETPLACE}`);
    } catch (error) {
      return fail(`Cannot resolve the ${name} plugin: ${errorText(error)}`);
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
        ? `This task's directory is gone: ${plan.invocation.cwd}. Recreate it to run there, or use Re-run fresh to start over${task.createdBy === 'intake' ? '' : ' in the directory it was created with, or the default one when it had none'}.`
        : `The working directory does not exist: ${plan.invocation.cwd}`,
    );
  }
  if (!isAllowedDir(config.dirs, plan.invocation.cwd, deps.realpath))
    return fail(
      `${plainLine(plan.invocation.cwd)} is not a listed directory on ${config.machine}: workers here run only in listed directories. Run "board dirs add" in it on ${config.machine}${fromIntake ? ' (an intake review runs in the checkout named in repos)' : ''}, then use Re-run fresh or Send & continue.`,
    );
  deps.appendLog(taskId, `working directory ${plan.invocation.cwd}`);
  // Bound to the task from now on: it runs here unless the agent moves on (into a worktree, say).
  if (task.workdir !== plan.invocation.cwd)
    await backend.updateTask(task.id, { workdir: plan.invocation.cwd, seal: sealing });

  // Intake loads only the user's settings; the tokens and endpoints it is allowed come from the checkout's.
  // Print mode kills background work 10 minutes after the last turn; 0 waits for it, and the heartbeat and stop handling still bound the run.
  // AGENT_BOARD_START_DIR: whose settings the run loaded; a check of `board wait` gets their `env` too.
  const fixedEnv = {
    AGENT_BOARD_TASK: taskId,
    AGENT_BOARD_START_DIR: plan.invocation.cwd,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  };
  let env: Record<string, string> = fixedEnv;
  if (fromIntake && config.intake.env.length > 0) {
    const picked = pickEnv(deps.settingsEnv(plan.invocation.cwd), config.intake.env);
    env = { ...picked.env, ...fixedEnv };
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
      deps.appendLog(taskId, `heartbeat failed: ${errorText(error)}`);
    });
  };
  // The transcript: condensed stream-json events, sent in batches with each check and once more at the end.
  const condenser = new StreamCondenser(deps.now);
  const runId = deps.newSessionId();
  const transcript = createTranscriptUploader({
    post: (events) =>
      backend.transcript(task.id, {
        runId,
        startedAt: startedAt.toISOString(),
        sessionId: run.sessionId,
        resumed: run.kind === 'resume',
        events,
      }),
    now: deps.now,
    log: (text) => deps.appendLog(taskId, text),
    note: (text) => condenser.note(text),
    maxBytes: deps.maxPendingBytes,
  });
  let beating: Promise<void> | undefined;
  const startBeat = (): Promise<void> => {
    beating ??= beat().finally(() => {
      beating = undefined;
    });
    return beating;
  };
  const onLine = (line: string): string | undefined => {
    const events = condenser.line(line);
    transcript.add(events);
    const text = events.map(logLine).filter((part) => part !== undefined);
    return text.length > 0 ? text.join('\n') : undefined;
  };
  // What the user sent the running agent: messages are handed over, a stop request interrupts it. One look at a time; a change
  // that comes in meanwhile makes one more.
  let channel: RunChannel | undefined;
  let inboxOff = false;
  let looking: Promise<void> | undefined;
  let lookAgain = false;
  // The messages the agent has been handed, so that a lost acknowledgement does not hand one over twice.
  const handedOver = new Set<string>();
  // An interrupt for a stop request is out and not acknowledged yet: the request is not acted on again.
  let interrupted = false;
  // The run was ended because the user asked for a stop, with nothing to carry on with.
  let endedByStop = false;
  let pauseTold = false;
  const logFailure = (what: string, error: unknown): void => {
    deps.appendLog(taskId, `${what}: ${errorText(error)}`);
  };
  const handOver = async (live: RunChannel, inbox: RunInbox): Promise<string[]> => {
    const acknowledged: string[] = [];
    for (const message of inbox.messages) {
      // Only the user's own comments are the agent's to read: the board's answer is not trusted to hold anything else.
      if (message.author !== 'user' || message.kind !== 'comment') {
        deps.appendLog(
          taskId,
          `a note in the run inbox is not a comment of the user's, so it was not handed to the agent; it is acknowledged so that it does not come back (${message.id})`,
        );
      } else if (message.unreadable) {
        deps.appendLog(
          taskId,
          `a message of the user's could not be decrypted with this machine's data key, so it was not handed to the agent; it is acknowledged so that it does not come back (${message.id})`,
        );
      } else if (!handedOver.has(message.id)) {
        if (!live.send(inboxMessageText(task.id, message, inbox.stop))) break;
        handedOver.add(message.id);
        deps.appendLog(taskId, `handed the agent a message of the user's (${message.id})`);
      }
      acknowledged.push(message.id);
    }
    return acknowledged;
  };
  const lookAtInbox = async (): Promise<void> => {
    const live = channel;
    if (inboxOff || live === undefined || !live.open) return;
    let inbox: RunInbox;
    try {
      inbox = await backend.runInbox(task.id);
    } catch (error) {
      if (error instanceof BackendError && error.missingFeature !== undefined) {
        inboxOff = true;
        deps.appendLog(taskId, 'the board has no run inbox: messages and stop requests are not delivered');
      } else if (!(error instanceof BackendError && error.status === 409)) logFailure('run inbox failed', error);
      return;
    }
    // The run ended while the board answered.
    if (!live.open) return;
    const act = inbox.stop && !interrupted;
    // A plain stop hands nothing over: what is pending stays pending. Stop & send hands over all of it, the stop's own message last.
    const plainStop = inbox.stop && inbox.stopMessage === undefined;
    if (act) {
      if (!plainStop) live.interrupt();
      interrupted = true;
      deps.appendLog(taskId, 'the user asked to stop: interrupted the agent');
    }
    const ids = plainStop ? [] : await handOver(live, inbox);
    // A message after the interruption carries the run on; without one the run ends.
    if (inbox.stop && (plainStop || !inbox.messages.some((message) => handedOver.has(message.id)))) {
      live.stop();
      endedByStop = true;
    }
    if (ids.length === 0 && !inbox.stop) return;
    try {
      await backend.ackMessages(task.id, { ids, stop: inbox.stop });
      if (inbox.stop) interrupted = false;
    } catch (error) {
      logFailure('acknowledging the run inbox failed', error);
    }
  };
  const startLooking = (): Promise<void> => {
    if (looking !== undefined) {
      lookAgain = true;
      return looking;
    }
    looking = lookAtInbox()
      .catch((error: unknown) => logFailure('run inbox failed', error))
      .finally(() => {
        looking = undefined;
        if (lookAgain) {
          lookAgain = false;
          void startLooking();
        }
      });
    return looking;
  };
  const watch: Watch = {
    everyMs: deps.watchEveryMs,
    start: (live) => {
      channel = live;
      // The board marks the run as one that reads its inbox, which is what keeps a late message from being lost.
      void startLooking();
    },
    tick: async () => {
      void startBeat();
      void transcript.start();
      void startLooking();
      if (!pauseTold && channel?.open && files.pauseRequestedAt(taskId) !== undefined) {
        pauseTold = channel.send(pauseMessageText(task.id));
        if (pauseTold)
          deps.appendLog(taskId, 'the lane needs the slot: asked the agent to post a status and end its turn');
      }
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
  const stopListening = deps.watchChanges?.(() => void startLooking());
  try {
    void startBeat();
    result = await deps.run(plan.invocation, taskId, env, watch, onLine);
  } catch (error) {
    stopListening?.();
    files.clear(taskId);
    if (run.kind === 'fresh') await backend.updateTask(task.id, { sessionId: null });
    return fail(errorText(error));
  }
  stopListening?.();
  await transcript.flush();
  if (result.stopped) deps.appendLog(taskId, result.stopped.message);
  const pauseRequested = files.pauseRequestedAt(taskId) !== undefined;
  const endedIn = files.lastCwd(taskId);
  let after: Task;
  try {
    after = await backend.getTask(task.id);
  } catch (error) {
    if (!isVocabularyRefusal(error)) {
      files.clear(taskId);
      throw error;
    }
    // The run's files stay: once the CLI is updated, the sweep finds this task running without a unit and deals with it.
    deps.appendLog(
      taskId,
      `the board shows this task with a value this CLI does not know, so its end is not reported; ${updateCliHint()}`,
    );
    return;
  }
  files.clear(taskId);
  try {
    // The core never writes to a task that left the workflow or runs again elsewhere, whatever this run's outcome.
    if (isRunOver(task, after)) return;
    // The session's directory as it stopped: a later resume must start in the same place, worktree included.
    if (endedIn !== undefined && endedIn !== plan.invocation.cwd) {
      if (isAllowedDir(config.dirs, endedIn, deps.realpath)) {
        await backend.updateTask(task.id, { workdir: endedIn, seal: sealing });
        deps.appendLog(taskId, `the session ended in ${endedIn}`);
      } else {
        // Stored, it would strand the task: the next start would refuse its own directory.
        const shown = plainLine(endedIn);
        deps.appendLog(taskId, `the session ended in ${shown}, not a listed directory; the workdir stays`);
        await backend
          .addNote(
            task.id,
            `The agent ended in ${shown}, which is not a listed directory on ${config.machine}. The next resume starts in ${plainLine(plan.invocation.cwd)}.`,
            { author: 'system' },
          )
          .catch((error: unknown) => {
            deps.appendLog(taskId, `could not add the note: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
    }
    const outcome = decideOutcome({
      exitCode: result.exitCode,
      signal: result.signal,
      stopped: result.stopped,
      pauseRequested,
      stopRequested: endedByStop,
      reported: after.status !== 'running',
    });
    if (outcome.kind === 'ok') return;
    if (outcome.kind === 'stopped') {
      if (after.status === 'running') await backend.stopped(task.id, 'Stopped by you.');
      return;
    }
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
  } catch (error) {
    if (!isVocabularyRefusal(error)) throw error;
    deps.appendLog(
      taskId,
      `the board refused to show this task to this CLI, so the end of the run is not reported; ${updateCliHint()}`,
    );
  }
}

// A user message as `claude --input-format stream-json` reads it.
const userMessageLine = (text: string): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

const interruptLine = (): string =>
  `${JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })}\n`;

// Whether a line of the agent's output is the end of a turn.
function isResultLine(line: string): boolean {
  if (!line.includes('"result"')) return false;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) && parsed['type'] === 'result';
  } catch {
    return false;
  }
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
    // A process that exits without reading its stdin must not take the worker down.
    child.stdin?.on('error', () => undefined);
    let ended = false;
    let stopping = false;
    let killTimer: NodeJS.Timeout | undefined;
    // An interrupt is out and its turn has not ended yet; `carryOn`: a message was sent after it, so the run goes on.
    let interruptOut = false;
    let carryOn = false;
    const channel: RunChannel = {
      get open() {
        return !ended;
      },
      send(text) {
        if (ended) return false;
        child.stdin?.write(userMessageLine(text));
        if (interruptOut) carryOn = true;
        return true;
      },
      interrupt() {
        if (ended) return;
        child.stdin?.write(interruptLine());
        interruptOut = true;
      },
      end() {
        if (ended) return;
        ended = true;
        child.stdin?.end();
      },
      stop() {
        // The agent is asked to stop first, so that its session ends cleanly and stays resumable.
        channel.interrupt();
        channel.end();
        stopping = true;
        killTimer ??= setTimeout(terminate, watch.killGraceMs ?? KILL_GRACE_MS);
        killTimer.unref();
      },
    };
    // The prompt goes in on stdin, never in argv, and stdin stays open for what follows.
    child.stdin?.write(userMessageLine(invocation.prompt));
    let buffered = '';
    const emit = (line: string): void => {
      const text = onLine(line);
      if (text !== undefined) writeSync(fd, `${text}\n`);
      // The turn is over and nothing is waiting to be written: close stdin, and the agent exits.
      if (!isResultLine(line)) return;
      if (interruptOut) {
        interruptOut = false;
        if (carryOn) {
          carryOn = false;
          return;
        }
      }
      channel.end();
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
    const terminate = (): void => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 10_000).unref();
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
          channel.stop();
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
      clearTimeout(killTimer);
      ended = true;
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
      // What a stopped agent left running goes with it.
      if (stopping) terminate();
      resolve(stopped ? { exitCode, signal, stopped } : { exitCode, signal });
    });
    watch.start?.(channel);
  });
}

// Hook commands run through a shell.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function hookCommand(runDir: string, id: string): string {
  return `${selfCommand('internal', 'hook').map(shellQuote).join(' ')} ${shellQuote(runDir)} ${shellQuote(id)}`;
}

export async function workerMain(taskId: string): Promise<void> {
  if (!isSafeTaskId(taskId)) throw new UsageError(`"${taskId.slice(0, 40)}" is not a task id`);
  const context = buildContext(false);
  print(`worker ${taskId} log=${logPath(taskId)}`);
  const deps: WorkerDeps = {
    ...context,
    run: runProcess,
    logTail: readLogTail,
    resetLog,
    appendLog,
    pluginPath: resolvePluginPath,
    dirExists: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
    realpath: tryRealpath,
    settingsEnv: readSettingsEnv,
    mcpServers: readMcpServers,
    home: homedir(),
    newSessionId: randomUUID,
    sessions: createSessionStore(),
    files: createRunFiles(),
    hookCommand,
    now: () => new Date(),
    watchChanges: (onChange) => {
      const stop = new AbortController();
      void (async () => {
        try {
          const config = loadWebConfig(getPaths().configDir);
          // A board without the stream is only checked on the timer.
          if (!(await verifyContract(config)).features.has('events')) return;
          await watchBoardChanges(
            {
              config,
              fetch: (url, init) => fetch(url, init),
              onChange,
              log: (line) => appendLog(taskId, line),
              retryMs: 10_000,
              idleMs: 60_000,
            },
            stop.signal,
          );
        } catch (error) {
          appendLog(taskId, `no event stream for the run inbox: ${errorText(error)}`);
        }
      })();
      return () => stop.abort();
    },
    watchEveryMs: 15_000,
  };
  try {
    await runWorker(deps, taskId);
  } catch (error) {
    appendLog(taskId, `worker failed: ${errorText(error)}`);
    throw error;
  }
}
