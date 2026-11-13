import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boardRules,
  buildInvocation,
  ownLane,
  parseHead,
  prUrlIn,
  runPrompt,
  decideOutcome,
  decideStale,
  expandRule,
  pluginPlaceholders,
  planPauses,
  planStarts,
  supervise,
  notServableHere,
  planRun,
  START_MARKER,
  startedAt,
  PAUSE_MARKER,
} from "../src/decide.mts";
import type { LaneRun } from "../src/decide.mts";
import { tail } from "../src/text.mts";
import { CONFIG, note as makeNote, task } from "./helpers.mts";

const FRESH = { kind: "fresh", sessionId: "s1" } as const;
const PR = "https://github.com/cosuno/cosuno/pull/17741";
const invoke = (overrides: Parameters<typeof task>[0], run: Parameters<typeof buildInvocation>[0]["run"] = FRESH, laneCwd?: string) =>
  buildInvocation({ run, task: task(overrides), repos: CONFIG.repos, defaultCwd: CONFIG.defaultCwd, intake: CONFIG.intake, laneCwd, home: "/h", pluginRoots: { "pr-review": "/plugins/pr" }, hookCommand: "'/x/agent-hook' '/run/ab' abc" });

test("a scheduled task runs its prompt as written, in its directory, as the user in auto mode", () => {
  const plan = invoke({ id: "abc", input: "/review-pr 17741 --fresh", machine: "here", workdir: "/work/cosuno" });
  assert.ok(plan.ok);
  const { args, cwd } = plan.invocation;
  assert.deepEqual(args.slice(0, 4), ["-p", "/review-pr 17741 --fresh", "--session-id", "s1"]);
  assert.equal(cwd, "/work/cosuno");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
  assert.ok(!args.includes("--setting-sources"), "all of the user's settings load");
  assert.ok(!args.includes("--allowedTools"));
  assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 3), ["--output-format", "stream-json", "--verbose"]);
  assert.match(args[args.indexOf("--append-system-prompt") + 1] ?? "", /agent-board task abc/);
  const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");
  assert.deepEqual(settings, { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "'/x/agent-hook' '/run/ab' abc" }] }] } });
});

test("a task without a directory runs in the default one", () => {
  const plan = invoke({ id: "abc", input: "Find out why the export is slow" });
  assert.ok(plan.ok);
  assert.equal(plan.invocation.cwd, "/home/me");
  assert.ok(!invoke({ id: "abc", input: "  " }).ok, "an empty prompt is refused");
});

test("an intake review runs in the PR's checkout with intake's narrow rules, without its head line", () => {
  const plan = invoke({ id: "abc", input: `/review-pr ${PR} --auto\nhead: 56120dc60b`, createdBy: "intake", workdir: "/stale/dir" });
  assert.ok(plan.ok);
  const { args, cwd } = plan.invocation;
  assert.equal(args[1], `/review-pr ${PR} --auto`);
  assert.equal(cwd, "/work/cosuno", "a fresh intake run goes back to the checkout");
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 4), ["--permission-mode", "dontAsk", "--setting-sources", "user"]);
  assert.deepEqual(args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools")), ["Read", "Bash(board *)"]);
  const unmapped = invoke({ id: "abc", input: "/review-pr https://github.com/other/repo/pull/2 --auto", createdBy: "intake" });
  assert.ok(!unmapped.ok && /other\/repo/.test(unmapped.reason));
});

test("a resume passes the reply and continues where the session stopped", () => {
  const plan = invoke({ id: "abc", input: "/grill", workdir: "/repo/.claude/worktrees/x" }, { kind: "resume", sessionId: "s-old", prompt: "the reply" });
  assert.ok(plan.ok);
  assert.deepEqual(plan.invocation.args.slice(0, 4), ["-p", "the reply", "--resume", "s-old"]);
  assert.equal(plan.invocation.cwd, "/repo/.claude/worktrees/x");
});

test("intake rules naming a plugin need its path", () => {
  const plan = buildInvocation({ run: FRESH, task: task({ id: "a", input: PR, createdBy: "intake" }), repos: CONFIG.repos, defaultCwd: "/", intake: { ...CONFIG.intake, allowedTools: ["Bash({pr-review}/x.sh *)", "Bash({engineering}/y.sh *)"] }, home: "/h", pluginRoots: { "pr-review": "/p" } });
  assert.ok(!plan.ok && /plugin engineering is unknown/.test(plan.reason));
});

test("a task without a directory runs in the checkout of the PR its prompt names, else in its lane's directory", () => {
  const byPr = invoke({ id: "a", input: `/review-pr ${PR}` }, FRESH, "/lane/dir");
  assert.ok(byPr.ok && byPr.invocation.cwd === "/work/cosuno");
  const byLane = invoke({ id: "a", input: "/review-pr 17741" }, FRESH, "/lane/dir");
  assert.ok(byLane.ok && byLane.invocation.cwd === "/lane/dir");
  const pinned = invoke({ id: "a", input: `/review-pr ${PR}`, workdir: "/own/dir", machine: "here" }, FRESH, "/lane/dir");
  assert.ok(pinned.ok && pinned.invocation.cwd === "/own/dir", "a task's own directory wins");
});

