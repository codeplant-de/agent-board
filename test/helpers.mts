import type { Config } from "../src/config.mts";
import type { NewCard, TrelloCard, TrelloClient, TrelloComment, TrelloLabel, TrelloList } from "../src/trello.mts";

export const LISTS: TrelloList[] = [
  { id: "l-todo", name: "Todo" },
  { id: "l-running", name: "Running" },
  { id: "l-needs", name: "Needs me" },
  { id: "l-done", name: "Done" },
];

export function card(overrides: Partial<TrelloCard> & { shortLink: string }): TrelloCard {
  return {
    id: `id-${overrides.shortLink}`,
    shortUrl: `https://trello.com/c/${overrides.shortLink}`,
    name: `card ${overrides.shortLink}`,
    desc: "",
    idList: "l-todo",
    idBoard: "board-long",
    closed: false,
    pos: 1,
    labels: [],
    ...overrides,
  };
}

export const CONFIG: Config = {
  boardId: "board",
  maxParallel: 2,
  timeoutMinutes: 45,
  slackWebhookFile: "/nonexistent",
  intakeLabel: "review-pr",
  repos: { "cosuno/cosuno": "/work/cosuno" },
  labels: {
    selftest: { kind: "command", command: ["sleep", "300"], cwd: undefined },
    "review-pr": {
      kind: "skill",
      skill: "board-review-pr",
      allowedTools: ["Read", "Bash(board *)"],
      disallowedTools: ["Bash(git push *)"],
      cwd: "pr-repo",
    },
  },
};

export interface FakeTrello extends TrelloClient {
  cards: TrelloCard[];
  comments: Map<string, TrelloComment[]>;
  writes: string[];
}

// In-memory board. Every write lands in `writes` as a short string, so tests assert on what was done.
export function fakeTrello(cards: TrelloCard[], labels: TrelloLabel[] = [{ id: "lab-review", name: "review-pr" }]): FakeTrello {
  const state: FakeTrello = {
    cards,
    comments: new Map(),
    writes: [],
    async getLists() {
      return LISTS;
    },
    async getLabels() {
      return labels;
    },
    async getBoardId() {
      return "board-long";
    },
    async getAllCards() {
      return state.cards.map((c) => ({ ...c }));
    },
    async getCards() {
      return state.cards.filter((c) => !c.closed).map((c) => ({ ...c }));
    },
    async getCard(idOrShortLink) {
      const found = state.cards.find((c) => c.id === idOrShortLink || c.shortLink === idOrShortLink);
      if (!found) throw new Error(`no card ${idOrShortLink}`);
      return { ...found };
    },
    async getComments(cardId) {
      return state.comments.get(cardId) ?? [];
    },
    async addComment(cardId, text) {
      state.writes.push(`comment ${cardId}: ${text}`);
    },
    async moveCard(cardId, listId) {
      state.writes.push(`move ${cardId} -> ${LISTS.find((l) => l.id === listId)?.name}`);
      const found = state.cards.find((c) => c.id === cardId);
      if (found) found.idList = listId;
    },
    async setDescription(cardId, desc) {
      state.writes.push(`desc ${cardId}: ${desc}`);
    },
    async createCard(newCard: NewCard) {
      state.writes.push(`create ${newCard.name} | ${newCard.desc}`);
      return card({ shortLink: "new", name: newCard.name, desc: newCard.desc });
    },
    async createList(name) {
      state.writes.push(`list ${name}`);
    },
    async createLabel(name) {
      state.writes.push(`label ${name}`);
    },
  };
  return state;
}
