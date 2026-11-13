import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildInvocation,
  decideOutcome,
  decideStale,
  expandRule,
  formatInput,
  planPauses,
  planStarts,
  supervise,
  notServableHere,
  parseInput,
  planRun,
  parsePrUrl,
  resolveLabel,
  START_MARKER,
  startedAt,
  PAUSE_MARKER,
} from "../src/decide.mts";
import type { LaneRun } from "../src/decide.mts";
import { tail } from "../src/text.mts";
import { CONFIG, note as makeNote, task } from "./helpers.mts";

const FRESH = { kind: "fresh", sessionId: "s1" } as const;

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
  });
  assert.ok(plan.ok);
  assert.equal(plan.invocation.cwd, "/work/cosuno");
  assert.deepEqual(plan.invocation.args.slice(0, 6), ["-p", "/board-review-pr abc https://github.com/cosuno/cosuno/pull/1", "--session-id", "s1", "--permission-mode", "dontAsk"]);
  assert.equal(plan.invocation.args.some((arg) => arg.includes("dangerously") || arg === "auto" || arg === "bypassPermissions"), false);
});

test("skill invocation refuses an unmapped repo and a non-PR input", () => {
  const entry = CONFIG.labels["review-pr"];
  assert.ok(entry);
  const run = (input: string) => buildInvocation({ run: FRESH, entry, task: task({ id: "a", input }), repos: CONFIG.repos, home: "/h", fallbackCwd: "/", prReviewPath: undefined });
  const unmapped = run("https://github.com/other/repo/pull/2");
  assert.ok(!unmapped.ok);
  assert.match(unmapped.reason, /other\/repo/);
  assert.ok(!run("not a url").ok);
});

test("command invocation runs the plain command", () => {
  const entry = CONFIG.labels["selftest"];
  assert.ok(entry);
  const plan = buildInvocation({ run: FRESH, entry, task: task({ id: "a" }), repos: {}, home: "/h", fallbackCwd: "/fallback", prReviewPath: undefined });
  assert.ok(plan.ok);
  assert.deepEqual(plan.invocation, { command: "sleep", args: ["300"], cwd: "/fallback" });
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
  const entry = { kind: "skill" as const, skill: "s", allowedTools: ["Bash({pr-review}/skills/x.sh *)"], disallowedTools: [], cwd: "/tmp" };
  const input = { entry, task: task({ id: "a", input: "x" }), repos: {}, home: "/h", fallbackCwd: "/" };
  const missing = buildInvocation({ run: FRESH, ...input, prReviewPath: undefined });
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
  });
  assert.ok(plan.ok);
  assert.deepEqual(plan.invocation.args.slice(0, 4), ["-p", "the reply", "--resume", "s-old"]);
});

