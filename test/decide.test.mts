import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildInvocation,
  byPriority,
  decideOutcome,
  decideStale,
  formatDesc,
  freeSlots,
  parseDesc,
  parsePrUrl,
  resolveLabel,
  START_MARKER,
  startedAt,
} from "../src/decide.mts";
import { splitText, tail } from "../src/text.mts";
import { card, CONFIG } from "./helpers.mts";

test("free slots never go below zero", () => {
  assert.equal(freeSlots(0, 2), 2);
  assert.equal(freeSlots(1, 2), 1);
  assert.equal(freeSlots(2, 2), 0);
  assert.equal(freeSlots(3, 2), 0);
});

test("the top of Todo is the lowest position", () => {
  const ordered = byPriority([card({ shortLink: "b", pos: 20 }), card({ shortLink: "a", pos: 5 }), card({ shortLink: "c", pos: 7 })]);
  assert.deepEqual(ordered.map((c) => c.shortLink), ["a", "c", "b"]);
});

test("a known label resolves, the first known label wins", () => {
  const resolved = resolveLabel(card({ shortLink: "a", labels: [{ id: "1", name: "other" }, { id: "2", name: "selftest" }] }), CONFIG.labels);
  assert.equal(resolved.known && resolved.label, "selftest");
});

test("an unknown or missing label explains itself", () => {
  const unknown = resolveLabel(card({ shortLink: "a", labels: [{ id: "1", name: "nope" }] }), CONFIG.labels);
  assert.equal(unknown.known, false);
  assert.match(unknown.known ? "" : unknown.reason, /nope.*Known labels: selftest, review-pr/);
  const none = resolveLabel(card({ shortLink: "a" }), CONFIG.labels);
  assert.match(none.known ? "" : none.reason, /no label/);
});

test("stale: unit gone is stale at once", () => {
  const decision = decideStale({ unitActive: false, startedAt: new Date(), now: new Date(), timeoutMinutes: 45 });
  assert.deepEqual(decision.stale && decision.stopUnit, false);
  assert.equal(decision.stale, true);
});

test("stale: active unit is kept until past the timeout plus grace, then stopped", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  assert.equal(decideStale({ unitActive: true, startedAt: at(46), now, timeoutMinutes: 45 }).stale, false);
  const decision = decideStale({ unitActive: true, startedAt: at(51), now, timeoutMinutes: 45 });
  assert.equal(decision.stale && decision.stopUnit, true);
});

test("stale: active unit without a start comment is left alone", () => {
  assert.equal(decideStale({ unitActive: true, startedAt: undefined, now: new Date(), timeoutMinutes: 45 }).stale, false);
});

test("the start time is the latest start comment", () => {
  const comment = (text: string, iso: string) => ({ id: iso, text, date: new Date(iso) });
  const found = startedAt([
    comment(`${START_MARKER} old`, "2026-01-01T10:00:00Z"),
    comment("unrelated", "2026-01-01T12:00:00Z"),
    comment(`${START_MARKER} new`, "2026-01-01T11:00:00Z"),
  ]);
  assert.equal(found?.toISOString(), "2026-01-01T11:00:00.000Z");
  assert.equal(startedAt([]), undefined);
});

test("outcomes: timeout and non-zero exit fail, exit 0 in Running is unreported", () => {
  const base = { signal: null, timeoutMinutes: 45, stillRunning: true };
  assert.equal(decideOutcome({ ...base, exitCode: null, timedOut: true }).kind, "failed");
  assert.equal(decideOutcome({ ...base, exitCode: 1, timedOut: false }).kind, "failed");
  assert.equal(decideOutcome({ ...base, exitCode: 0, timedOut: false }).kind, "unreported");
  assert.equal(decideOutcome({ ...base, exitCode: 0, timedOut: false, stillRunning: false }).kind, "ok");
});

test("description round trip and PR URL parsing", () => {
  const url = "https://github.com/cosuno/cosuno/pull/17711";
  assert.deepEqual(parseDesc(formatDesc(url, "79ad544abc")), { input: url, head: "79ad544abc" });
  assert.deepEqual(parseDesc(url), { input: url, head: undefined });
  assert.deepEqual(parsePrUrl(url), { repo: "cosuno/cosuno", number: 17711 });
  assert.equal(parsePrUrl("https://example.com/x"), undefined);
});

test("skill invocation: prompt first, repo cwd, tools expanded, no skip flags", () => {
  const entry = CONFIG.labels["review-pr"];
  assert.ok(entry);
  const plan = buildInvocation({
    entry,
    card: card({ shortLink: "abc", desc: "https://github.com/cosuno/cosuno/pull/1" }),
    repos: CONFIG.repos,
    home: "/home/u",
    fallbackCwd: "/",
  });
  assert.ok(plan.ok);
  assert.equal(plan.invocation.cwd, "/work/cosuno");
  assert.deepEqual(plan.invocation.args.slice(0, 5), ["-p", "/board-review-pr abc https://github.com/cosuno/cosuno/pull/1", "--permission-mode", "dontAsk", "--allowedTools"]);
  assert.equal(plan.invocation.args.some((arg) => arg.includes("dangerously") || arg === "auto" || arg === "bypassPermissions"), false);
});

test("skill invocation refuses an unmapped repo and a non-PR input", () => {
  const entry = CONFIG.labels["review-pr"];
  assert.ok(entry);
  const run = (desc: string) => buildInvocation({ entry, card: card({ shortLink: "a", desc }), repos: CONFIG.repos, home: "/h", fallbackCwd: "/" });
  const unmapped = run("https://github.com/other/repo/pull/2");
  assert.ok(!unmapped.ok);
  assert.match(unmapped.reason, /other\/repo/);
  assert.ok(!run("not a url").ok);
});

test("command invocation runs the plain command", () => {
  const entry = CONFIG.labels["selftest"];
  assert.ok(entry);
  const plan = buildInvocation({ entry, card: card({ shortLink: "a" }), repos: {}, home: "/h", fallbackCwd: "/fallback" });
  assert.ok(plan.ok);
  assert.deepEqual(plan.invocation, { command: "sleep", args: ["300"], cwd: "/fallback" });
});

test("long text is tailed and split within the comment limit", () => {
  assert.equal(tail("abcdef", 4), "…def");
  const pieces = splitText("line\n".repeat(100), 120);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((piece) => piece.length <= 120));
  assert.deepEqual(splitText("short", 120), ["short"]);
});
