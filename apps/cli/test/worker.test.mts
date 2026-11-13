import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorker } from "../src/worker.mts";
import type { RunResult, WorkerDeps } from "../src/worker.mts";
import { CONFIG, fakeBackend, NO_SANDBOX_EXTRAS, note, task } from "./helpers.mts";

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
    secret: async () => "SECRET-VALUE",
    listDir: () => [],
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
    newSessionId: () => "s-new",
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
    labels: { selftest: { kind: "skill", skill: "s", allowedTools: ["Bash({pr-review}/skills/x.sh *)"], disallowedTools: [], sandbox: NO_SANDBOX_EXTRAS, cwd: "/tmp" } },
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

test("a task closed during the run is left alone, whatever the outcome", async () => {
  for (const result of [{ exitCode: 0, signal: null, timedOut: false }, { exitCode: 1, signal: null, timedOut: false }, { exitCode: null, signal: "SIGTERM", timedOut: true }]) {
    const { deps, backend, notes } = setup(result);
    deps.run = async () => {
      backend.tasks[0]!.closed = true;
      return result;
    };
    await runWorker(deps, "w1");
    assert.deepEqual(backend.writes, []);
    assert.deepEqual(notes, []);
  }
});

test("the secrets of the masked variables reach the run, and a failing secret fails the task without its output", async () => {
  const sandboxed = { kind: "skill" as const, skill: "s", allowedTools: ["Read"], disallowedTools: [], cwd: "/tmp", sandbox: { ...NO_SANDBOX_EXTRAS, maskedEnv: [{ name: "GH_TOKEN", command: ["gh", "auth", "token"], injectHosts: ["api.github.com"] }] } };
  const { deps, backend } = setup({ exitCode: 0, signal: null, timedOut: false }, true);
  deps.config = { ...CONFIG, labels: { selftest: sandboxed } };
  const seen: Record<string, string>[] = [];
  const asked: string[][] = [];
  deps.secret = async (command) => {
    asked.push(command);
    return "SECRET-VALUE";
  };
  deps.run = async (_invocation, _taskId, _timeout, env) => {
    seen.push(env);
    backend.tasks[0]!.status = "needs-me";
    return { exitCode: 0, signal: null, timedOut: false };
  };
  await runWorker(deps, "w1");
  assert.deepEqual(asked, [["gh", "auth", "token"]]);
  assert.deepEqual(seen, [{ GH_TOKEN: "SECRET-VALUE" }]);

  const failing = setup({ exitCode: 0, signal: null, timedOut: false });
  failing.deps.config = { ...CONFIG, labels: { selftest: sandboxed } };
  failing.deps.secret = async () => {
    throw new Error("gh failed");
  };
  let started = false;
  failing.deps.run = async () => {
    started = true;
    return { exitCode: 0, signal: null, timedOut: false };
  };
  await runWorker(failing.deps, "w1");
  assert.equal(started, false);
  assert.ok(failing.backend.writes.some((w) => w.includes("Cannot read GH_TOKEN: gh failed")));
  assert.ok(failing.backend.writes.includes("status w1 -> needs-me"));
  assert.ok(failing.backend.writes.every((w) => !w.includes("SECRET-VALUE")));
});

test("a skill label without a sandbox entry ends in Needs me with the reason, and nothing is started", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null, timedOut: false });
  deps.config = { ...CONFIG, labels: { selftest: { kind: "skill", skill: "s", allowedTools: ["Read"], disallowedTools: [], cwd: "/tmp", sandbox: undefined } } };
  let started = false;
  deps.run = async () => {
    started = true;
    return { exitCode: 0, signal: null, timedOut: false };
  };
  await runWorker(deps, "w1");
  assert.equal(started, false);
  assert.ok(backend.writes.some((w) => w.includes('no "sandbox" entry')));
});

const skillLabel = { kind: "skill" as const, skill: "s", allowedTools: ["Read"], disallowedTools: [], cwd: "/tmp", sandbox: NO_SANDBOX_EXTRAS };

test("a fresh skill run gets a new session, stored on the task before the run", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null, timedOut: false }, true);
  deps.config = { ...CONFIG, labels: { selftest: skillLabel } };
  const args: string[][] = [];
  deps.run = async (invocation) => {
    args.push(invocation.args);
    assert.ok(backend.writes.includes("session w1: s-new"), "stored before the run");
    backend.tasks[0]!.status = "needs-me";
    return { exitCode: 0, signal: null, timedOut: false };
  };
  await runWorker(deps, "w1");
  assert.deepEqual(args[0]?.slice(0, 4), ["-p", "/s w1", "--session-id", "s-new"]);
});

test("a resume runs the stored session with the user's reply and uses the resume up", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null, timedOut: false });
  deps.config = { ...CONFIG, labels: { selftest: skillLabel } };
  Object.assign(backend.tasks[0]!, { next: "resume", sessionId: "s-old", machine: "here" });
  backend.notes.set("w1", [note("Done, one question", new Date("2026-11-13T10:00:00Z")), note("please also check X", new Date("2026-11-13T10:05:00Z"), { author: "user" })]);
  const args: string[][] = [];
  deps.run = async (invocation) => {
    args.push(invocation.args);
    backend.tasks[0]!.status = "needs-me";
    return { exitCode: 0, signal: null, timedOut: false };
  };
  await runWorker(deps, "w1");
  assert.equal(args[0]?.[2], "--resume");
  assert.equal(args[0]?.[3], "s-old");
  assert.match(args[0]?.[1] ?? "", /please also check X/);
  assert.ok(backend.writes.includes("next w1: fresh"));
  assert.ok(!backend.writes.some((w) => w.startsWith("session w1")));
});
