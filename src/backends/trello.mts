#!/usr/bin/env node
/**
 * The Trello backend: implements the backend contract (see README) on a Trello board.
 * Credentials come from ~/.config/agent-board/env, the board and list names from trello.json next to it.
 *
 *   trello-backend version | list-tasks [--all] | get-task <id> | add-task | update-task <id>
 *                  | add-note <id> | read-notes <id> | setup
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, getPaths, readSecretFile } from "../config.mts";
import { CONTRACT_VERSION, ContractError, isSafeTaskId, parseDraft, parsePatch, parseSetupRequest, STATUSES, UNKNOWN_COMMAND_EXIT } from "../contract.mts";
import type { Backend, Note, Status, Task } from "../contract.mts";
import { isRecord } from "../guards.mts";
import { createTrelloClient, TrelloError } from "./trello-client.mts";
import type { Credentials, TrelloCard, TrelloClient } from "./trello-client.mts";

export type ListNames = Record<Status, string>;

export const DEFAULT_LIST_NAMES: ListNames = { todo: "Todo", running: "Running", "needs-me": "Needs me", done: "Done" };

export function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

export function loadCredentials(path: string): Credentials {
  const env = parseEnv(readSecretFile(path, "credentials file"));
  const key = env["TRELLO_API_KEY"];
  const token = env["TRELLO_TOKEN"];
  if (!key || !token) throw new ConfigError(`credentials file needs TRELLO_API_KEY and TRELLO_TOKEN: ${path}`);
  return { key, token };
}

export interface TrelloConfig {
  boardId: string;
  lists: ListNames;
}

export function parseTrelloConfig(raw: unknown): TrelloConfig {
  if (!isRecord(raw)) throw new ConfigError("trello.json: top level must be an object");
  const boardId = raw["boardId"];
  if (typeof boardId !== "string" || boardId.trim() === "") throw new ConfigError("trello.json: boardId must be a non-empty string");
  const rawLists = raw["lists"] ?? {};
  if (!isRecord(rawLists)) throw new ConfigError("trello.json: lists must be an object");
  const lists = { ...DEFAULT_LIST_NAMES };
  for (const [status, name] of Object.entries(rawLists)) {
    const known = STATUSES.find((candidate) => candidate === status);
    if (known === undefined) throw new ConfigError(`trello.json: lists.${status} is not a status (${STATUSES.join(", ")})`);
    if (typeof name !== "string" || name === "") throw new ConfigError(`trello.json: lists.${status} must be a non-empty string`);
    lists[known] = name;
  }
  return { boardId, lists };
}

function loadTrelloConfig(path: string): TrelloConfig {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`Trello config missing: ${path} (create it with {"boardId": "..."})`);
  }
  try {
    return parseTrelloConfig(JSON.parse(content));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConfigError(`Trello config is not valid JSON: ${path}`);
    throw error;
  }
}

// Ids travel in URL paths, so anything but a plain id is refused here too.
function cardId(id: string): string {
  if (!isSafeTaskId(id)) throw new TrelloError(`"${id.slice(0, 40)}" is not a valid task id`);
  return id;
}

export function createTrelloBackend(client: TrelloClient, listNames: ListNames): Backend {
  async function statusByListId(): Promise<Map<string, Status>> {
    const lists = await client.getLists();
    const byId = new Map<string, Status>();
    for (const status of STATUSES) {
      const found = lists.find((list) => list.name === listNames[status]);
      if (found) byId.set(found.id, status);
    }
    return byId;
  }

  // A card outside the four lists is parked: closed, so it counts for dedup and nothing else.
  function toTask(card: TrelloCard, statuses: Map<string, Status>): Task {
    const status = statuses.get(card.idList);
    return {
      id: card.shortLink,
      title: card.name,
      input: card.desc,
      labels: card.labels.map((label) => label.name),
      status: status ?? "done",
      url: card.shortUrl,
      closed: card.closed || status === undefined,
    };
  }

  async function listIdFor(status: Status): Promise<string> {
    for (const [id, candidate] of await statusByListId()) if (candidate === status) return id;
    throw new TrelloError(`board has no list "${listNames[status]}" (run: board setup)`);
  }

  // Everything that touches a card by id goes through here: a foreign card is never read or written.
  async function boardCard(id: string): Promise<TrelloCard> {
    const [card, boardId] = await Promise.all([client.getCard(cardId(id)), client.getBoardId()]);
    if (card.idBoard !== boardId) throw new TrelloError(`task ${id} is not on the configured board`);
    return card;
  }

  async function getTask(id: string): Promise<Task> {
    const [card, statuses] = await Promise.all([boardCard(id), statusByListId()]);
    return toTask(card, statuses);
  }

  return {
    async listTasks({ all = false } = {}) {
      const [cards, statuses] = await Promise.all([all ? client.getAllCards() : client.getCards(), statusByListId()]);
      return cards
        .sort((a, b) => a.pos - b.pos)
        .map((card) => toTask(card, statuses))
        .filter((task) => all || !task.closed);
    },
    getTask,
    async addTask(draft) {
      const [listId, labels] = await Promise.all([listIdFor(draft.status), client.getLabels()]);
      const labelIds = draft.labels.map((name) => {
        const found = labels.find((label) => label.name === name);
        if (!found) throw new TrelloError(`board has no label "${name}" (run: board setup)`);
        return found.id;
      });
      const card = await client.createCard({ listId, name: draft.title, desc: draft.input, labelIds });
      return toTask(card, await statusByListId());
    },
    async updateTask(id, patch) {
      const card = await boardCard(id);
      // Move before the description, so a failure in between leaves the card where it was reported.
      if (patch.status !== undefined) await client.moveCard(card.id, await listIdFor(patch.status));
      if (patch.input !== undefined) await client.setDescription(card.id, patch.input);
      return getTask(id);
    },
    async addNote(id, text) {
      await client.addComment((await boardCard(id)).id, text);
    },
    async readNotes(id) {
      const comments = await client.getComments((await boardCard(id)).id);
      // Trello lists the newest first.
      return comments.map((comment): Note => ({ text: comment.text, createdAt: comment.date })).reverse();
    },
    async setup(labels) {
      const [lists, existing] = await Promise.all([client.getLists(), client.getLabels()]);
      const created: string[] = [];
      for (const status of STATUSES) {
        if (lists.some((list) => list.name === listNames[status])) continue;
        await client.createList(listNames[status]);
        created.push(`list ${listNames[status]}`);
      }
      for (const name of labels) {
        if (existing.some((label) => label.name === name)) continue;
        await client.createLabel(name);
        created.push(`label ${name}`);
      }
      return created;
    },
  };
}

async function readStdin(): Promise<string> {
  let content = "";
  for await (const chunk of process.stdin) content += String(chunk);
  return content;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ContractError(`${what} on stdin is not valid JSON`);
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "version") return printJson({ contract: CONTRACT_VERSION });
  const known = ["list-tasks", "get-task", "add-task", "update-task", "add-note", "read-notes", "setup"];
  if (command === undefined || !known.includes(command)) {
    console.error(`trello-backend: unknown command "${command ?? ""}"`);
    process.exitCode = UNKNOWN_COMMAND_EXIT;
    return;
  }
  const { configDir } = getPaths();
  const config = loadTrelloConfig(join(configDir, "trello.json"));
  const client = createTrelloClient({ credentials: loadCredentials(join(configDir, "env")), boardId: config.boardId });
  const backend = createTrelloBackend(client, config.lists);
  const [id, ...rest] = args;
  const needId = (): string => {
    if (id === undefined || rest.length > 0) throw new ContractError(`usage: ${command} <id>`);
    return id;
  };
  switch (command) {
    case "list-tasks": {
      const all = id === "--all";
      if (args.length > (all ? 1 : 0)) throw new ContractError("usage: list-tasks [--all]");
      return printJson(await backend.listTasks({ all }));
    }
    case "get-task":
      return printJson(await backend.getTask(needId()));
    case "add-task":
      return printJson(await backend.addTask(parseDraft(parseJson(await readStdin(), "draft"))));
    case "update-task": {
      const taskId = needId();
      return printJson(await backend.updateTask(taskId, parsePatch(parseJson(await readStdin(), "patch"))));
    }
    case "add-note": {
      const taskId = needId();
      const text = await readStdin();
      if (text.trim() === "") throw new ContractError("note text on stdin is empty");
      return backend.addNote(taskId, text);
    }
    case "read-notes":
      return printJson((await backend.readNotes(needId())).map((note) => ({ text: note.text, createdAt: note.createdAt.toISOString() })));
    case "setup":
      return printJson({ created: await backend.setup(parseSetupRequest(parseJson(await readStdin(), "setup request"))) });
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const expected = error instanceof ConfigError || error instanceof TrelloError || error instanceof ContractError;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`trello-backend: ${expected ? message : `unexpected error: ${message}`}`);
    process.exitCode = 1;
  }
}
