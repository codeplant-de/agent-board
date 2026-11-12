import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorker } from "../src/worker.mts";
import type { RunResult, WorkerDeps } from "../src/worker.mts";
import { card, CONFIG, fakeTrello } from "./helpers.mts";

function setup(result: RunResult | Error, moveDuringRun = false) {
  const running = card({ shortLink: "w1", idList: "l-running", labels: [{ id: "1", name: "selftest" }] });
  const trello = fakeTrello([running]);
  const notes: string[] = [];
  const deps: WorkerDeps = {
    trello,
    config: CONFIG,
    dryRun: false,
    print: () => undefined,
    run: async () => {
      if (moveDuringRun) running.idList = "l-needs";
      if (result instanceof Error) throw result;
      return result;
    },
    logTail: () => "tail of log",
    notify: async (_card, text) => void notes.push(text),
    home: "/h",
    fallbackCwd: "/",
  };
  return { deps, trello, notes };
}

test("non-zero exit reports the error and log tail", async () => {
  const { deps, trello, notes } = setup({ exitCode: 1, signal: null, timedOut: false });
  await runWorker(deps, "w1");
  assert.ok(trello.writes.some((w) => w.includes("exited with code 1") && w.includes("tail of log")));
  assert.ok(trello.writes.includes("move id-w1 -> Needs me"));
  assert.equal(notes.length, 1);
});

test("timeout is reported as such", async () => {
  const { deps, trello } = setup({ exitCode: null, signal: "SIGTERM", timedOut: true });
  await runWorker(deps, "w1");
  assert.ok(trello.writes.some((w) => w.includes("Timed out after 45 minutes")));
});

test("exit 0 with the card still in Running is reported as unreported", async () => {
  const { deps, trello } = setup({ exitCode: 0, signal: null, timedOut: false });
  await runWorker(deps, "w1");
  assert.ok(trello.writes.some((w) => w.includes("finished without reporting")));
  assert.ok(trello.writes.includes("move id-w1 -> Needs me"));
});

test("exit 0 after the worker moved the card writes nothing", async () => {
  const { deps, trello } = setup({ exitCode: 0, signal: null, timedOut: false }, true);
  await runWorker(deps, "w1");
  assert.deepEqual(trello.writes, []);
});

test("a command that cannot start is reported on the card", async () => {
  const { deps, trello } = setup(new Error("could not start claude: ENOENT"));
  await runWorker(deps, "w1");
  assert.ok(trello.writes.some((w) => w.includes("could not start claude")));
});
