import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorker } from "../src/worker.mts";
import type { RunResult, WorkerDeps } from "../src/worker.mts";
import { card, CONFIG, fakeTrello } from "./helpers.mts";

function setup(result: RunResult | Error, moveDuringRun = false) {
  const running = card({ shortLink: "w1", idList: "l-running", labels: [{ id: "1", name: "selftest" }] });
  const trello = fakeTrello([running]);
  const notes: string[] = [];
  const calls: string[] = [];
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
    resetLog: (shortLink) => void calls.push(`reset ${shortLink}`),
    appendLog: (shortLink, text) => void calls.push(`append ${shortLink}: ${text}`),
    pluginPath: () => "/plugins/pr-review",
    dirExists: () => true,
    home: "/h",
    fallbackCwd: "/",
  };
  return { deps, trello, notes, calls };
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

test("the log is reset before anything else", async () => {
  const { deps, calls } = setup({ exitCode: 0, signal: null, timedOut: false }, true);
  await runWorker(deps, "w1");
  assert.equal(calls[0], "reset w1");
});

test("exit 0 with the card moved back to Todo is unreported, not ok", async () => {
  const { deps, trello } = setup({ exitCode: 0, signal: null, timedOut: false });
  deps.run = async () => {
    const found = await trello.getCard("w1");
    trello.cards[0]!.idList = "l-todo";
    assert.equal(found.idList, "l-running");
    return { exitCode: 0, signal: null, timedOut: false };
  };
  await runWorker(deps, "w1");
  assert.ok(trello.writes.some((w) => w.includes("finished without reporting")));
});

test("an unresolvable pr-review plugin sends the card to Needs me with the reason", async () => {
  const { deps, trello, calls } = setup({ exitCode: 0, signal: null, timedOut: false });
  deps.config = {
    ...CONFIG,
    labels: { selftest: { kind: "skill", skill: "s", allowedTools: ["Bash({pr-review}/skills/x.sh *)"], disallowedTools: [], cwd: "/tmp" } },
  };
  deps.pluginPath = () => {
    throw new Error("plugin pr-review@ccc is not installed");
  };
  await runWorker(deps, "w1");
  assert.ok(trello.writes.some((w) => w.includes("Cannot resolve the pr-review plugin: plugin pr-review@ccc is not installed")));
  assert.ok(trello.writes.includes("move id-w1 -> Needs me"));
  assert.ok(calls.some((c) => c.startsWith("append w1:")));
});

test("a missing working directory is named in the error", async () => {
  const { deps, trello } = setup({ exitCode: 0, signal: null, timedOut: false });
  deps.dirExists = () => false;
  deps.config = { ...CONFIG, labels: { selftest: { kind: "command", command: ["true"], cwd: "/no/such/dir" } } };
  await runWorker(deps, "w1");
  assert.ok(trello.writes.some((w) => w.includes("/no/such/dir")));
});
