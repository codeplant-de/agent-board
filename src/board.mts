#!/usr/bin/env node
/**
 *   board comment <card> <text>   add a comment (long text is split; `-` reads the text from stdin)
 *   board move <card> <list>      move a card to the bottom of a list
 *   board notify <card> <text>    Slack message with the card link
 *   board lists                   cards per list
 *   board setup                   create missing lists and labels
 *
 * <card> is the short link (the 8 characters in the card URL) or the card id. Add --dry-run to print writes.
 */
import { buildContext, rejectExtraArgs, runMain, takeFlag, UsageError } from "./cli.mts";
import type { Context } from "./cli.mts";
import { LIST_NAMES } from "./config.mts";
import { postSlack, slackText } from "./notify.mts";
import { listId } from "./trello.mts";
import type { TrelloCard } from "./trello.mts";

async function readStdin(): Promise<string> {
  let content = "";
  for await (const chunk of process.stdin) content += String(chunk);
  return content.trim();
}

const USAGE = "usage: board comment <card> <text> | move <card> <list> | notify <card> <text> | lists | setup";

// The board CLI is reachable by the reviewer, so it only touches cards of the configured board.
async function boardCard(context: Context, card: string): Promise<TrelloCard> {
  const [found, boardId] = await Promise.all([context.trello.getCard(card), context.trello.getBoardId()]);
  if (found.idBoard !== boardId) throw new UsageError(`card ${card} is not on the configured board`);
  return found;
}

async function comment(context: Context, card: string, text: string): Promise<void> {
  const { id } = await boardCard(context, card);
  await context.trello.addComment(id, text);
}

async function move(context: Context, card: string, list: string): Promise<void> {
  const [{ id }, lists] = await Promise.all([boardCard(context, card), context.trello.getLists()]);
  await context.trello.moveCard(id, listId(lists, list));
}

async function notify(context: Context, card: string, text: string): Promise<void> {
  const found = await boardCard(context, card);
  const message = slackText(found, text);
  if (context.dryRun) return context.print(`DRY slack ${message.replaceAll("\n", " | ")}`);
  await postSlack(context.config.slackWebhookFile, message);
}

async function lists(context: Context): Promise<void> {
  const [boardLists, cards] = await Promise.all([context.trello.getLists(), context.trello.getCards()]);
  for (const list of boardLists) {
    const inList = cards.filter((card) => card.idList === list.id);
    context.print(`${list.name} (${inList.length})`);
    for (const card of inList.sort((a, b) => a.pos - b.pos)) {
      const labels = card.labels.map((label) => label.name).join(",") || "-";
      context.print(`  ${card.shortLink}  [${labels}]  ${card.name}`);
    }
  }
}

async function setup(context: Context): Promise<void> {
  const [boardLists, labels] = await Promise.all([context.trello.getLists(), context.trello.getLabels()]);
  for (const name of LIST_NAMES) {
    if (boardLists.some((list) => list.name === name)) continue;
    await context.trello.createList(name);
    context.print(`created list ${name}`);
  }
  for (const name of Object.keys(context.config.labels)) {
    if (labels.some((label) => label.name === name)) continue;
    await context.trello.createLabel(name);
    context.print(`created label ${name}`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const dryRun = takeFlag(args, "--dry-run");
  const [command, card, ...rest] = args;
  if (!command || command.startsWith("--") || card?.startsWith("--")) throw new UsageError(USAGE);
  if ((command === "lists" || command === "setup") && (card !== undefined || rest.length > 0)) rejectExtraArgs([card ?? "", ...rest], USAGE);
  const context = buildContext(dryRun);
  const text = rest.join(" ") === "-" ? await readStdin() : rest.join(" ");
  switch (command) {
    case "comment":
    case "notify":
      if (!card || !text) throw new UsageError(USAGE);
      return command === "comment" ? comment(context, card, text) : notify(context, card, text);
    case "move":
      if (!card || !text) throw new UsageError(USAGE);
      return move(context, card, text);
    case "lists":
      return lists(context);
    case "setup":
      return setup(context);
    default:
      throw new UsageError(USAGE);
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
