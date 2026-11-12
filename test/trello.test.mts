import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTrelloClient } from "../src/backends/trello-client.mts";
import { createTrelloBackend, DEFAULT_LIST_NAMES, loadCredentials, parseEnv, parseTrelloConfig } from "../src/backends/trello.mts";
import { ConfigError } from "../src/config.mts";
import { isRecord } from "../src/guards.mts";

const credentials = { key: "KEY123", token: "TOKEN456" };
const LISTS = [
  { id: "l-todo", name: "Todo" },
  { id: "l-running", name: "Running" },
  { id: "l-needs", name: "Needs me" },
  { id: "l-done", name: "Done" },
];

function trelloCard(shortLink: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `long-${shortLink}`,
    shortLink,
    shortUrl: `https://trello.com/c/${shortLink}`,
    name: `card ${shortLink}`,
    desc: "",
    idList: "l-todo",
    idBoard: "board-long",
    closed: false,
    pos: 1,
    labels: [],
    ...overrides,
  };
}

interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

// Canned Trello: answers by method and path, records every request.
function trello(cards: Record<string, unknown>[], extra: { lists?: unknown[]; labels?: unknown[]; comments?: unknown[] } = {}) {
  const seen: Seen[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const body = isRecord(parsed) ? parsed : undefined;
    seen.push({ method, url, headers: new Headers(init?.headers), body });
    const path = url.pathname.replace("/1", "");
    if (method === "GET" && path === "/boards/b") return Response.json({ id: "board-long" });
    if (method === "GET" && path === "/boards/b/lists") return Response.json(extra.lists ?? LISTS);
    if (method === "GET" && path === "/boards/b/labels") return Response.json(extra.labels ?? [{ id: "lab-review", name: "review-pr" }]);
    if (method === "GET" && (path === "/boards/b/cards" || path === "/boards/b/cards/all")) return Response.json(cards);
    const cardPath = /^\/cards\/([^/]+)(\/actions(\/comments)?)?$/.exec(path);
    if (cardPath) {
      const found = cards.find((card) => card["shortLink"] === cardPath[1] || card["id"] === cardPath[1]);
      if (cardPath[2] && method === "GET") return Response.json(extra.comments ?? []);
      if (cardPath[2]) return Response.json({});
      if (found && method === "GET") return Response.json(found);
      if (found && method === "PUT") {
        const moved = typeof body?.["idList"] === "string" ? { idList: body["idList"] } : {};
        const described = typeof body?.["desc"] === "string" ? { desc: body["desc"] } : {};
        return Response.json({ ...found, ...moved, ...described });
      }
    }
    if (method === "POST" && path === "/cards") return Response.json(trelloCard("new1", { name: body?.["name"], desc: body?.["desc"], idList: body?.["idList"] }));
    if (method === "POST") return Response.json({});
    return new Response("not found", { status: 404 });
  };
  const backend = createTrelloBackend(createTrelloClient({ credentials, boardId: "b", fetchFn }), DEFAULT_LIST_NAMES);
  const writes = (): Seen[] => seen.filter((request) => request.method !== "GET");
  return { backend, seen, writes };
}

test("lists map to statuses, and the order is the card position", async () => {
  const { backend } = trello([
    trelloCard("b", { pos: 20, labels: [{ id: "1", name: "review-pr" }] }),
    trelloCard("a", { pos: 5, idList: "l-running" }),
    trelloCard("c", { pos: 7, idList: "l-needs", desc: "https://x\nhead: abc1234" }),
    trelloCard("d", { pos: 8, idList: "l-done" }),
    trelloCard("p", { pos: 9, idList: "l-backlog" }),
  ]);
  const tasks = await backend.listTasks();
  assert.deepEqual(tasks.map((t) => [t.id, t.status]), [["a", "running"], ["c", "needs-me"], ["d", "done"], ["b", "todo"]]);
  const first = tasks.find((t) => t.id === "b");
  assert.deepEqual(first, { id: "b", title: "card b", input: "", labels: ["review-pr"], status: "todo", url: "https://trello.com/c/b", closed: false });
  assert.equal(tasks.find((t) => t.id === "c")?.input, "https://x\nhead: abc1234");
});

