import type { Credentials } from "./config.mts";
import { oneLine, splitText } from "./text.mts";

const BASE_URL = "https://api.trello.com/1";
const CARD_FIELDS = "name,desc,idList,shortLink,shortUrl,pos,labels";

export interface TrelloList {
  id: string;
  name: string;
}

export interface TrelloLabel {
  id: string;
  name: string;
}

export interface TrelloCard {
  id: string;
  shortLink: string;
  shortUrl: string;
  name: string;
  desc: string;
  idList: string;
  pos: number;
  labels: TrelloLabel[];
}

export interface TrelloComment {
  id: string;
  text: string;
  date: Date;
}

export interface NewCard {
  listId: string;
  name: string;
  desc: string;
  labelIds: string[];
}

export interface TrelloClient {
  getLists(): Promise<TrelloList[]>;
  getLabels(): Promise<TrelloLabel[]>;
  getCards(): Promise<TrelloCard[]>;
  getCard(idOrShortLink: string): Promise<TrelloCard>;
  getComments(cardId: string): Promise<TrelloComment[]>;
  addComment(cardId: string, text: string): Promise<void>;
  moveCard(cardId: string, listId: string): Promise<void>;
  setDescription(cardId: string, desc: string): Promise<void>;
  createCard(card: NewCard): Promise<TrelloCard>;
  createList(name: string): Promise<void>;
  createLabel(name: string): Promise<void>;
}

export class TrelloError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw new TrelloError(`unexpected Trello response: ${key} is not a string`);
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TrelloError("unexpected Trello response: expected a list");
  return value;
}

function parseNamed(value: unknown): TrelloList {
  if (!isRecord(value)) throw new TrelloError("unexpected Trello response: expected an object");
  return { id: str(value, "id"), name: str(value, "name") };
}

export function parseCard(value: unknown): TrelloCard {
  if (!isRecord(value)) throw new TrelloError("unexpected Trello response: expected a card");
  const pos = value["pos"];
  if (typeof pos !== "number") throw new TrelloError("unexpected Trello response: card pos is not a number");
  return {
    id: str(value, "id"),
    shortLink: str(value, "shortLink"),
    shortUrl: str(value, "shortUrl"),
    name: str(value, "name"),
    desc: str(value, "desc"),
    idList: str(value, "idList"),
    pos,
    labels: list(value["labels"] ?? []).map(parseNamed),
  };
}

function parseComment(value: unknown): TrelloComment {
  if (!isRecord(value) || !isRecord(value["data"])) throw new TrelloError("unexpected Trello response: comment");
  return { id: str(value, "id"), text: str(value["data"], "text"), date: new Date(str(value, "date")) };
}

export interface ClientOptions {
  credentials: Credentials;
  boardId: string;
  dryRun: boolean;
  print: (line: string) => void;
  fetchFn?: typeof fetch;
}

// The key and token travel in the Authorization header, never in the URL, so no URL needs hiding in logs.
// Documented at https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/
export function createTrelloClient(options: ClientOptions): TrelloClient {
  const { credentials, boardId, dryRun, print } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const authorization = `OAuth oauth_consumer_key="${credentials.key}", oauth_token="${credentials.token}"`;

  async function call(method: string, path: string, query: Record<string, string> = {}, body?: object): Promise<unknown> {
    const url = `${BASE_URL}${path}${Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : ""}`;
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new TrelloError(`Trello ${method} ${path} failed: network error`);
    }
    if (!response.ok) {
      const detail = oneLine(await response.text().catch(() => ""), 200);
      throw new TrelloError(`Trello ${method} ${path} failed: ${response.status} ${detail}`);
    }
    return response.json();
  }

  function write(method: string, path: string, body: object): Promise<unknown> | undefined {
    if (!dryRun) return call(method, path, {}, body);
    print(`DRY ${method} ${path} ${oneLine(JSON.stringify(body), 160)}`);
    return undefined;
  }

  return {
    async getLists() {
      return list(await call("GET", `/boards/${boardId}/lists`, { filter: "open", fields: "name" })).map(parseNamed);
    },
    async getLabels() {
      return list(await call("GET", `/boards/${boardId}/labels`, { fields: "name", limit: "1000" })).map(parseNamed);
    },
    async getCards() {
      return list(await call("GET", `/boards/${boardId}/cards`, { filter: "open", fields: CARD_FIELDS })).map(parseCard);
    },
    async getCard(idOrShortLink) {
      return parseCard(await call("GET", `/cards/${idOrShortLink}`, { fields: CARD_FIELDS }));
    },
    async getComments(cardId) {
      return list(await call("GET", `/cards/${cardId}/actions`, { filter: "commentCard", limit: "1000" })).map(parseComment);
    },
    async addComment(cardId, text) {
      for (const piece of splitText(text)) await write("POST", `/cards/${cardId}/actions/comments`, { text: piece });
    },
    async moveCard(cardId, listId) {
      await write("PUT", `/cards/${cardId}`, { idList: listId, pos: "bottom" });
    },
    async setDescription(cardId, desc) {
      await write("PUT", `/cards/${cardId}`, { desc });
    },
    async createCard(card) {
      const created = await write("POST", "/cards", {
        idList: card.listId,
        name: card.name,
        desc: card.desc,
        idLabels: card.labelIds.join(","),
        pos: "bottom",
      });
      if (created === undefined) {
        return { id: "dry", shortLink: "dry", shortUrl: "dry", name: card.name, desc: card.desc, idList: card.listId, pos: 0, labels: [] };
      }
      return parseCard(await created);
    },
    async createList(name) {
      await write("POST", "/lists", { name, idBoard: boardId, pos: "bottom" });
    },
    async createLabel(name) {
      await write("POST", "/labels", { name, color: null, idBoard: boardId });
    },
  };
}

export function listId(lists: TrelloList[], name: string): string {
  const found = lists.find((candidate) => candidate.name === name);
  if (!found) throw new TrelloError(`board has no list "${name}" (run: board setup)`);
  return found.id;
}
