import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildInvocation,
  decideOutcome,
  decideStale,
  expandRule,
  formatInput,
  freeSlots,
  notServableHere,
  parseInput,
  planRun,
  parsePrUrl,
  resolveLabel,
  START_MARKER,
  startedAt,
  usesPluginPlaceholder,
} from "../src/decide.mts";
import { tail } from "../src/text.mts";
import { CONFIG, NO_SANDBOX_EXTRAS, note as makeNote, task } from "./helpers.mts";

const FRESH = { kind: "fresh", sessionId: "s1" } as const;

test("free slots never go below zero", () => {
  assert.equal(freeSlots(0, 2), 2);
  assert.equal(freeSlots(1, 2), 1);
  assert.equal(freeSlots(2, 2), 0);
  assert.equal(freeSlots(3, 2), 0);
});

test("a known label resolves, the first known label wins", () => {
  const resolved = resolveLabel(task({ id: "a", labels: ["other", "selftest"] }), CONFIG.labels);
  assert.equal(resolved.known && resolved.label, "selftest");
});

test("an unknown or missing label explains itself", () => {
  const unknown = resolveLabel(task({ id: "a", labels: ["nope"] }), CONFIG.labels);
  assert.equal(unknown.known, false);
  assert.match(unknown.known ? "" : unknown.reason, /nope.*Known labels: selftest, review-pr/);
  const none = resolveLabel(task({ id: "a" }), CONFIG.labels);
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

test("stale: active unit without a start note is left alone", () => {
  assert.equal(decideStale({ unitActive: true, startedAt: undefined, now: new Date(), timeoutMinutes: 45 }).stale, false);
});

test("the start time is the latest start note", () => {
  const note = (text: string, iso: string) => makeNote(text, new Date(iso), { author: "system" });
  const found = startedAt([
    note(`${START_MARKER} old`, "2026-01-01T10:00:00Z"),
    note("unrelated", "2026-01-01T12:00:00Z"),
    note(`${START_MARKER} new`, "2026-01-01T11:00:00Z"),
  ]);
  assert.equal(found?.toISOString(), "2026-01-01T11:00:00.000Z");
  assert.equal(startedAt([]), undefined);
});

test("outcomes: timeout and non-zero exit fail, exit 0 in Running is unreported", () => {
  const base = { signal: null, timeoutMinutes: 45, reported: false };
  assert.equal(decideOutcome({ ...base, exitCode: null, timedOut: true }).kind, "failed");
  assert.equal(decideOutcome({ ...base, exitCode: 1, timedOut: false }).kind, "failed");
  assert.equal(decideOutcome({ ...base, exitCode: 0, timedOut: false }).kind, "unreported");
  assert.equal(decideOutcome({ ...base, exitCode: 0, timedOut: false, reported: true }).kind, "ok");
});

test("input round trip and PR URL parsing", () => {
  const url = "https://github.com/cosuno/cosuno/pull/17711";
  assert.deepEqual(parseInput(formatInput(url, "79ad544abc")), { input: url, head: "79ad544abc" });
  assert.deepEqual(parseInput(url), { input: url, head: undefined });
  assert.deepEqual(parsePrUrl(url), { repo: "cosuno/cosuno", number: 17711 });
  assert.equal(parsePrUrl("https://example.com/x"), undefined);
});

test("skill invocation: prompt first, repo cwd, tools expanded, no skip flags", () => {
  const entry = CONFIG.labels["review-pr"];
  assert.ok(entry);
  const plan = buildInvocation({
    run: FRESH,
    entry,
    task: task({ id: "abc", input: "https://github.com/cosuno/cosuno/pull/1" }),
    repos: CONFIG.repos,
    home: "/home/u",
    fallbackCwd: "/",
    prReviewPath: undefined,
    listDir: () => [],
  });
  assert.ok(plan.ok);
  assert.equal(plan.invocation.cwd, "/work/cosuno");
  assert.deepEqual(plan.invocation.args.slice(0, 6), ["-p", "/board-review-pr abc https://github.com/cosuno/cosuno/pull/1", "--session-id", "s1", "--permission-mode", "dontAsk"]);
  assert.equal(plan.invocation.args.some((arg) => arg.includes("dangerously") || arg === "auto" || arg === "bypassPermissions"), false);
});

test("skill invocation refuses an unmapped repo and a non-PR input", () => {
  const entry = CONFIG.labels["review-pr"];
  assert.ok(entry);
  const run = (input: string) => buildInvocation({ run: FRESH, entry, task: task({ id: "a", input }), repos: CONFIG.repos, home: "/h", fallbackCwd: "/", prReviewPath: undefined, listDir: () => [] });
  const unmapped = run("https://github.com/other/repo/pull/2");
  assert.ok(!unmapped.ok);
  assert.match(unmapped.reason, /other\/repo/);
  assert.ok(!run("not a url").ok);
});

test("command invocation runs the plain command", () => {
  const entry = CONFIG.labels["selftest"];
  assert.ok(entry);
  const plan = buildInvocation({ run: FRESH, entry, task: task({ id: "a" }), repos: {}, home: "/h", fallbackCwd: "/fallback", prReviewPath: undefined, listDir: () => [] });
  assert.ok(plan.ok);
  assert.deepEqual(plan.invocation, { command: "sleep", args: ["300"], cwd: "/fallback", maskedEnv: [] });
});

test("long text is tailed", () => {
  assert.equal(tail("abcdef", 4), "…def");
});

test("the skill run loads user settings only, so a checkout's own allow rules never apply", () => {
  const entry = CONFIG.labels["review-pr"];
  assert.ok(entry);
  const plan = buildInvocation({
    run: FRESH,
    entry,
    task: task({ id: "abc", input: "https://github.com/cosuno/cosuno/pull/1" }),
    repos: CONFIG.repos,
    home: "/home/u",
    fallbackCwd: "/",
    prReviewPath: undefined,
    listDir: () => [],
  });
  assert.ok(plan.ok);
  const { args } = plan.invocation;
  const at = args.indexOf("--setting-sources");
  assert.equal(args[at + 1], "user");
  assert.ok(at !== -1 && at < args.indexOf("--allowedTools"), "flag must come before the variadic tool lists");
});

test("{pr-review} expands to the plugin path in Bash rules; ~/ only in Bash rules", () => {
  assert.equal(expandRule("Bash({pr-review}/skills/x.sh *)", "/h", "/plugins/pr"), "Bash(/plugins/pr/skills/x.sh *)");
  assert.equal(expandRule("Bash(~/bin/tool *)", "/h", undefined), "Bash(/h/bin/tool *)");
  assert.equal(expandRule("Read(~/.config/**)", "/h", "/p"), "Read(~/.config/**)");
});

test("a rule with {pr-review} fails the plan when the plugin path is unknown", () => {
  const entry = { kind: "skill" as const, skill: "s", allowedTools: ["Bash({pr-review}/skills/x.sh *)"], disallowedTools: [], sandbox: NO_SANDBOX_EXTRAS, cwd: "/tmp" };
  const input = { entry, task: task({ id: "a", input: "x" }), repos: {}, home: "/h", fallbackCwd: "/", listDir: () => [] };
  const missing = buildInvocation({ run: FRESH, ...input, prReviewPath: undefined, listDir: () => [] });
  assert.ok(!missing.ok);
  assert.match(missing.reason, /pr-review plugin path/);
  const found = buildInvocation({ run: FRESH, ...input, prReviewPath: "/plugins/pr" });
  assert.ok(found.ok);
  assert.ok(found.invocation.args.includes("Bash(/plugins/pr/skills/x.sh *)"));
});

test("a label named like an Object.prototype member is unknown", () => {
  const resolved = resolveLabel(task({ id: "a", labels: ["toString"] }), CONFIG.labels);
  assert.equal(resolved.known, false);
});

test("the skill run gets the sandbox as inline settings, before the variadic tool lists", () => {
  const entry = CONFIG.labels["review-pr"];
  assert.ok(entry?.kind === "skill");
  const sandboxed = { ...entry, sandbox: { ...NO_SANDBOX_EXTRAS, maskedEnv: [{ name: "GH_TOKEN", command: ["gh", "auth", "token"], injectHosts: ["api.github.com"] }] } };
  const plan = buildInvocation({
    run: FRESH,
    entry: sandboxed,
    task: task({ id: "abc", input: "https://github.com/cosuno/cosuno/pull/1" }),
    repos: CONFIG.repos,
    home: "/home/u",
    fallbackCwd: "/",
    prReviewPath: undefined,
    listDir: (dir) => (dir === "/work/cosuno" ? [".git", "api"] : []),
  });
  assert.ok(plan.ok);
  const { args } = plan.invocation;
  const at = args.indexOf("--settings");
  assert.ok(at !== -1 && at < args.indexOf("--allowedTools"));
  const settings: unknown = JSON.parse(args[at + 1] ?? "");
  assert.match(JSON.stringify(settings), /"enabled":true.*"failIfUnavailable":true.*"denyWrite":\["\/work\/cosuno\/api"\]/);
  assert.deepEqual(plan.invocation.maskedEnv.map((env) => env.name), ["GH_TOKEN"]);
  assert.ok(!args.some((arg) => arg.includes("ghp_")));
});

test("a skill label without a sandbox entry is never started", () => {
  const entry = CONFIG.labels["review-pr"];
  assert.ok(entry?.kind === "skill");
  const plan = buildInvocation({
    run: FRESH,
    entry: { ...entry, sandbox: undefined },
    task: task({ id: "abc", input: "https://github.com/cosuno/cosuno/pull/1" }),
    repos: CONFIG.repos,
    home: "/home/u",
    fallbackCwd: "/",
    prReviewPath: undefined,
    listDir: () => [],
  });
  assert.ok(!plan.ok);
  assert.match(plan.reason, /no "sandbox" entry/);
});

test("{pr-review} in the sandbox entry also needs the plugin path", () => {
  const entry = { kind: "skill" as const, skill: "s", allowedTools: ["Read"], disallowedTools: [], sandbox: { ...NO_SANDBOX_EXTRAS, allowRead: ["{pr-review}"] }, cwd: "/tmp" };
  assert.equal(usesPluginPlaceholder(entry), true);
  const plan = buildInvocation({ run: FRESH, entry, task: task({ id: "a", input: "x" }), repos: {}, home: "/h", fallbackCwd: "/", prReviewPath: undefined, listDir: () => [] });
  assert.ok(!plan.ok);
});

const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 13, 10, minute));
const questionNote = makeNote("", at(1), {
  kind: "question",
  questions: [{ header: "Scope", question: "Review the migration?", multiSelect: false, options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }],
});