test("all includes archived cards and cards parked outside the four lists, as closed", async () => {
  const { backend, seen } = trello([trelloCard("a", { closed: true, idList: "l-done" }), trelloCard("p", { idList: "l-backlog" }), trelloCard("t")]);
  const all = await backend.listTasks({ all: true });
  assert.ok(seen.some((request) => request.url.pathname === "/1/boards/b/cards/all"));
  assert.deepEqual(all.map((t) => [t.id, t.closed]).sort(), [["a", true], ["p", true], ["t", false]]);
  assert.deepEqual((await backend.listTasks()).map((t) => t.id), ["t"]);
});

test("a status change moves the card to the bottom of the matching list, in one write", async () => {
  const { backend, seen, writes } = trello([trelloCard("a")]);
  const updated = await backend.updateTask("a", { status: "needs-me" });
  assert.equal(updated.id, "a");
  assert.equal(updated.status, "needs-me", "the task comes from the response of the write");
  const [move, ...rest] = writes();
  assert.equal(move?.method, "PUT");
  assert.equal(move?.url.pathname, "/1/cards/long-a");
  assert.deepEqual(move?.body, { idList: "l-needs", pos: "bottom" });
  assert.equal(rest.length, 0);
  // Card, board and lists are read together, then the write: two rounds, not four requests in a row.
  assert.deepEqual(seen.map((request) => request.method), ["GET", "GET", "GET", "PUT"]);
});

test("a patch with a status and an input is one combined write", async () => {
  const { backend, writes } = trello([trelloCard("a", { idList: "l-needs" })]);
  const updated = await backend.updateTask("a", { status: "todo", input: "new" });
  assert.deepEqual(writes().map((w) => w.body), [{ idList: "l-todo", pos: "bottom", desc: "new" }]);
  assert.deepEqual([updated.status, updated.input], ["todo", "new"]);
  await backend.updateTask("a", { input: "newer" });
  assert.deepEqual(writes().map((w) => w.body).at(-1), { desc: "newer" });
});

test("a board without one of the four lists fails every read and write by name, before any write", async () => {
  const { backend, writes } = trello([trelloCard("a")], { lists: [{ id: "l-todo", name: "Todo" }] });
  const expected = /board has no list "Running" \(run: board setup\)/;
  await assert.rejects(backend.listTasks(), expected);
  await assert.rejects(backend.listTasks({ all: true }), expected);
  await assert.rejects(backend.getTask("a"), expected);
  await assert.rejects(backend.updateTask("a", { status: "todo" }), expected);
  await assert.rejects(backend.addNote("a", "hi"), expected);
  await assert.rejects(backend.addTask({ title: "t", input: "", labels: [], status: "todo" }), expected);
  assert.deepEqual(writes(), []);
});

test("list names can be overridden per status", async () => {
  const lists = parseTrelloConfig({ boardId: "b", lists: { "needs-me": "Review" } }).lists;
  assert.deepEqual(lists, { ...DEFAULT_LIST_NAMES, "needs-me": "Review" });
  assert.throws(() => parseTrelloConfig({ boardId: "b", lists: { waiting: "x" } }), ConfigError);
  assert.throws(() => parseTrelloConfig({ boardId: "" }), ConfigError);
});

test("two statuses on one list are refused", () => {
  assert.throws(() => parseTrelloConfig({ boardId: "b", lists: { running: "Todo" } }), /"todo" and "running"|"running" and "todo"/);
  assert.throws(() => parseTrelloConfig({ boardId: "b", lists: { done: "Needs me" } }), ConfigError);
  assert.doesNotThrow(() => parseTrelloConfig({ boardId: "b", lists: { done: "Finished" } }));
});

test("a card of another board is refused before any write", async () => {
  const { backend, writes } = trello([trelloCard("x", { idBoard: "other-board" })]);
  await assert.rejects(backend.getTask("x"), /task x is not on the configured board/);
  await assert.rejects(backend.updateTask("x", { status: "done" }), /not on the configured board/);
  await assert.rejects(backend.addNote("x", "hi"), /not on the configured board/);
  await assert.rejects(backend.readNotes("x"), /not on the configured board/);
  assert.deepEqual(writes(), []);
});

test("an id that is not a plain id never reaches a URL", async () => {
  const { backend, seen } = trello([trelloCard("a")]);
  await assert.rejects(backend.getTask("../boards/b"), /not a valid task id/);
  assert.ok(seen.every((request) => !request.url.pathname.includes("..") && !request.url.pathname.startsWith("/1/cards")));
});

