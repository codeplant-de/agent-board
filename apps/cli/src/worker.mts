#!/usr/bin/env node
/**
 * One task: resolve its label, run the worker command, log, and report failures on the task.
 * Started by the dispatcher as the transient unit agent-board-<id>. While the run goes on it checks every half
 * minute: no tool call for inactivityMinutes, or a run longer than maxRunHours, stops it; a pause request that the
 * agent does not follow within a few minutes stops it too. It passes the agent's liveness on to the board.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildContext, print, rejectExtraArgs, runMain, UsageError } from "./cli.mts";
import type { Context } from "./cli.mts";
import { isSafeTaskId } from "@agent-board/shared";
import type { Task } from "@agent-board/shared";
import { buildInvocation, decideOutcome, PAUSE_MARKER, planRun, resolveLabel, supervise, usesPluginPlaceholder } from "./decide.mts";
import type { Invocation, RunPlan, Supervision } from "./decide.mts";
import { createRunFiles } from "./runtime.mts";
import type { RunFiles } from "./runtime.mts";
import { appendLog, closeLog, logPath, openLog, readLogTail, resetLog } from "./logs.mts";
import { resolvePluginPath } from "./plugins.mts";
import { postSlack, slackText } from "./notify.mts";
import { sendToNeedsMe } from "./report.mts";
import { fence } from "./text.mts";

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  // Set when the watch stopped the run.
  stopped?: Exclude<Supervision, { kind: "continue" }>;
}

// Called every `everyMs` while the process runs; a stop decision ends it (SIGTERM, then SIGKILL).
export interface Watch {
  everyMs: number;
  tick: () => Promise<Supervision>;
}

// How long a run may take to stop by itself after a pause was asked for.
const PAUSE_GRACE_MINUTES = 5;
// The board's liveness is updated at most this often.
const HEARTBEAT_EVERY_MS = 60_000;

export interface WorkerDeps extends Context {
  // `env` is added to the process's environment: the secrets of the invocation's masked variables.
  run: (invocation: Invocation, taskId: string, env: Record<string, string>, watch: Watch) => Promise<RunResult>;
  logTail: (taskId: string) => string;
  notify: (task: Task, text: string) => Promise<void>;
  resetLog: (taskId: string) => void;
  appendLog: (taskId: string, text: string) => void;
  // Root of a plugin such as "pr-review@ccc"; throws with the reason when it cannot be resolved.
  pluginPath: (key: string) => string;
  dirExists: (path: string) => boolean;
  home: string;
  fallbackCwd: string;
  newSessionId: () => string;
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

  const resolved = resolveLabel(task, config.labels);
  if (!resolved.known) return fail(resolved.reason);
  let prReviewPath: string | undefined;
  if (usesPluginPlaceholder(resolved.entry)) {
    try {
      prReviewPath = deps.pluginPath("pr-review@ccc");
    } catch (error) {
      return fail(`Cannot resolve the pr-review plugin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const isSkillLabel = resolved.entry.kind === "skill";
  // A skill run starts a Claude session the next run can resume; a command label has none.
  let run: RunPlan = { kind: "fresh", sessionId: "" };
  if (resolved.entry.kind === "skill") {
    run = planRun(task, await backend.readNotes(task.id), deps.newSessionId);
    deps.appendLog(taskId, run.kind === "resume" ? `resuming session ${run.sessionId}` : `new session ${run.sessionId}`);
    // Stored before the run: a reply that comes after a failed run still finds the session. The resume is used up either way.
    await backend.updateTask(task.id, run.kind === "fresh" ? { sessionId: run.sessionId, next: "fresh" } : { next: "fresh" });
  } else if (task.next === "resume") {
    await backend.updateTask(task.id, { next: "fresh" });
  }
  const plan = buildInvocation({
    run,
    hookCommand: resolved.entry.kind === "skill" ? deps.hookCommand(deps.files.dir, taskId) : undefined,
    entry: resolved.entry,
    task,
    repos: config.repos,
    home: deps.home,
    fallbackCwd: deps.fallbackCwd,
    prReviewPath,
    workdir: task.workdir,
  });
  if (!plan.ok) return fail(plan.reason);
  if (!deps.dirExists(plan.invocation.cwd)) {
    const resuming = run.kind === "resume" && task.workdir === plan.invocation.cwd;
    return fail(
      resuming
        ? `The directory this task's session last worked in is gone: ${plan.invocation.cwd}. Recreate it to resume there, or use Re-run fresh to start over.`
        : `The working directory does not exist: ${plan.invocation.cwd}`,
    );
  }
  deps.appendLog(taskId, `working directory ${plan.invocation.cwd}`);
  // Bound to the task from now on: a resume starts here unless the agent moves on (into a worktree, say).
  if (isSkillLabel && task.workdir !== plan.invocation.cwd) await backend.updateTask(task.id, { workdir: plan.invocation.cwd });

  const env: Record<string, string> = {};


  const files = deps.files;
  // The dispatcher wrote the lane before it started this worker; a run started without one counts as the first lane's own.
  const record = files.readRun(taskId) ?? { lane: config.lanes[0]?.name ?? "default", borrowed: false, startedAt: deps.now() };
  const startedAt = deps.now();
  const isSkill = resolved.entry.kind === "skill";
  let lastBeat = 0;
  let lastSeen: number | undefined;
  const beat = async (): Promise<void> => {
    // A command label makes no tool calls: it is alive while its process runs.
    const seen = isSkill ? files.lastActive(taskId)?.getTime() : deps.now().getTime();
    const due = deps.now().getTime() - lastBeat >= HEARTBEAT_EVERY_MS;
    if (lastBeat !== 0 && (!due || seen === undefined || seen === lastSeen)) return;
    lastBeat = deps.now().getTime();
    lastSeen = seen;
    await backend.heartbeat(task.id, { lane: record.lane, borrowed: record.borrowed }).catch((error: unknown) => {
      deps.appendLog(taskId, `heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const watch: Watch = {
    everyMs: deps.watchEveryMs,
    tick: async () => {
      await beat();
      return supervise({
        now: deps.now(),
        startedAt,
        lastActive: isSkill ? files.lastActive(taskId) : deps.now(),
        pauseRequestedAt: files.pauseRequestedAt(taskId),
        limits: config,
        pauseGraceMinutes: PAUSE_GRACE_MINUTES,
      });
    },
  };

  let result: RunResult;
  try {
    await beat();
    result = await deps.run(plan.invocation, taskId, env, watch);
  } catch (error) {
    files.clear(taskId);
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (result.stopped) deps.appendLog(taskId, result.stopped.message);
  const pauseRequested = files.pauseRequestedAt(taskId) !== undefined;
  const endedIn = files.lastCwd(taskId);
  files.clear(taskId);
  const after = await backend.getTask(task.id);
  // The session's directory as it stopped: a later resume must start in the same place, worktree included.
  if (!after.closed && endedIn !== undefined && endedIn !== plan.invocation.cwd) {
    await backend.updateTask(task.id, { workdir: endedIn });
    deps.appendLog(taskId, `the session ended in ${endedIn}`);
  }
  // Closed during the run (archived, or parked by hand): the task left the workflow, so nobody is waiting for a report.
  // The core never writes to a closed task, whatever the run's outcome.
  if (after.closed) return;
  const outcome = decideOutcome({
    exitCode: result.exitCode,
    signal: result.signal,
    stopped: result.stopped,
    pauseRequested,
    reported: after.status === "needs-me" || after.status === "done",
  });
  if (outcome.kind === "ok") return;
  if (outcome.kind === "paused") {
    if (after.status === "running") await backend.pause(task.id, `${PAUSE_MARKER} ${config.machine}: its ${record.lane} lane needed the slot for its own work. Resumes next, on ${config.machine}.`);
    return;
  }
  const why = outcome.kind === "failed" ? outcome.reason : "The worker finished without reporting on the task.";
  await report(`${why}\n\nEnd of the log:\n${fence(deps.logTail(taskId) || "(empty)")}`);
}

export function runProcess(invocation: Invocation, taskId: string, env: Record<string, string>, watch: Watch): Promise<RunResult> {
  const fd = openLog(taskId);
  return new Promise((resolve, reject) => {
    // A new process group, so a stop also ends what the worker started.
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["ignore", fd, fd],
      detached: true,
      env: { ...process.env, ...env },
    });
    let stopped: RunResult["stopped"];
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
          if (decision.kind === "continue" || stopped) return;
          stopped = decision;
          killGroup("SIGTERM");
          setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
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
      closeLog(fd);
      return true;
    };
    child.on("error", (error) => {
      if (!finish()) return;
      reject(new Error(`could not start ${invocation.command}: ${error.message}`));
    });
    child.on("close", (exitCode, signal) => {
      if (!finish()) return;
      resolve(stopped ? { exitCode, signal, stopped } : { exitCode, signal });
    });
  });
}

const HOOK_BIN = fileURLToPath(new URL("../bin/agent-hook", import.meta.url));

// Hook commands run through a shell.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}


if (import.meta.main) {
  await runMain(async () => {
    const [taskId, ...extra] = process.argv.slice(2);
    const usage = "usage: worker <task>";
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
      home: homedir(),
      fallbackCwd: homedir(),
      newSessionId: randomUUID,
      files: createRunFiles(),
      hookCommand: (runDir, id) => `${shellQuote(HOOK_BIN)} ${shellQuote(runDir)} ${id}`,
      now: () => new Date(),
      watchEveryMs: 30_000,
    };
    try {
      await runWorker(deps, taskId);
    } catch (error) {
      appendLog(taskId, `worker failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });
}
