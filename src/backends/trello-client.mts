import { isRecord } from "../guards.mts";
import { oneLine } from "../text.mts";

const BASE_URL = "https://api.trello.com/1";
const CARD_FIELDS = "name,desc,idList,idBoard,closed,shortLink,shortUrl,pos,labels";

// Trello caps a comment at 16384 characters; stay well under it.
export const COMMENT_MAX = 16000;

export interface Credentials {
  key: string;
  token: string;
}

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
  idBoard: string;
  closed: boolean;
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
  // Every card on the board, archived ones included.
  getAllCards(): Promise<TrelloCard[]>;
  // The board's long id; the config may hold a short link.
  getBoardId(): Promise<string>;
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

function str(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw new TrelloError(`unexpected Trello response: ${key} is not a string`);
  return value;
}

function bool(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") throw new TrelloError(`unexpected Trello response: ${key} is not a boolean`);
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
    idBoard: str(value, "idBoard"),
    closed: bool(value, "closed"),
    pos,
    labels: list(value["labels"] ?? []).map(parseNamed),
  };
}

function parseComment(value: unknown): TrelloComment {
  if (!isRecord(value) || !isRecord(value["data"])) throw new TrelloError("unexpected Trello response: comment");
  return { id: str(value, "id"), text: str(value["data"], "text"), date: new Date(str(value, "date")) };
}

// Splits at line breaks where possible, so each piece fits in one comment.
export function splitText(text: string, max: number = COMMENT_MAX): string[] {
  if (text.length <= max) return [text];
  const room = max - 20;
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > room) {
    const cut = rest.lastIndexOf("\n", room);
    const at = cut > room / 2 ? cut : room;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  pieces.push(rest);
  return pieces.map((piece, i) => `(part ${i + 1}/${pieces.length})\n${piece}`);
}

export interface ClientOptions {
  credentials: Credentials;
  boardId: string;
  fetchFn?: typeof fetch;
}

// The key and token travel in the Authorization header, never in the URL, so no URL needs hiding in logs.
// Documented at https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/
export function createTrelloClient(options: ClientOptions): TrelloClient {
  const { credentials, boardId } = options;
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
        signal: AbortSignal.timeout(15_000),
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

  let longBoardId: Promise<string> | undefined;
  const boardLongId = (): Promise<string> => {
    longBoardId ??= call("GET", `/boards/${boardId}`, { fields: "id" }).then((board) => {
      if (!isRecord(board)) throw new TrelloError("unexpected Trello response: expected a board");
      return str(board, "id");
    });
    return longBoardId;
  };

  return {
    getBoardId: boardLongId,
    async getAllCards() {
      return list(await call("GET", `/boards/${boardId}/cards/all`, { fields: CARD_FIELDS })).map(parseCard);
    },
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
      for (const piece of splitText(text)) await call("POST", `/cards/${cardId}/actions/comments`, {}, { text: piece });
    },
    async moveCard(cardId, listId) {
      await call("PUT", `/cards/${cardId}`, {}, { idList: listId, pos: "bottom" });
    },
    async setDescription(cardId, desc) {
      await call("PUT", `/cards/${cardId}`, {}, { desc });
    },
    async createCard(card) {
      return parseCard(
        await call("POST", "/cards", {}, { idList: card.listId, name: card.name, desc: card.desc, idLabels: card.labelIds.join(","), pos: "bottom" }),
      );
    },
    async createList(name) {
      await call("POST", "/lists", {}, { name, idBoard: await boardLongId(), pos: "bottom" });
    },
    async createLabel(name) {
      await call("POST", "/labels", {}, { name, color: null, idBoard: await boardLongId() });
    },
  };
}
