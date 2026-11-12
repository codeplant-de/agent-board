import { oneLine } from "./text.mts";
import type { TrelloCard, TrelloClient } from "./trello.mts";

export interface ReportDeps {
  trello: TrelloClient;
  print: (line: string) => void;
  notify: (card: TrelloCard, text: string) => Promise<void>;
}

// Comment, move to Needs me, then tell Slack. A failed Slack post is only a warning.
export async function sendToNeedsMe(deps: ReportDeps, card: TrelloCard, needsMeId: string, text: string): Promise<void> {
  await deps.trello.addComment(card.id, text);
  await deps.trello.moveCard(card.id, needsMeId);
  await deps.notify(card, oneLine(text, 300)).catch((error: unknown) => {
    deps.print(`WARN notify failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