test("a resume carries the answers and comments given since the agent last spoke", () => {
  const notes = [
    makeNote("earlier user note", at(0), { author: "user" }),
    questionNote,
    makeNote("agent-board: started", at(2), { author: "system" }),
    makeNote("also check the seed", at(3), { author: "user", kind: "answer", questionNoteId: questionNote.id, answers: [{ selected: ["Yes"] }] }),
    makeNote("and keep it short", at(4), { author: "user" }),
  ];
  const plan = planRun(task({ id: "abc", next: "resume", sessionId: "s-old" }), notes, () => "s-new");
  assert.equal(plan.kind, "resume");
  assert.ok(plan.kind === "resume");
  assert.equal(plan.sessionId, "s-old");
  assert.match(plan.prompt, /Scope: Review the migration\? → Yes/);
  assert.match(plan.prompt, /also check the seed/);
  assert.match(plan.prompt, /and keep it short/);
  assert.doesNotMatch(plan.prompt, /earlier user note/);
  assert.match(plan.prompt, /board ask abc/);
});

test("a run starts fresh without a resume request, without a session, or without a reply", () => {
  const reply = [questionNote, makeNote("go on", at(2), { author: "user" })];
  assert.deepEqual(planRun(task({ id: "a", next: "fresh", sessionId: "s" }), reply, () => "n"), { kind: "fresh", sessionId: "n" });
  assert.deepEqual(planRun(task({ id: "a", next: "resume", sessionId: null }), reply, () => "n"), { kind: "fresh", sessionId: "n" });
  assert.deepEqual(planRun(task({ id: "a", next: "resume", sessionId: "s" }), [questionNote], () => "n"), { kind: "fresh", sessionId: "n" });
});

