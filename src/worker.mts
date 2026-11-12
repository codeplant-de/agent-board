#!/usr/bin/env node
/**
 * One task: resolve its label, run the worker command, log, and report failures on the task.
 * Started by the dispatcher as the transient unit agent-board-<id>.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { buildContext, print, rejectExtraArgs, runMain, UsageError } from "./cli.mts";
import type { Context } from "./cli.mts";
import { isSafeTaskId } from "./contract.mts";
import type { Task } from "./contract.mts";
import { buildInvocation, decideOutcome, resolveLabel, usesPluginPlaceholder } from "./decide.mts";
import type { Invocation } from "./decide.mts";
import { appendLog, closeLog, logPath, openLog, readLogTail, resetLog } from "./logs.mts";
import { resolveInstallPath } from "./plugins.mts";
import { postSlack, slackText } from "./notify.mts";
import { sendToNeedsMe } from "./report.mts";
import { fence } from "./text.mts";

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface WorkerDeps extends Context {
  run: (invocation: Invocation, taskId: string, timeoutMs: number) => Promise<RunResult>;
  logTail: (taskId: string) => string;
  notify: (task: Task, text: string) => Promise<void>;
  resetLog: (taskId: string) => void;
  appendLog: (taskId: string, text: string) => void;
  // Install path of a plugin such as "pr-review@ccc"; throws with the reason when it cannot be resolved.
  pluginPath: (key: string) => string;
  dirExists: (path: string) => boolean;
  home: string;
  fallbackCwd: string;
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
  const plan = buildInvocation({
    entry: resolved.entry,
    task,
    repos: config.repos,
    home: deps.home,
    fallbackCwd: deps.fallbackCwd,
    prReviewPath,
  });
  if (!plan.ok) return fail(plan.reason);
  if (!deps.dirExists(plan.invocation.cwd)) return fail(`The working directory does not exist: ${plan.invocation.cwd}`);

  let result: RunResult;
  try {
    result = await deps.run(plan.invocation, taskId, config.timeoutMinutes * 60_000);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const after = await backend.getTask(task.id);
  const outcome = decideOutcome({
    ...result,
    timeoutMinutes: config.timeoutMinutes,
    reported: after.status === "needs-me" || after.status === "done",
  });
  if (outcome.kind === "ok") return;
  const why = outcome.kind === "failed" ? outcome.reason : "The worker finished without reporting on the task.";
  await report(`${why}\n\nEnd of the log:\n${fence(deps.logTail(taskId) || "(empty)")}`);
}

export function runProcess(invocation: Invocation, taskId: string, timeoutMs: number): Promise<RunResult> {
  const fd = openLog(taskId);
  return new Promise((resolve, reject) => {
    // A new process group, so a timeout also stops what the worker started.
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["ignore", fd, fd],
      detached: true,
    });
    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    // On a spawn failure both "error" and "close" fire.
    let finished = false;
    const finish = (): boolean => {
      if (finished) return false;
      finished = true;
      clearTimeout(timer);
      closeLog(fd);
      return true;
    };
    child.on("error", (error) => {
      if (!finish()) return;
      reject(new Error(`could not start ${invocation.command}: ${error.message}`));
    });
    child.on("close", (exitCode, signal) => {
      if (!finish()) return;
      resolve({ exitCode, signal, timedOut });
    });
  });
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
      pluginPath: resolveInstallPath,
      dirExists: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
      home: homedir(),
      fallbackCwd: homedir(),
    };
    try {
      await runWorker(deps, taskId);
    } catch (error) {
      appendLog(taskId, `worker failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });
}
