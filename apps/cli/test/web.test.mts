import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequest, callServer, parseWebConfig, WebError } from "../src/backends/web.mts";
import type { Fetch } from "../src/backends/web.mts";

const config = { url: "https://board.example", token: "TOKEN-123" };
const stdin = (text: string) => async () => text;

function fakeFetch(status: number, body: string, seen: { url: string; init: RequestInit }[] = []): Fetch {
  return async (url, init) => {
    seen.push({ url, init });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };
}

test("the config needs a URL, https away from localhost, and the token", () => {
  assert.deepEqual(parseWebConfig({ url: "https://board.example/" }, { AGENT_BOARD_TOKEN: "t" }), { url: "https://board.example", token: "t" });
  assert.equal(parseWebConfig({ url: "http://localhost:4000" }, { AGENT_BOARD_TOKEN: "t" }).url, "http://localhost:4000");
  assert.throws(() => parseWebConfig({ url: "http://board.example" }, { AGENT_BOARD_TOKEN: "t" }), /https/);
  assert.throws(() => parseWebConfig({ url: "https://board.example" }, {}), /AGENT_BOARD_TOKEN/);
  assert.throws(() => parseWebConfig({}, { AGENT_BOARD_TOKEN: "t" }), /url/);
});

test("requests are built from argv and stdin, and bad argv never reaches the server", async () => {
  assert.deepEqual(await buildRequest("list-tasks", ["--all"], stdin("")), { all: true });
  assert.deepEqual(await buildRequest("claim-task", ["abc", "--machine", "laptop"], stdin("")), { id: "abc", machine: "laptop" });
  assert.deepEqual(await buildRequest("add-note", ["abc", "--author", "system"], stdin("hi")), { id: "abc", author: "system", body: "hi" });
  assert.deepEqual(await buildRequest("update-task", ["abc"], stdin('{"next":"fresh"}')), { id: "abc", body: { next: "fresh" } });
  await assert.rejects(buildRequest("get-task", ["../x"], stdin("")), /usage/);
  await assert.rejects(buildRequest("claim-task", ["abc", "--machine", "a b"], stdin("")), /usage/);
  await assert.rejects(buildRequest("add-note", ["abc", "--author", "user"], stdin("hi")), /usage/);
  await assert.rejects(buildRequest("add-note", ["abc"], stdin("  ")), /empty/);
  await assert.rejects(buildRequest("ask", ["abc"], stdin("not json")), /not valid JSON/);
});

test("one POST per call with the bearer token; the result is unwrapped", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const result = await callServer(config, "get-task", { id: "abc" }, fakeFetch(200, '{"result":{"id":"abc"}}', seen));
  assert.deepEqual(result, { id: "abc" });
  assert.equal(seen[0]?.url, "https://board.example/api/machine/get-task");
  assert.equal(new Headers(seen[0]?.init.headers).get("authorization"), "Bearer TOKEN-123");
  assert.equal(seen[0]?.init.body, '{"id":"abc"}');
});

test("server errors carry the status and reason, never the token", async () => {
  await assert.rejects(callServer(config, "claim-task", { id: "abc" }, fakeFetch(409, '{"error":"task is not free"}')), (error: unknown) => error instanceof WebError && error.status === 409 && /task is not free/.test(error.message));
  await assert.rejects(callServer(config, "get-task", { id: "abc" }, fakeFetch(302, "<html>login</html>")), (error: unknown) => error instanceof WebError && /without JSON/.test(error.message) && !error.message.includes("TOKEN"));
  const down: Fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(callServer(config, "get-task", {}, down), /cannot reach https:\/\/board.example: ECONNREFUSED/);
});