test("a resumed skill run passes the reply as the prompt and resumes the session", () => {
  const entry = CONFIG.labels["review-pr"];
  assert.ok(entry);
  const plan = buildInvocation({
    run: { kind: "resume", sessionId: "s-old", prompt: "the reply" },
    entry,
    task: task({ id: "abc", input: "https://github.com/cosuno/cosuno/pull/1" }),
    repos: CONFIG.repos,
    home: "/h",
    fallbackCwd: "/",
    prReviewPath: undefined,
    listDir: () => [],
  });
  assert.ok(plan.ok);
  assert.deepEqual(plan.invocation.args.slice(0, 4), ["-p", "the reply", "--resume", "s-old"]);
});

test("a skill outside a PR checkout gets only its task id", () => {
  const entry = { kind: "skill" as const, skill: "board-research", allowedTools: ["Read"], disallowedTools: [], sandbox: NO_SANDBOX_EXTRAS, cwd: "/work/notes" };
  const plan = buildInvocation({ run: FRESH, entry, task: task({ id: "abc", input: "Find out X" }), repos: {}, home: "/h", fallbackCwd: "/", prReviewPath: undefined, listDir: () => [] });
  assert.ok(plan.ok);
  assert.equal(plan.invocation.args[1], "/board-research abc");
  assert.equal(plan.invocation.cwd, "/work/notes");
});

test("a machine leaves a task to another when it lacks the label, the checkout or the session", () => {
  const pr = "https://github.com/cosuno/cosuno/pull/1";
  const here = (overrides: Parameters<typeof task>[0]) => notServableHere(task(overrides), "here", CONFIG.labels, CONFIG.repos);
  assert.equal(here({ id: "a", labels: ["review-pr"], input: pr }), undefined);
  assert.match(here({ id: "a", labels: ["research"] }) ?? "", /no worker/);
  assert.match(here({ id: "a", labels: ["review-pr"], input: "https://github.com/other/repo/pull/2" }) ?? "", /no checkout of other\/repo/);
  assert.match(here({ id: "a", labels: ["review-pr"], input: pr, next: "resume", sessionId: "s", machine: "there" }) ?? "", /pinned to there/);
  assert.equal(here({ id: "a", labels: ["review-pr"], input: pr, next: "resume", sessionId: "s", machine: "here" }), undefined);
  // Not a PR URL: claimed here, and the worker reports why it cannot run.
  assert.equal(here({ id: "a", labels: ["review-pr"], input: "not a url" }), undefined);
});
