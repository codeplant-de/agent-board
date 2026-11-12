#!/usr/bin/env node
/**
 * One dispatcher tick: sweep stale Running cards, then fill free slots from the top of Todo.
 * No LLM calls. Add --dry-run to read everything and print every write and process start instead.
 */
import { fileURLToPath } from "node:url";
import { buildContext, print, runMain, takeFlag } from "./cli.mts";
import type { Context } from "./cli.mts";
import { LIST } from "./config.mts";
import { byPriority, decideStale, freeSlots, resolveLabel, startedAt, START_MARKER, unitName } from "./decide.mts";
import { createSystem } from "./system.mts";
import type { System } from "./system.mts";
import { postSlack, slackText } from "./notify.mts";
import { listId } from "./trello.mts";
import type { TrelloCard } from "./trello.mts";
import { readLogTail } from "./logs.mts";
import { fence, oneLine } from "./text.mts";

export interface DispatchDeps extends Context {
  system: System;
  now: () => Date;
  logTail: (shortLink: string) => string;
  notify: (card: TrelloCard, text: string) => Promise<void>;
}

export async function sendToNeedsMe(deps: DispatchDeps, card: TrelloCard, needsMeId: string, text: string): Promise<void> {
  await deps.trello.addComment(card.id, text);
  await deps.trello.moveCard(card.id, needsMeId);
  await deps.notify(card, oneLine(text, 300)).catch((error: unknown) => {
    deps.print(`WARN notify failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export async function runDispatch(deps: DispatchDeps): Promise<void> {
  const { trello, config, system, print: log } = deps;
  const [lists, cards] = await Promise.all([trello.getLists(), trello.getCards()]);
  const ids = { todo: listId(lists, LIST.todo), running: listId(lists, LIST.running), needsMe: listId(lists, LIST.needsMe) };
  const running = cards.filter((card) => card.idList === ids.running);

  let stillRunning = 0;
  for (const card of running) {
    const unit = unitName(card.shortLink);
    const decision = decideStale({
      unitActive: await system.isActive(unit),
      startedAt: startedAt(await trello.getComments(card.id)),
      now: deps.now(),
      timeoutMinutes: config.timeoutMinutes,
    });
    if (!decision.stale) {
      stillRunning++;
      continue;
    }
    // The worker may have reported and moved the card since the listing.
    if ((await trello.getCard(card.id)).idList !== ids.running) continue;
    if (decision.stopUnit) await system.stop(unit);
    log(`STALE ${card.shortLink} ${decision.reason}`);
    const tail = deps.logTail(card.shortLink);
    await sendToNeedsMe(deps, card, ids.needsMe, `${decision.reason}\n\nEnd of the log:\n${fence(tail || "(empty)")}`);
  }

  let slots = freeSlots(stillRunning, config.maxParallel);
  let started = 0;
  for (const card of byPriority(cards.filter((candidate) => candidate.idList === ids.todo))) {
    if (slots === 0) break;
    const resolved = resolveLabel(card, config.labels);
    if (!resolved.known) {
      log(`UNKNOWN-LABEL ${card.shortLink}`);
      await sendToNeedsMe(deps, card, ids.needsMe, resolved.reason);
      continue;
    }
    await trello.moveCard(card.id, ids.running);
    try {
      const { pid } = await system.startWorker(card.shortLink);
      const where = `unit ${unitName(card.shortLink)}${pid ? `, pid ${pid}` : ""}`;
      await trello.addComment(card.id, `${START_MARKER} ${deps.now().toISOString()} (${resolved.label}, ${where})`);
      log(`STARTED ${card.shortLink} ${resolved.label}`);
      slots--;
      started++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`START-FAILED ${card.shortLink} ${reason}`);
      await sendToNeedsMe(deps, card, ids.needsMe, `The worker could not be started: ${reason}`);
    }
  }
  log(`TICK running=${stillRunning + started} started=${started} max=${config.maxParallel}`);
}

if (import.meta.main) {
  await runMain(async () => {
    const args = process.argv.slice(2);
    const dryRun = takeFlag(args, "--dry-run");
    const context = buildContext(dryRun);
    const workerScript = fileURLToPath(new URL("./worker.mts", import.meta.url));
    await runDispatch({
      ...context,
      print,
      system: createSystem({ workerScript, dryRun, print }),
      now: () => new Date(),
      logTail: readLogTail,
      notify: async (card, text) => {
        if (dryRun) return print(`DRY slack ${card.shortLink} ${text}`);
        await postSlack(context.config.slackWebhookFile, slackText(card, text));
      },
    });
  });
}
