#!/usr/bin/env node
/**
 * One card: resolve its label, run the worker command, log, and report failures on the card.
 * Started by the dispatcher as the transient unit agent-board-<shortLink>.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { buildContext, print, runMain, UsageError } from "./cli.mts";
import type { Context } from "./cli.mts";
import { LIST } from "./config.mts";
import { buildInvocation, decideOutcome, resolveLabel } from "./decide.mts";
import type { Invocation } from "./decide.mts";
import { closeLog, logPath, openLog, readLogTail } from "./logs.mts";
import { postSlack, slackText } from "./notify.mts";
import { fence, oneLine } from "./text.mts";
import { listId } from "./trello.mts";
import type { TrelloCard } from "./trello.mts";

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface WorkerDeps extends Context {
  run: (invocation: Invocation, shortLink: string, timeoutMs: number) => Promise<RunResult>;
  logTail: (shortLink: string) => string;
  notify: (card: TrelloCard, text: string) => Promise<void>;
  home: string;
  fallbackCwd: string;
}

export async function runWorker(deps: WorkerDeps, shortLink: string): Promise<void> {
  const { trello, config } = deps;
  const [card, lists] = await Promise.all([trello.getCard(shortLink), trello.getLists()]);
  const needsMeId = listId(lists, LIST.needsMe);

  const report = async (text: string): Promise<void> => {
    await trello.addComment(card.id, text);
    await trello.moveCard(card.id, needsMeId);
    await deps.notify(card, oneLine(text, 300)).catch((error: unknown) => {
      deps.print(`WARN notify failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const resolved = resolveLabel(card, config.labels);
  if (!resolved.known) return report(resolved.reason);
  const plan = buildInvocation({
    entry: resolved.entry,
    card,
    repos: config.repos,
    home: deps.home,
    fallbackCwd: deps.fallbackCwd,
  });
  if (!plan.ok) return report(plan.reason);

  let result: RunResult;
  try {
    result = await deps.run(plan.invocation, shortLink, config.timeoutMinutes * 60_000);
  } catch (error) {
    return report(error instanceof Error ? error.message : String(error));
  }
  const after = await trello.getCard(card.id);
  const outcome = decideOutcome({
    ...result,
    timeoutMinutes: config.timeoutMinutes,
    stillRunning: after.idList === listId(lists, LIST.running),
  });
  if (outcome.kind === "ok") return;
  const why = outcome.kind === "failed" ? outcome.reason : "The worker finished without reporting on the card.";
  await report(`${why}\n\nEnd of the log:\n${fence(deps.logTail(shortLink) || "(empty)")}`);
}

export function runProcess(invocation: Invocation, shortLink: string, timeoutMs: number): Promise<RunResult> {
  const fd = openLog(shortLink);
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
    const shortLink = process.argv[2];
    if (!shortLink) throw new UsageError("usage: worker <card>");
    const context = buildContext(false);
    print(`worker ${shortLink} log=${logPath(shortLink)}`);
    await runWorker(
      {
        ...context,
        run: runProcess,
        logTail: readLogTail,
        notify: (card, text) => postSlack(context.config.slackWebhookFile, slackText(card, text)),
        home: homedir(),
        fallbackCwd: homedir(),
      },
      shortLink,
    );
  });
}
