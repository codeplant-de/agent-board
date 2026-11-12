import assert from "node:assert/strict";
import { test } from "node:test";
import { runDispatch } from "../src/dispatch.mts";
import type { DispatchDeps } from "../src/dispatch.mts";
import { SystemError } from "../src/system.mts";
import type { System } from "../src/system.mts";
import { START_MARKER } from "../src/decide.mts";
import { CONFIG, fakeBackend, task } from "./helpers.mts";
import type { FakeBackend } from "./helpers.mts";

const selftest = "selftest";
const NOW = new Date("2026-01-01T12:00:00Z");

function setup(tasks: ReturnType<typeof task>[], active: string[] = [], unitStarts: Record<string, Date> = {}) {
  const backend: FakeBackend = fakeBackend(tasks);
  const started: string[] = [];
  const stopped: string[] = [];
  const logs: string[] = [];
  const system: System = {
    async isActive(unit) {
      return active.includes(unit);
    },
    async startedAt(unit) {
      return unitStarts[unit];
    },
    async activeWorkers() {
      return active.map((unit) => unit.replace("agent-board-", ""));
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
    backend,
    config: CONFIG,
    dryRun: false,
    print: (line) => logs.push(line),
    system,
    now: () => NOW,
    logTail: () => "last log line",
    notify: async () => undefined,
  };
  return { backend, deps, started, stopped, logs };
}

const running = (id: string) => task({ id, status: "running", labels: [selftest] });
const todo = (id: string) => task({ id, labels: [selftest] });

test("starts from the top of Todo up to the cap", async () => {
  const { deps, started, backend } = setup([running("r1"), todo("t1"), todo("t2"), todo("t3")], ["agent-board-r1"]);
  await runDispatch(deps);
  assert.deepEqual(started, ["t1"]);
  assert.ok(backend.writes.some((w) => w.startsWith("status t1 -> running")));
  assert.ok(backend.writes.some((w) => w.includes(START_MARKER) && w.includes("pid 42")));
});

test("with all slots taken nothing starts", async () => {
  const { deps, started } = setup([running("r1"), running("r2"), todo("t1")], ["agent-board-r1", "agent-board-r2"]);
  await runDispatch(deps);
  assert.deepEqual(started, []);
});

test("a task with an unknown label goes to Needs me and does not use a slot", async () => {
  const odd = task({ id: "odd", labels: ["mystery"] });
  const { deps, started, backend } = setup([odd, todo("t1"), todo("t2"), todo("t3")]);
  await runDispatch(deps);
  assert.deepEqual(started, ["t1", "t2"]);
  assert.ok(backend.writes.some((w) => w.includes("status odd -> needs-me")));
  assert.ok(backend.writes.some((w) => w.includes("mystery")));
});

test("a stale Running task goes to Needs me with the log tail and frees its slot", async () => {
  const { deps, started, backend } = setup([running("dead"), todo("t1")]);
  await runDispatch(deps);
  assert.ok(backend.writes.some((w) => w.includes("note dead") && w.includes("last log line")));
  assert.ok(backend.writes.some((w) => w === "status dead -> needs-me"));
  assert.deepEqual(started, ["t1"]);
});

test("a timed-out active worker is stopped, then reported", async () => {
  const { deps, backend, stopped } = setup([running("slow")], ["agent-board-slow"]);
  backend.notes.set("slow", [{ text: `${START_MARKER} x`, createdAt: new Date(NOW.getTime() - 60 * 60_000) }]);
  await runDispatch(deps);
  assert.deepEqual(stopped, ["agent-board-slow"]);
  assert.ok(backend.writes.some((w) => w === "status slow -> needs-me"));
});

test("a failed start sends the task to Needs me and stops filling slots", async () => {
  const { deps, backend } = setup([todo("t1"), todo("t2")]);
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
  assert.equal(calls, 1, "no further task is started after a failure");
  assert.ok(backend.writes.some((w) => w.includes("could not be started: unit exists")));
});

test("a failed start comment does not send the running task to Needs me", async () => {
  const { deps, backend, started } = setup([todo("t1")]);
  const addNote = backend.addNote.bind(backend);
  backend.addNote = async (id, text) => {
    if (text.startsWith(START_MARKER)) throw new Error("backend down");
    return addNote(id, text);
  };
  await runDispatch(deps);
  assert.deepEqual(started, ["t1"]);
  assert.ok(!backend.writes.some((w) => w.includes("needs-me")));
});

test("unknown systemd state starts nothing and changes nothing", async () => {
  const { deps, backend, started } = setup([running("r1"), todo("t1")]);
  deps.system = {
    ...deps.system,
    async isActive() {
      throw new SystemError("bus unreachable");
    },
  };
  await assert.rejects(runDispatch(deps), SystemError);
  assert.deepEqual(started, []);
  assert.deepEqual(backend.writes, []);
});

test("the run is timed from its unit, not from a comment of an earlier run", async () => {
  const { deps, backend, stopped } = setup([running("again")], ["agent-board-again"], { "agent-board-again": new Date(NOW.getTime() - 5 * 60_000) });
  backend.notes.set("again", [{ text: `${START_MARKER} old`, createdAt: new Date(NOW.getTime() - 5 * 60 * 60_000) }]);
  await runDispatch(deps);
  assert.deepEqual(stopped, []);
  assert.deepEqual(backend.writes, []);
});

test("the cap counts active units even when fewer tasks sit in Running", async () => {
  const { deps, started } = setup([running("r1"), todo("t1")], ["agent-board-r1", "agent-board-orphan"]);
  await runDispatch(deps);
  assert.deepEqual(started, []);
});

test("a failed listing starts nothing and changes nothing", async () => {
  const { deps, backend, started } = setup([running("r1"), todo("t1")]);
  backend.listTasks = async () => {
    throw new Error("backend list-tasks failed");
  };
  await assert.rejects(runDispatch(deps), /list-tasks failed/);
  assert.deepEqual(started, []);
  assert.deepEqual(backend.writes, []);
});
