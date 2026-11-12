import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubError, parsePrView } from "../src/github.mts";
import type { LivePr } from "../src/github.mts";
import { planIntake, runIntake } from "../src/intake.mts";
import { card, CONFIG, fakeTrello, LISTS } from "./helpers.mts";

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

const cardFor = (n: number, idList: string, head = "aaaaaaa1") => card({ shortLink: `c${n}`, idList, desc: `${url(n)}\nhead: ${head}` });
const plan = (prs: LivePr[], cards = [] as ReturnType<typeof card>[]) =>
  planIntake({ prs, cards, lists: LISTS, repos: Object.keys(CONFIG.repos), now: NOW }).map((a) => a.kind === "skip" ? `skip:${a.reason}` : a.kind);

test("a new settled PR gets a card", () => {
  assert.deepEqual(plan([pr(1)]), ["create"]);
});

test("drafts, unmapped repos and unsettled heads are skipped", () => {
  const unmapped = pr(2, { url: "https://github.com/other/repo/pull/2" });
  const fresh = pr(3, { headCommittedAt: new Date(NOW.getTime() - 60_000) });
  assert.deepEqual(plan([pr(1, { isDraft: true }), unmapped, fresh]), ["skip:draft", "skip:repository not in config", "skip:head not settled"]);
});

test("a PR with a card in any list never gets a second card", () => {
  for (const list of LISTS) assert.deepEqual(plan([pr(1, { headSha: "aaaaaaa1" })], [cardFor(1, list.id)]), ["skip:card exists"]);
});

test("a moved, settled head requeues a card from Needs me or Done only", () => {
  assert.deepEqual(plan([pr(1)], [cardFor(1, "l-needs")]), ["requeue"]);
  assert.deepEqual(plan([pr(1)], [cardFor(1, "l-done")]), ["requeue"]);
  assert.deepEqual(plan([pr(1)], [cardFor(1, "l-todo")]), ["skip:head moved, card is in Todo"]);
  assert.deepEqual(plan([pr(1)], [cardFor(1, "l-running")]), ["skip:head moved, card is in Running"]);
});

test("a failed card stays put while its head is unchanged, and is retried when the head moves", () => {
  assert.deepEqual(plan([pr(1, { headSha: "aaaaaaa1" })], [cardFor(1, "l-needs")]), ["skip:card exists"]);
  assert.deepEqual(plan([pr(1)], [cardFor(1, "l-needs")]), ["requeue"]);
});

test("a moved head that has not settled waits", () => {
  const fresh = pr(1, { headCommittedAt: new Date(NOW.getTime() - 60_000) });
  assert.deepEqual(plan([fresh], [cardFor(1, "l-needs")]), ["skip:head moved, not settled"]);
});

test("a hand-made card without a head line is left alone", () => {
  assert.deepEqual(plan([pr(1)], [card({ shortLink: "h", idList: "l-needs", desc: url(1) })]), ["skip:card exists"]);
});

test("running intake twice creates the card once", async () => {
  const trello = fakeTrello([]);
  const logs: string[] = [];
  const deps = {
    trello,
    config: CONFIG,
    dryRun: false,
    print: (line: string) => logs.push(line),
    github: { listReviewRequested: async () => [pr(1)] },
    now: () => NOW,
  };
  await runIntake(deps);
  trello.cards.push(card({ shortLink: "new", desc: `${url(1)}\nhead: bbbbbbb1` }));
  await runIntake(deps);
  assert.equal(trello.writes.filter((w) => w.startsWith("create")).length, 1);
  assert.ok(logs.includes("INTAKE prs=1 created=0 requeued=0"));
});

test("requeue moves the card, updates the head line and comments", async () => {
  const trello = fakeTrello([cardFor(1, "l-needs")]);
  await runIntake({ trello, config: CONFIG, dryRun: false, print: () => undefined, github: { listReviewRequested: async () => [pr(1)] }, now: () => NOW });
  assert.deepEqual(trello.writes.map((w) => w.split(":")[0]), ["move id-c1 -> Todo", "desc id-c1", "comment id-c1"]);
});

test("a failed listing changes nothing and fails the run", async () => {
  const trello = fakeTrello([cardFor(1, "l-needs")]);
  await assert.rejects(
    runIntake({
      trello,
      config: CONFIG,
      dryRun: false,
      print: () => undefined,
      github: { listReviewRequested: async () => { throw new GitHubError("gh search failed: boom"); } },
      now: () => NOW,
    }),
    GitHubError,
  );
  assert.deepEqual(trello.writes, []);
});

test("an archived card still counts, so no second card and no requeue", () => {
  const archived = { ...cardFor(1, "l-done"), closed: true };
  assert.deepEqual(plan([pr(1)], [archived]), ["skip:card archived"]);
  assert.deepEqual(plan([pr(1, { headSha: "aaaaaaa1" })], [archived]), ["skip:card archived"]);
});

test("intake reads every card on the board, archived included", async () => {
  const trello = fakeTrello([{ ...cardFor(1, "l-done"), closed: true }]);
  await runIntake({ trello, config: CONFIG, dryRun: false, print: () => undefined, github: { listReviewRequested: async () => [pr(1)] }, now: () => NOW });
  assert.deepEqual(trello.writes, []);
});

test("the search is asked per configured repo", async () => {
  const asked: string[][] = [];
  const trello = fakeTrello([]);
  await runIntake({ trello, config: CONFIG, dryRun: false, print: () => undefined, github: { listReviewRequested: async (repos) => { asked.push(repos); return []; } }, now: () => NOW });
  assert.deepEqual(asked, [["cosuno/cosuno"]]);
});

test("gh pr view output is checked, not cast", () => {
  const good = { headRefOid: "abc", title: "t", number: 1, isDraft: false, author: { login: "a" }, commits: [{ committedDate: "2026-01-01T00:00:00Z" }] };
  assert.equal(parsePrView("u", good).headSha, "abc");
  assert.throws(() => parsePrView("u", { ...good, commits: [] }), GitHubError);
});
