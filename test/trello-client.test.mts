import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrelloClient, splitText } from "../src/backends/trello-client.mts";

const credentials = { key: "KEY123", token: "TOKEN456" };

test("credentials go in the Authorization header and never in the URL", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json([{ id: "1", name: "Todo" }]);
  };
  const client = createTrelloClient({ credentials, boardId: "b", fetchFn });
  await client.getLists();
  assert.equal(seen[0]?.headers.get("authorization"), 'OAuth oauth_consumer_key="KEY123", oauth_token="TOKEN456"');
  assert.doesNotMatch(seen[0]?.url ?? "", /KEY123|TOKEN456/);
});

test("errors carry the status but not the credentials", async () => {
  const fetchFn: typeof fetch = async () => new Response("invalid token", { status: 401 });
  const client = createTrelloClient({ credentials, boardId: "b", fetchFn });
  await assert.rejects(client.getLists(), (error: Error) => /401/.test(error.message) && !/KEY123|TOKEN456/.test(error.message));
});

test("a long comment is split into several posts", async () => {
  const bodies: string[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    return Response.json({});
  };
  const client = createTrelloClient({ credentials, boardId: "b", fetchFn });
  await client.addComment("c1", "x\n".repeat(20_000));
  assert.ok(bodies.length >= 3);
  assert.ok(bodies.every((b) => String(JSON.parse(b).text).length < 16384));
});

test("long text is split within the comment limit", () => {
  const pieces = splitText("line\n".repeat(100), 120);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((piece) => piece.length <= 120));
  assert.deepEqual(splitText("short", 120), ["short"]);
});
