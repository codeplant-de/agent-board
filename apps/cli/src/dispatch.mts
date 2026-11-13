#!/usr/bin/env node
/**
 * One dispatcher tick: sweep stale Running tasks, then fill free slots from the top of Todo.
 * No LLM calls. Add --dry-run to read everything and print every write and process start instead.
 */
import { fileURLToPath } from "node:url";
import { buildContext, print, rejectExtraArgs, runMain, takeFlag } from "./cli.mts";
import type { Context } from "./cli.mts";
import type { Task } from "@agent-board/shared";
import { decideStale, freeSlots, notServableHere, resolveLabel, startedAt, START_MARKER, unitName } from "./decide.mts";
import { createSystem } from "./system.mts";
import type { System } from "./system.mts";
import { postSlack, slackText } from "./notify.mts";
import { readLogTail } from "./logs.mts";
import { sendToNeedsMe } from "./report.mts";
import { fence } from "./text.mts";

export interface DispatchDeps extends Context {
  system: System;
  now: () => Date;
  logTail: (taskId: string) => string;
  notify: (task: Task, text: string) => Promise<void>;
}

export async function runDispatch(deps: DispatchDeps): Promise<void> {
  const { backend, config, system, print: log } = deps;
  const tasks = await backend.listTasks();
  // The unit of a task lives on the machine that claimed it; another machine's tasks are its own business.
  const running = tasks.filter((task) => task.status === "running" && (task.machine === null || task.machine === config.machine));

  let stillRunning = 0;
  for (const task of running) {
    const unit = unitName(task.id);
    const unitActive = await system.isActive(unit);
    // The unit knows when this run began; a note would also count an earlier run of a requeued task.
    const unitStart = unitActive ? await system.startedAt(unit) : undefined;
    const decision = decideStale({
      unitActive,
      startedAt: unitStart ?? startedAt(await backend.readNotes(task.id)),
      now: deps.now(),
      timeoutMinutes: config.timeoutMinutes,
    });
    if (!decision.stale) {
      stillRunning++;
      continue;
    }
    // The worker may have reported and moved the task since the listing.
    if ((await backend.getTask(task.id)).status !== "running") continue;
    if (decision.stopUnit) await system.stop(unit);
    log(`STALE ${task.id} ${decision.reason}`);
    const tail = deps.logTail(task.id);
    await sendToNeedsMe(deps, task, `${decision.reason}\n\nEnd of the log:\n${fence(tail || "(empty)")}`);
  }

  // A task can be running with its unit gone, or a unit can outlive its task: count the larger of the two.
  const activeWorkers = await system.activeWorkers();
  let slots = freeSlots(Math.max(stillRunning, activeWorkers.length), config.maxParallel);
  let started = 0;
  // The backend lists tasks in priority order, so the top of Todo comes first.
  for (const task of tasks.filter((candidate) => candidate.status === "todo")) {
    if (slots === 0) break;
    // No label at all: no machine can run it.
    if (task.labels.length === 0) {
      log(`NO-LABEL ${task.id}`);
      await sendToNeedsMe(deps, task, `This task has no label, so no worker can run it. Known labels here: ${Object.keys(config.labels).join(", ")}.`);
      continue;
    }
    // Another machine may know the label, have the checkout or hold the session.
    const elsewhere = notServableHere(task, config.machine, config.labels, config.repos);
    if (elsewhere !== undefined) {
      log(`SKIP ${task.id} ${elsewhere}`);
      continue;
    }
    const resolved = resolveLabel(task, config.labels);
    if (!resolved.known) continue;
    if ((await backend.claimTask(task.id, config.machine)) === undefined) {
      log(`LOST ${task.id} claimed elsewhere`);
      continue;
    }
    let pid: number | undefined;
    try {
      ({ pid } = await system.startWorker(task.id));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`START-FAILED ${task.id} ${reason}`);
      await sendToNeedsMe(deps, task, `The worker could not be started: ${reason}`);
      // Whatever broke it will break the next start too.
      break;
    }
    slots--;
    started++;
    log(`STARTED ${task.id} ${resolved.label}`);
    const where = `unit ${unitName(task.id)}${pid ? `, pid ${pid}` : ""}`;
    await backend.addNote(task.id, `${START_MARKER} ${deps.now().toISOString()} (${resolved.label}, ${config.machine}, ${where})`, { author: "system" }).catch((error: unknown) => {
      log(`WARN start note failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  log(`TICK running=${stillRunning + started} started=${started} max=${config.maxParallel}`);
}

if (import.meta.main) {
  await runMain(async () => {
    const args = process.argv.slice(2);
    const dryRun = takeFlag(args, "--dry-run");
    rejectExtraArgs(args, "usage: dispatch [--dry-run]");
    const context = buildContext(dryRun);
    const workerScript = fileURLToPath(new URL("./worker.mts", import.meta.url));
    await runDispatch({
      ...context,
      print,
      system: createSystem({ workerScript, dryRun, print }),
      now: () => new Date(),
      logTail: readLogTail,
      notify: async (task, text) => {
        if (dryRun) return print(`DRY slack ${task.id} ${text}`);
        await postSlack(context.config.slackWebhookFile, slackText(task, text));
      },
    });
  });
}
