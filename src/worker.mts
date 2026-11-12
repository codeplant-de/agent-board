#!/usr/bin/env node
/**
 * One task: resolve its label, run the worker command, log, and report failures on the task.
 * Started by the dispatcher as the transient unit agent-board-<id>.
 */
import { execFile, spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
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
  // `env` is added to the process's environment: the secrets of the invocation's masked variables.
  run: (invocation: Invocation, taskId: string, timeoutMs: number, env: Record<string, string>) => Promise<RunResult>;
  // Output of a command, trimmed; throws with a reason that never contains the output.
  secret: (command: string[]) => Promise<string>;
  listDir: (dir: string) => string[];
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
    listDir: deps.listDir,
  });
  if (!plan.ok) return fail(plan.reason);
  if (!deps.dirExists(plan.invocation.cwd)) return fail(`The working directory does not exist: ${plan.invocation.cwd}`);

  const env: Record<string, string> = {};
  for (const masked of plan.invocation.maskedEnv) {
    try {
      env[masked.name] = await deps.secret(masked.command);
    } catch (error) {
      return fail(`Cannot read ${masked.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let result: RunResult;
  try {
    result = await deps.run(plan.invocation, taskId, config.timeoutMinutes * 60_000, env);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const after = await backend.getTask(task.id);
  // Closed during the run (archived, or parked by hand): the task left the workflow, so nobody is waiting for a report.
  // The core never writes to a closed task, whatever the run's outcome.
  if (after.closed) return;
  const outcome = decideOutcome({
    ...result,
    timeoutMinutes: config.timeoutMinutes,
    reported: after.status === "needs-me" || after.status === "done",
  });
  if (outcome.kind === "ok") return;
  const why = outcome.kind === "failed" ? outcome.reason : "The worker finished without reporting on the task.";
  await report(`${why}\n\nEnd of the log:\n${fence(deps.logTail(taskId) || "(empty)")}`);
}

export function runProcess(invocation: Invocation, taskId: string, timeoutMs: number, env: Record<string, string>): Promise<RunResult> {
  const fd = openLog(taskId);
  return new Promise((resolve, reject) => {
    // A new process group, so a timeout also stops what the worker started.
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["ignore", fd, fd],
      detached: true,
      env: { ...process.env, ...env },
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

// stdout of a command, for a secret the worker hands to claude. Errors name the command, never its output.
export function readSecret(command: string[]): Promise<string> {
  const [file, ...args] = command;
  return new Promise((resolve, reject) => {
    if (file === undefined) return reject(new Error("the command is empty"));
    execFile(file, args, { timeout: 15_000, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) return reject(new Error(`${file} failed`));
      const value = stdout.trim();
      if (value === "") return reject(new Error(`${file} printed nothing`));
      resolve(value);
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
      secret: readSecret,
      listDir: (dir) => readdirSync(dir),
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
