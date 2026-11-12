#!/usr/bin/env node
/**
 * Review requests to cards: one card per PR URL, checked against every list.
 * A card in Needs me or Done goes back to Todo when the PR's head moved and has settled.
 * Add --dry-run to read everything and print every write instead.
 */
import { buildContext, print, runMain, takeFlag } from "./cli.mts";
import type { Context } from "./cli.mts";
import { LIST } from "./config.mts";
import { formatDesc, parseDesc, parsePrUrl } from "./decide.mts";
import { createGitHub, GitHubError } from "./github.mts";
import type { GitHub, LivePr } from "./github.mts";
import { listId, TrelloError } from "./trello.mts";
import type { TrelloCard, TrelloList } from "./trello.mts";

const SETTLE_MS = 10 * 60_000;

export type IntakeAction =
  | { kind: "create"; pr: LivePr }
  | { kind: "requeue"; pr: LivePr; card: TrelloCard }
  | { kind: "skip"; pr: LivePr; reason: string };

export function planIntake(input: {
  prs: LivePr[];
  cards: TrelloCard[];
  lists: TrelloList[];
  repos: string[];
  now: Date;
}): IntakeAction[] {
  const listName = new Map(input.lists.map((list) => [list.id, list.name]));
  return input.prs.map((pr): IntakeAction => {
    if (pr.isDraft) return { kind: "skip", pr, reason: "draft" };
    const repo = parsePrUrl(pr.url)?.repo;
    if (repo === undefined || !input.repos.includes(repo)) return { kind: "skip", pr, reason: "repository not in config" };
    const settled = input.now.getTime() - pr.headCommittedAt.getTime() >= SETTLE_MS;
    const card = input.cards.find((candidate) => parseDesc(candidate.desc).input === pr.url);
    if (!card) return settled ? { kind: "create", pr } : { kind: "skip", pr, reason: "head not settled" };

    const { head } = parseDesc(card.desc);
    if (head === undefined || head === pr.headSha) return { kind: "skip", pr, reason: "card exists" };
    const name = listName.get(card.idList);
    if (name !== LIST.needsMe && name !== LIST.done) return { kind: "skip", pr, reason: `head moved, card is in ${name}` };
    return settled ? { kind: "requeue", pr, card } : { kind: "skip", pr, reason: "head moved, not settled" };
  });
}

export interface IntakeDeps extends Context {
  github: GitHub;
  now: () => Date;
}

export async function runIntake(deps: IntakeDeps): Promise<void> {
  const { trello, config, print: log } = deps;
  let prs: LivePr[];
  try {
    prs = await deps.github.listReviewRequested();
  } catch (error) {
    // A failed listing reads as an empty queue; change nothing.
    if (!(error instanceof GitHubError)) throw error;
    log(`LISTING-FAILED ${error.message}`);
    return;
  }
  const [lists, labels, cards] = await Promise.all([trello.getLists(), trello.getLabels(), trello.getCards()]);
  const todoId = listId(lists, LIST.todo);
  const actions = planIntake({ prs, cards, lists, repos: Object.keys(config.repos), now: deps.now() });

  let created = 0;
  let requeued = 0;
  for (const action of actions) {
    const { pr } = action;
    if (action.kind === "skip") {
      log(`SKIP #${pr.number} ${action.reason}`);
    } else if (action.kind === "create") {
      const label = labels.find((candidate) => candidate.name === config.intakeLabel);
      if (!label) throw new TrelloError(`board has no label "${config.intakeLabel}" (run: board setup)`);
      await trello.createCard({
        listId: todoId,
        name: `#${pr.number} ${pr.title} (${pr.author})`,
        desc: formatDesc(pr.url, pr.headSha),
        labelIds: [label.id],
      });
      log(`CREATED #${pr.number}`);
      created++;
    } else {
      // Move first: a card whose head line is updated but that never left Needs me would stay there for good.
      await trello.moveCard(action.card.id, todoId);
      await trello.setDescription(action.card.id, formatDesc(pr.url, pr.headSha));
      await trello.addComment(action.card.id, `New head ${pr.headSha.slice(0, 7)} on the PR. Queued again.`);
      log(`REQUEUED #${pr.number} ${pr.headSha.slice(0, 7)}`);
      requeued++;
    }
  }
  log(`INTAKE prs=${prs.length} created=${created} requeued=${requeued}`);
}

if (import.meta.main) {
  await runMain(async () => {
    const args = process.argv.slice(2);
    const dryRun = takeFlag(args, "--dry-run");
    await runIntake({ ...buildContext(dryRun), print, github: createGitHub(), now: () => new Date() });
  });
}
