import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorker } from "../src/worker.mts";
import type { RunResult, WorkerDeps } from "../src/worker.mts";
import { CONFIG, fakeBackend, task } from "./helpers.mts";

function setup(result: RunResult | Error, moveDuringRun = false) {
  const running = task({ id: "w1", status: "running", labels: ["selftest"] });
  const backend = fakeBackend([running]);
  const notes: string[] = [];
  const calls: string[] = [];
  const deps: WorkerDeps = {
    backend,
    config: CONFIG,
    dryRun: false,
    print: () => undefined,
    run: async () => {
      if (moveDuringRun) running.status = "needs-me";
      if (result instanceof Error) throw result;
      return result;
    },
    logTail: () => "tail of log",
    notify: async (_task, text) => void notes.push(text),
    resetLog: (shortLink) => void calls.push(`reset ${shortLink}`),
    appendLog: (shortLink, text) => void calls.push(`append ${shortLink}: ${text}`),
    pluginPath: () => "/plugins/pr-review",
    dirExists: () => true,
    home: "/h",
    fallbackCwd: "/",
  };
  return { deps, backend, notes, calls };
}

test("non-zero exit reports the error and log tail", async () => {
  const { deps, backend, notes } = setup({ exitCode: 1, signal: null, timedOut: false });
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("exited with code 1") && w.includes("tail of log")));
  assert.ok(backend.writes.includes("status w1 -> needs-me"));
  assert.equal(notes.length, 1);
});

test("timeout is reported as such", async () => {
  const { deps, backend } = setup({ exitCode: null, signal: "SIGTERM", timedOut: true });
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("Timed out after 45 minutes")));
});

test("exit 0 with the task still in Running is reported as unreported", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null, timedOut: false });
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("finished without reporting")));
  assert.ok(backend.writes.includes("status w1 -> needs-me"));
});

test("exit 0 after the worker moved the task writes nothing", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null, timedOut: false }, true);
  await runWorker(deps, "w1");
  assert.deepEqual(backend.writes, []);
});

test("a command that cannot start is reported on the task", async () => {
  const { deps, backend } = setup(new Error("could not start claude: ENOENT"));
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("could not start claude")));
});

test("the log is reset before anything else", async () => {
  const { deps, calls } = setup({ exitCode: 0, signal: null, timedOut: false }, true);
  await runWorker(deps, "w1");
  assert.equal(calls[0], "reset w1");
});

test("exit 0 with the task moved back to Todo is unreported, not ok", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null, timedOut: false });
  deps.run = async () => {
    const found = await backend.getTask("w1");
    backend.tasks[0]!.status = "todo";
    assert.equal(found.status, "running");
    return { exitCode: 0, signal: null, timedOut: false };
  };
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("finished without reporting")));
});

test("an unresolvable pr-review plugin sends the task to Needs me with the reason", async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null, timedOut: false });
  deps.config = {
    ...CONFIG,
    labels: { selftest: { kind: "skill", skill: "s", allowedTools: ["Bash({pr-review}/skills/x.sh *)"], disallowedTools: [], cwd: "/tmp" } },
  };
  deps.pluginPath = () => {
    throw new Error("plugin pr-review@ccc is not installed");
  };
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("Cannot resolve the pr-review plugin: plugin pr-review@ccc is not installed")));
  assert.ok(backend.writes.includes("status w1 -> needs-me"));
  assert.ok(calls.some((c) => c.startsWith("append w1:")));
});

test("a missing working directory is named in the error", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null, timedOut: false });
  deps.dirExists = () => false;
  deps.config = { ...CONFIG, labels: { selftest: { kind: "command", command: ["true"], cwd: "/no/such/dir" } } };
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("/no/such/dir")));
});