test("a skill outside a PR checkout gets only its task id", () => {
  const entry = { kind: "skill" as const, skill: "board-research", allowedTools: ["Read"], disallowedTools: [], cwd: "/work/notes" };
  const plan = buildInvocation({ run: FRESH, entry, task: task({ id: "abc", input: "Find out X" }), repos: {}, home: "/h", fallbackCwd: "/", prReviewPath: undefined });
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

const NOW = new Date("2026-01-01T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const LIMITS = { inactivityMinutes: 15, maxRunHours: 6 };

test("stale: a gone unit at once; an active one only past the limits plus grace", () => {
  const gone = decideStale({ unitActive: false, startedAt: NOW, lastActive: undefined, now: NOW, limits: LIMITS });
  assert.equal(gone.stale && !gone.stopUnit, true);
  assert.equal(decideStale({ unitActive: true, startedAt: ago(300), lastActive: ago(19), now: NOW, limits: LIMITS }).stale, false);
  const quiet = decideStale({ unitActive: true, startedAt: ago(300), lastActive: ago(21), now: NOW, limits: LIMITS });
  assert.equal(quiet.stale && quiet.stopUnit, true);
  assert.equal(decideStale({ unitActive: true, startedAt: ago(6 * 60 + 6), lastActive: ago(0), now: NOW, limits: LIMITS }).stale, true);
  assert.equal(decideStale({ unitActive: true, startedAt: undefined, lastActive: undefined, now: NOW, limits: LIMITS }).stale, false);
});

test("supervision: inactivity, the ceiling and an ignored pause stop a run; activity keeps it going", () => {
  const run = { now: NOW, limits: LIMITS, pauseGraceMinutes: 5, pauseRequestedAt: undefined };
  assert.equal(supervise({ ...run, startedAt: ago(120), lastActive: ago(1) }).kind, "continue");
  assert.equal(supervise({ ...run, startedAt: ago(10), lastActive: undefined }).kind, "continue");
  const inactive = supervise({ ...run, startedAt: ago(120), lastActive: ago(16) });
  assert.ok(inactive.kind === "stop" && inactive.why === "inactive");
  const quietFromStart = supervise({ ...run, startedAt: ago(16), lastActive: undefined });
  assert.ok(quietFromStart.kind === "stop" && quietFromStart.why === "inactive");
  const ceiling = supervise({ ...run, startedAt: ago(6 * 60 + 1), lastActive: ago(0) });
  assert.ok(ceiling.kind === "stop" && ceiling.why === "ceiling");
  assert.equal(supervise({ ...run, startedAt: ago(30), lastActive: ago(0), pauseRequestedAt: ago(4) }).kind, "continue");
  const forced = supervise({ ...run, startedAt: ago(30), lastActive: ago(0), pauseRequestedAt: ago(6) });
  assert.ok(forced.kind === "stop" && forced.why === "pause-forced");
});

test("outcomes: a pause wins over the stop it caused, a report wins over a pause", () => {
  const base = { signal: null, stopped: undefined, pauseRequested: false, reported: false };
  const forced = { kind: "stop" as const, why: "pause-forced" as const, message: "forced" };
  const inactive = { kind: "stop" as const, why: "inactive" as const, message: "Stopped: no tool call" };
  assert.equal(decideOutcome({ ...base, exitCode: 1 }).kind, "failed");
  assert.equal(decideOutcome({ ...base, exitCode: 0 }).kind, "unreported");
  assert.equal(decideOutcome({ ...base, exitCode: 0, reported: true }).kind, "ok");
  assert.deepEqual(decideOutcome({ ...base, exitCode: null, signal: "SIGTERM", stopped: inactive }), { kind: "failed", reason: "Stopped: no tool call" });
  assert.equal(decideOutcome({ ...base, exitCode: 0, pauseRequested: true }).kind, "paused");
  assert.equal(decideOutcome({ ...base, exitCode: null, signal: "SIGTERM", stopped: forced, pauseRequested: true }).kind, "paused");
  assert.equal(decideOutcome({ ...base, exitCode: 0, pauseRequested: true, reported: true }).kind, "ok");
});

const LANES = [
  { name: "reviews", labels: ["review-pr"], slots: 2 },
  { name: "implement", labels: ["implement"], slots: 1 },
];
const lane = (t: { labels: string[] }) => LANES.find((l) => l.labels.includes(t.labels[0] ?? ""))?.name;
const run = (taskId: string, laneName: string, borrowed: boolean, minutesAgo: number, pauseRequested = false): LaneRun => ({ taskId, lane: laneName, borrowed, startedAt: ago(minutesAgo), pauseRequested });

test("lanes take their own work first, then idle lanes borrow in list order", () => {
  const candidates = [task({ id: "r1", labels: ["review-pr"] }), task({ id: "r2", labels: ["review-pr"] }), task({ id: "r3", labels: ["review-pr"] }), task({ id: "x", labels: ["other"] })];
  assert.deepEqual(planStarts({ lanes: LANES, running: [], candidates, ownLaneOf: lane }), [
    { taskId: "r1", lane: "reviews", borrowed: false },
    { taskId: "r2", lane: "reviews", borrowed: false },
    { taskId: "r3", lane: "implement", borrowed: true },
  ]);
  const withImplement = [...candidates, task({ id: "i1", labels: ["implement"] })];
  assert.deepEqual(
    planStarts({ lanes: LANES, running: [], candidates: withImplement, ownLaneOf: lane }).map((s) => `${s.taskId}:${s.lane}:${s.borrowed}`),
    ["r1:reviews:false", "r2:reviews:false", "i1:implement:false"],
  );
  assert.deepEqual(planStarts({ lanes: LANES, running: [run("a", "reviews", false, 1), run("b", "reviews", false, 1), run("c", "implement", true, 1)], candidates, ownLaneOf: lane }), []);
});

test("a full lane with its own work waiting pauses its newest borrowed run that ran long enough", () => {
  const plan = (running: LaneRun[], waiting: Record<string, number>) =>
    planPauses({ lanes: LANES, running, waitingOwn: new Map(Object.entries(waiting)), now: NOW, pauseAfterMinutes: 5 }).map((r) => r.taskId);
  assert.deepEqual(plan([run("old", "reviews", true, 40), run("new", "reviews", true, 10)], { reviews: 1 }), ["new"]);
  assert.deepEqual(plan([run("young", "reviews", true, 3), run("own", "reviews", false, 30)], { reviews: 1 }), [], "only after five minutes, never its own work");
  assert.deepEqual(plan([run("b", "reviews", true, 40), run("c", "reviews", true, 40)], {}), [], "nothing of its own waits");
  assert.deepEqual(plan([run("b", "reviews", true, 40)], { reviews: 1 }), [], "a free slot needs no pause");
  assert.deepEqual(plan([run("b", "reviews", true, 40, true), run("c", "reviews", true, 40)], { reviews: 2 }), [], "one pause at a time");
  assert.deepEqual(plan([run("b", "implement", true, 40)], { implement: 1 }), ["b"]);
});

test("a paused run resumes with a note that it was paused, and with any reply since", () => {
  const notes = [
    makeNote(`${START_MARKER} x`, at(1), { author: "system" }),
    makeNote("Halfway through the resolvers", at(2)),
    makeNote(`${PAUSE_MARKER} laptop: its reviews lane needed the slot`, at(3), { author: "system", kind: "event" }),
  ];
  const paused = planRun(task({ id: "p", next: "resume", sessionId: "s" }), notes, () => "n");
  assert.ok(paused.kind === "resume");
  assert.match(paused.prompt, /You were paused on board task p/);
  const replied = planRun(task({ id: "p", next: "resume", sessionId: "s" }), [...notes, makeNote("also do X", at(4), { author: "user" })], () => "n");
  assert.ok(replied.kind === "resume" && /You were paused/.test(replied.prompt) && /also do X/.test(replied.prompt));
  // The dispatcher's start note for the resumed run may already be there when the worker reads the thread.
  const restarting = [...notes, makeNote(`${START_MARKER} y`, at(5), { author: "system" })];
  assert.equal(planRun(task({ id: "p", next: "resume", sessionId: "s" }), restarting, () => "n").kind, "resume");
  const spokenSince = [...restarting, makeNote("step 4 done", at(6))];
  assert.equal(planRun(task({ id: "p", next: "resume", sessionId: "s" }), spokenSince, () => "n").kind, "fresh", "a pause the agent has spoken after is history");
});

test("a skill run gets the hook in its settings; a command label does not", () => {
  const entry = CONFIG.labels["review-pr"];
  assert.ok(entry);
  const plan = buildInvocation({ run: FRESH, hookCommand: "'/x/agent-hook' '/run/ab' abc", entry, task: task({ id: "abc", input: "https://github.com/cosuno/cosuno/pull/1" }), repos: CONFIG.repos, home: "/h", fallbackCwd: "/", prReviewPath: undefined });
  assert.ok(plan.ok);
  const settings = JSON.parse(plan.invocation.args[plan.invocation.args.indexOf("--settings") + 1] ?? "{}");
  assert.deepEqual(settings.hooks, { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "'/x/agent-hook' '/run/ab' abc" }] }] });
  assert.equal(settings.sandbox, undefined, "no sandbox any more");
});
