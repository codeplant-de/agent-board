import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubError, parsePrView } from "../src/github.mts";
import { STATUSES } from "../src/contract.mts";
import type { Status } from "../src/contract.mts";
import type { LivePr } from "../src/github.mts";
import { planIntake, runIntake } from "../src/intake.mts";
import { CONFIG, fakeBackend, task } from "./helpers.mts";

const NOW = new Date("2026-01-01T12:00:00Z");
const url = (n: number) => `https://github.com/cosuno/cosuno/pull/${n}`;

function pr(n: number, overrides: Partial<LivePr> = {}): LivePr {
  return {
    url: url(n),
    title: `PR ${n}`,
    author: "dev",
    number: n,
    headSha: "bbbbbbb1",
    headCommittedAt: new Date(NOW.getTime() - 30 * 60_000),
    isDraft: false,
    ...overrides,
  };
}

const taskFor = (n: number, status: Status, head = "aaaaaaa1") => task({ id: `c${n}`, status, input: `${url(n)}\nhead: ${head}` });
const plan = (prs: LivePr[], tasks = [] as ReturnType<typeof task>[]) =>
  planIntake({ prs, tasks, repos: Object.keys(CONFIG.repos), now: NOW }).map((a) => a.kind === "skip" ? `skip:${a.reason}` : a.kind);

test("a new settled PR gets a task", () => {
  assert.deepEqual(plan([pr(1)]), ["create"]);
});

test("drafts, unmapped repos and unsettled heads are skipped", () => {
  const unmapped = pr(2, { url: "https://github.com/other/repo/pull/2" });
  const fresh = pr(3, { headCommittedAt: new Date(NOW.getTime() - 60_000) });
  assert.deepEqual(plan([pr(1, { isDraft: true }), unmapped, fresh]), ["skip:draft", "skip:repository not in config", "skip:head not settled"]);
});

test("a PR with a task in any status never gets a second task", () => {
  for (const status of STATUSES) assert.deepEqual(plan([pr(1, { headSha: "aaaaaaa1" })], [taskFor(1, status)]), ["skip:task exists"]);
});

test("a moved, settled head requeues a task from Needs me or Done only", () => {
  assert.deepEqual(plan([pr(1)], [taskFor(1, "needs-me")]), ["requeue"]);
  assert.deepEqual(plan([pr(1)], [taskFor(1, "done")]), ["requeue"]);
  assert.deepEqual(plan([pr(1)], [taskFor(1, "todo")]), ["skip:head moved, task is todo"]);
  assert.deepEqual(plan([pr(1)], [taskFor(1, "running")]), ["skip:head moved, task is running"]);
});

test("a failed task stays put while its head is unchanged, and is retried when the head moves", () => {
  assert.deepEqual(plan([pr(1, { headSha: "aaaaaaa1" })], [taskFor(1, "needs-me")]), ["skip:task exists"]);
  assert.deepEqual(plan([pr(1)], [taskFor(1, "needs-me")]), ["requeue"]);
});

test("a moved head that has not settled waits", () => {
  const fresh = pr(1, { headCommittedAt: new Date(NOW.getTime() - 60_000) });
  assert.deepEqual(plan([fresh], [taskFor(1, "needs-me")]), ["skip:head moved, not settled"]);
});

test("a hand-made task without a head line is left alone", () => {
  assert.deepEqual(plan([pr(1)], [task({ id: "h", status: "needs-me", input: url(1) })]), ["skip:task exists"]);
});

test("running intake twice creates the task once", async () => {
  const backend = fakeBackend([]);
  const logs: string[] = [];
  const deps = {
    backend,
    config: CONFIG,
    dryRun: false,
    print: (line: string) => logs.push(line),
    github: { listReviewRequested: async () => [pr(1)] },
    now: () => NOW,
  };
  await runIntake(deps);
  backend.tasks.push(task({ id: "new", input: `${url(1)}\nhead: bbbbbbb1` }));
  await runIntake(deps);
  assert.equal(backend.writes.filter((w) => w.startsWith("create")).length, 1);
  assert.ok(logs.includes("INTAKE prs=1 created=0 requeued=0"));
});

test("requeue moves the task, updates the head line and comments", async () => {
  const backend = fakeBackend([taskFor(1, "needs-me")]);
  await runIntake({ backend, config: CONFIG, dryRun: false, print: () => undefined, github: { listReviewRequested: async () => [pr(1)] }, now: () => NOW });
  assert.deepEqual(backend.writes.map((w) => w.split(":")[0]), ["status c1 -> todo", "input c1", "note c1"]);
});

test("a failed listing changes nothing and fails the run", async () => {
  const backend = fakeBackend([taskFor(1, "needs-me")]);
  await assert.rejects(
    runIntake({
      backend,
      config: CONFIG,
      dryRun: false,
      print: () => undefined,
      github: { listReviewRequested: async () => { throw new GitHubError("gh search failed: boom"); } },
      now: () => NOW,
    }),
    GitHubError,
  );
  assert.deepEqual(backend.writes, []);
});

test("a closed task still counts, so no second task and no requeue", () => {
  const closedTask = { ...taskFor(1, "done"), closed: true };
  assert.deepEqual(plan([pr(1)], [closedTask]), ["skip:task closed"]);
  assert.deepEqual(plan([pr(1, { headSha: "aaaaaaa1" })], [closedTask]), ["skip:task closed"]);
});

test("intake reads every task closed included", async () => {
  const backend = fakeBackend([{ ...taskFor(1, "done"), closed: true }]);
  await runIntake({ backend, config: CONFIG, dryRun: false, print: () => undefined, github: { listReviewRequested: async () => [pr(1)] }, now: () => NOW });
  assert.deepEqual(backend.writes, []);
});

test("the search is asked per configured repo", async () => {
  const asked: string[][] = [];
  const backend = fakeBackend([]);
  await runIntake({ backend, config: CONFIG, dryRun: false, print: () => undefined, github: { listReviewRequested: async (repos) => { asked.push(repos); return []; } }, now: () => NOW });
  assert.deepEqual(asked, [["cosuno/cosuno"]]);
});

test("gh pr view output is checked, not cast", () => {
  const good = { headRefOid: "abc", title: "t", number: 1, isDraft: false, author: { login: "a" }, commits: [{ committedDate: "2026-01-01T00:00:00Z" }] };
  assert.equal(parsePrView("u", good).headSha, "abc");
  assert.throws(() => parsePrView("u", { ...good, commits: [] }), GitHubError);
});

test("a failed backend listing creates nothing and fails the run", async () => {
  const backend = fakeBackend([]);
  backend.listTasks = async () => {
    throw new Error("backend list-tasks failed");
  };
  await assert.rejects(runIntake({ backend, config: CONFIG, dryRun: false, print: () => undefined, github: { listReviewRequested: async () => [pr(1)] }, now: () => NOW }), /list-tasks failed/);
  assert.deepEqual(backend.writes, []);
});
