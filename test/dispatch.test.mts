import assert from "node:assert/strict";
import { test } from "node:test";
import { runDispatch } from "../src/dispatch.mts";
import type { DispatchDeps } from "../src/dispatch.mts";
import type { System } from "../src/system.mts";
import { START_MARKER } from "../src/decide.mts";
import { card, CONFIG, fakeTrello } from "./helpers.mts";
import type { FakeTrello } from "./helpers.mts";

const selftest = { id: "1", name: "selftest" };
const NOW = new Date("2026-01-01T12:00:00Z");

function setup(cards: ReturnType<typeof card>[], active: string[] = []) {
  const trello: FakeTrello = fakeTrello(cards);
  const started: string[] = [];
  const stopped: string[] = [];
  const logs: string[] = [];
  const system: System = {
    async isActive(unit) {
      return active.includes(unit);
    },
    async stop(unit) {
      stopped.push(unit);
    },
    async startWorker(shortLink) {
      started.push(shortLink);
      return { pid: 42 };
    },
  };
  const deps: DispatchDeps = {
    trello,
    config: CONFIG,
    dryRun: false,
    print: (line) => logs.push(line),
    system,
    now: () => NOW,
    logTail: () => "last log line",
    notify: async () => undefined,
  };
  return { trello, deps, started, stopped, logs };
}

const running = (shortLink: string) => card({ shortLink, idList: "l-running", labels: [selftest] });
const todo = (shortLink: string, pos: number) => card({ shortLink, pos, labels: [selftest] });

test("starts from the top of Todo up to the cap", async () => {
  const { deps, started, trello } = setup([running("r1"), todo("t3", 30), todo("t1", 10), todo("t2", 20)], ["agent-board-r1"]);
  await runDispatch(deps);
  assert.deepEqual(started, ["t1"]);
  assert.ok(trello.writes.some((w) => w.startsWith("move id-t1 -> Running")));
  assert.ok(trello.writes.some((w) => w.includes(START_MARKER) && w.includes("pid 42")));
});

test("with all slots taken nothing starts", async () => {
  const { deps, started } = setup([running("r1"), running("r2"), todo("t1", 1)], ["agent-board-r1", "agent-board-r2"]);
  await runDispatch(deps);
  assert.deepEqual(started, []);
});

test("a card with an unknown label goes to Needs me and does not use a slot", async () => {
  const odd = card({ shortLink: "odd", pos: 1, labels: [{ id: "9", name: "mystery" }] });
  const { deps, started, trello } = setup([odd, todo("t1", 2), todo("t2", 3), todo("t3", 4)]);
  await runDispatch(deps);
  assert.deepEqual(started, ["t1", "t2"]);
  assert.ok(trello.writes.some((w) => w.includes("move id-odd -> Needs me")));
  assert.ok(trello.writes.some((w) => w.includes("mystery")));
});

test("a stale Running card goes to Needs me with the log tail and frees its slot", async () => {
  const { deps, started, trello } = setup([running("dead"), todo("t1", 1)]);
  await runDispatch(deps);
  assert.ok(trello.writes.some((w) => w.includes("comment id-dead") && w.includes("last log line")));
  assert.ok(trello.writes.some((w) => w === "move id-dead -> Needs me"));
  assert.deepEqual(started, ["t1"]);
});

test("a timed-out active worker is stopped, then reported", async () => {
  const { deps, trello, stopped } = setup([running("slow")], ["agent-board-slow"]);
  trello.comments.set("id-slow", [{ id: "c", text: `${START_MARKER} x`, date: new Date(NOW.getTime() - 60 * 60_000) }]);
  await runDispatch(deps);
  assert.deepEqual(stopped, ["agent-board-slow"]);
  assert.ok(trello.writes.some((w) => w === "move id-slow -> Needs me"));
});

test("a failed start sends the card to Needs me and keeps the slot free", async () => {
  const { deps, trello } = setup([todo("t1", 1), todo("t2", 2)]);
  let calls = 0;
  deps.system = {
    ...deps.system,
    async startWorker() {
      calls++;
      if (calls === 1) throw new Error("unit exists");
      return { pid: undefined };
    },
  };
  await runDispatch(deps);
  assert.equal(calls, 2);
  assert.ok(trello.writes.some((w) => w.includes("could not be started: unit exists")));
});