test("a prompt's skill picks its lane; anything else goes to the lane with *", () => {
  const lanes = [
    { name: "reviews", skills: ["review-pr"], slots: 2 },
    { name: "general", skills: ["*"], slots: 3 },
  ];
  assert.equal(ownLane(task({ id: "a", input: "/review-pr 17741" }), lanes), "reviews");
  assert.equal(ownLane(task({ id: "a", input: "/pr-review:review-pr 17741" }), lanes), "reviews");
  assert.equal(ownLane(task({ id: "a", input: "/grill this plan" }), lanes), "general");
  assert.equal(ownLane(task({ id: "a", input: "Find out X" }), lanes), "general");
  assert.equal(ownLane(task({ id: "a", input: "Find out X" }), [lanes[0]!]), undefined);
});

test("a machine leaves a task to another when it is pinned there or lacks the PR's checkout", () => {
  const here = (overrides: Parameters<typeof task>[0]) => notServableHere(task(overrides), "here", CONFIG.repos);
  assert.equal(here({ id: "a", input: "Find out X" }), undefined);
  assert.match(here({ id: "a", input: "/grill", machine: "there", workdir: "/x" }) ?? "", /pinned to there/);
  assert.equal(here({ id: "a", input: "/grill", machine: "here", workdir: "/x" }), undefined);
  assert.match(here({ id: "a", input: "/grill", next: "resume", sessionId: "s", machine: "there" }) ?? "", /pinned to there/);
  assert.equal(here({ id: "a", input: `/review-pr ${PR} --auto`, createdBy: "intake", machine: "there", workdir: "/w" }), undefined, "an intake task runs on any machine with the checkout");
  assert.match(here({ id: "a", input: "/review-pr https://github.com/other/repo/pull/2 --auto", createdBy: "intake" }) ?? "", /no checkout of other\/repo/);
});

test("intake's head line is kept on the task but not given to the agent", () => {
  const input = `/review-pr ${PR} --auto\nhead: 56120dc60b`;
  assert.equal(parseHead(input), "56120dc60b");
  assert.equal(runPrompt(input), `/review-pr ${PR} --auto`);
  assert.equal(prUrlIn(input), PR);
  assert.equal(prUrlIn("Find out X"), undefined);
  assert.match(boardRules(task({ id: "abc" })), /AskUserQuestion is not available.*board ask abc --file \/tmp\/pr-abc-questions\.json/s);
  assert.doesNotMatch(boardRules(task({ id: "abc" })), /stands alone/);
  assert.match(boardRules(task({ id: "abc", createdBy: "intake" })), /run every Bash command on its own, without pipes/);
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

test("long text is tailed", () => {
  assert.equal(tail("abcdef", 4), "…def");
});

test("{<plugin>} expands to the plugin's root in Bash rules; ~/ only in Bash rules", () => {
  const roots = { "pr-review": "/plugins/pr", engineering: "/plugins/eng" };
  assert.equal(expandRule("Bash({pr-review}/skills/x.sh *)", "/h", roots), "Bash(/plugins/pr/skills/x.sh *)");
  assert.equal(expandRule("Bash({engineering}/skills/circleci-reference/cci.sh *)", "/h", roots), "Bash(/plugins/eng/skills/circleci-reference/cci.sh *)");
  assert.equal(expandRule("Bash(~/bin/tool *)", "/h", {}), "Bash(/h/bin/tool *)");
  assert.equal(expandRule("Read(~/.config/**)", "/h", roots), "Read(~/.config/**)");
  assert.deepEqual(pluginPlaceholders(["Bash({pr-review}/a *)", "Bash({engineering}/b *)", "Bash({pr-review}/c *)", "Read(x)"]), ["pr-review", "engineering"]);
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
  assert.match(plan.prompt, /board's rules from the start of this session still hold/);
});

test("a run starts fresh without a resume request, without a session, or without a reply", () => {
  const reply = [questionNote, makeNote("go on", at(2), { author: "user" })];
  assert.deepEqual(planRun(task({ id: "a", next: "fresh", sessionId: "s" }), reply, () => "n"), { kind: "fresh", sessionId: "n" });
  assert.deepEqual(planRun(task({ id: "a", next: "resume", sessionId: null }), reply, () => "n"), { kind: "fresh", sessionId: "n" });
  assert.deepEqual(planRun(task({ id: "a", next: "resume", sessionId: "s" }), [questionNote], () => "n"), { kind: "fresh", sessionId: "n" });
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
  { name: "reviews", skills: ["review-pr"], slots: 2 },
  { name: "implement", skills: ["implement"], slots: 1 },
];
const lane = (t: { labels: string[] }) => LANES.find((l) => l.skills.includes(t.labels[0] ?? ""))?.name;
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

