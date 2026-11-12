import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrelloClient } from "../src/trello.mts";

const credentials = { key: "KEY123", token: "TOKEN456" };

test("credentials go in the Authorization header and never in the URL", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json([{ id: "1", name: "Todo" }]);
  };
  const client = createTrelloClient({ credentials, boardId: "b", dryRun: false, print: () => undefined, fetchFn });
  await client.getLists();
  assert.equal(seen[0]?.headers.get("authorization"), 'OAuth oauth_consumer_key="KEY123", oauth_token="TOKEN456"');
  assert.doesNotMatch(seen[0]?.url ?? "", /KEY123|TOKEN456/);
});

test("dry run sends no write and prints it", async () => {
  const printed: string[] = [];
  const fetchFn: typeof fetch = async () => assert.fail("no request expected");
  const client = createTrelloClient({ credentials, boardId: "b", dryRun: true, print: (l) => printed.push(l), fetchFn });
  await client.addComment("c1", "hello");
  await client.moveCard("c1", "l1");
  assert.equal(printed.length, 2);
  assert.match(printed[0] ?? "", /^DRY POST \/cards\/c1\/actions\/comments/);
});

test("errors carry the status but not the credentials", async () => {
  const fetchFn: typeof fetch = async () => new Response("invalid token", { status: 401 });
  const client = createTrelloClient({ credentials, boardId: "b", dryRun: false, print: () => undefined, fetchFn });
  await assert.rejects(client.getLists(), (error: Error) => /401/.test(error.message) && !/KEY123|TOKEN456/.test(error.message));
});

test("a long comment is split into several posts", async () => {
  const bodies: string[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    return Response.json({});
  };
  const client = createTrelloClient({ credentials, boardId: "b", dryRun: false, print: () => undefined, fetchFn });
  await client.addComment("c1", "x\n".repeat(20_000));
  assert.ok(bodies.length >= 3);
  assert.ok(bodies.every((b) => String(JSON.parse(b).text).length < 16384));
});