test("credentials go in the Authorization header, never in a URL or an error", async () => {
  const { backend, seen } = trello([trelloCard("a")]);
  await backend.listTasks();
  await backend.getTask("a");
  await backend.updateTask("a", { input: "x" });
  assert.ok(seen.length > 0);
  for (const request of seen) {
    assert.equal(request.headers.get("authorization"), 'OAuth oauth_consumer_key="KEY123", oauth_token="TOKEN456"');
    assert.doesNotMatch(request.url.href, /KEY123|TOKEN456/);
  }
  const failing = createTrelloBackend(createTrelloClient({ credentials, boardId: "b", fetchFn: async () => new Response("invalid token", { status: 401 }) }), DEFAULT_LIST_NAMES);
  await assert.rejects(failing.listTasks(), (error: Error) => /401/.test(error.message) && !/KEY123|TOKEN456/.test(error.message));
});

test("a long note is split into several comments under the cap", async () => {
  const { backend, writes } = trello([trelloCard("a")]);
  await backend.addNote("a", "x\n".repeat(20_000));
  const posts = writes();
  assert.ok(posts.length >= 3);
  assert.ok(posts.every((post) => post.url.pathname === "/1/cards/long-a/actions/comments" && String(post.body?.["text"]).length < 16384));
});

test("notes come oldest first", async () => {
  const comment = (text: string, date: string) => ({ id: date, date, data: { text } });
  const { backend } = trello([trelloCard("a")], { comments: [comment("newer", "2026-01-02T00:00:00.000Z"), comment("older", "2026-01-01T00:00:00.000Z")] });
  const notes = await backend.readNotes("a");
  assert.deepEqual(notes.map((n) => n.text), ["older", "newer"]);
  assert.equal(notes[0]?.createdAt.toISOString(), "2026-01-01T00:00:00.000Z");
});

test("a new task lands at the bottom of its list with its labels resolved by name", async () => {
  const { backend, writes } = trello([]);
  const created = await backend.addTask({ title: "PR 1", input: "https://x/1", labels: ["review-pr"], status: "todo" });
  assert.equal(created.id, "new1");
  assert.deepEqual(writes()[0]?.body, { idList: "l-todo", name: "PR 1", desc: "https://x/1", idLabels: "lab-review", pos: "bottom" });
  await assert.rejects(backend.addTask({ title: "t", input: "", labels: ["nope"], status: "todo" }), /board has no label "nope" \(run: board setup\)/);
});

test("setup creates only what is missing", async () => {
  const { backend, writes } = trello([], { lists: [{ id: "l-todo", name: "Todo" }], labels: [{ id: "x", name: "review-pr" }] });
  assert.deepEqual(await backend.setup(["review-pr", "other"]), ["list Running", "list Needs me", "list Done", "label other"]);
  assert.equal(writes().length, 4);
});

test("setup works on an empty board and a dry run creates nothing", async () => {
  const empty = trello([], { lists: [], labels: [] });
  assert.deepEqual(await empty.backend.setup(["review-pr"], { dryRun: true }), ["list Todo", "list Running", "list Needs me", "list Done", "label review-pr"]);
  assert.deepEqual(empty.writes(), []);
  assert.equal((await empty.backend.setup(["review-pr"]))?.length, 5);
  assert.equal(empty.writes().length, 5);
});

test("the env file is refused unless owner-only, and must hold both keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-board-"));
  const file = join(dir, "env");
  writeFileSync(file, "TRELLO_API_KEY=k\nTRELLO_TOKEN='t'\n");
  chmodSync(file, 0o644);
  assert.throws(() => loadCredentials(file), /mode 600 or 400, is 644/);
  chmodSync(file, 0o600);
  assert.deepEqual(loadCredentials(file), { key: "k", token: "t" });
  writeFileSync(file, "TRELLO_API_KEY=k\n");
  assert.throws(() => loadCredentials(file), /needs TRELLO_API_KEY and TRELLO_TOKEN/);
  assert.throws(() => loadCredentials(join(dir, "missing")), /credentials file missing/);
});

test("env parsing ignores comments and strips quotes and export", () => {
  assert.deepEqual(parseEnv("# c\nexport A=1\nB=\"two\"\n\nC = 3\n"), { A: "1", B: "two", C: "3" });
});
