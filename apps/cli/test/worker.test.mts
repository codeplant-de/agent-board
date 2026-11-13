import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorker } from "../src/worker.mts";
import type { RunResult, WorkerDeps } from "../src/worker.mts";
import { CONFIG, fakeBackend, fakeRunFiles, note, task } from "./helpers.mts";

function setup(result: RunResult | Error, moveDuringRun = false) {
  // A task scheduled from /tmp on this machine.
  const running = task({ id: "w1", status: "running", input: "/selftest go", machine: "here", workdir: "/tmp" });
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
    newSessionId: () => "s-new",
    files: fakeRunFiles(),
    hookCommand: (dir, id) => `hook ${dir} ${id}`,
    now: () => new Date(),
    watchEveryMs: 10,
  };
  return { deps, backend, notes, calls };
}

test("non-zero exit reports the error and log tail", async () => {
  const { deps, backend, notes } = setup({ exitCode: 1, signal: null });
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("exited with code 1") && w.includes("tail of log")));
  assert.ok(backend.writes.includes("status w1 -> needs-me"));
  assert.equal(notes.length, 1);
});

test("a run the watch stopped is reported with the reason", async () => {
  const { deps, backend } = setup({ exitCode: null, signal: "SIGTERM", stopped: { kind: "stop", why: "inactive", message: "Stopped: the agent made no tool call for 15 minutes." } });
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("no tool call for 15 minutes")));
  assert.ok(backend.writes.includes("status w1 -> needs-me"));
});

test("exit 0 with the task still in Running is reported as unreported", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("finished without reporting")));
  assert.ok(backend.writes.includes("status w1 -> needs-me"));
});

test("exit 0 after the worker moved the task writes nothing", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  await runWorker(deps, "w1");
  assert.deepEqual(backend.writes.filter((w) => !/^(heartbeat|session|next) /.test(w)), []);
});

test("a command that cannot start is reported on the task", async () => {
  const { deps, backend } = setup(new Error("could not start claude: ENOENT"));
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("could not start claude")));
});

test("the log is reset before anything else", async () => {
  const { deps, calls } = setup({ exitCode: 0, signal: null }, true);
  await runWorker(deps, "w1");
  assert.equal(calls[0], "reset w1");
});

test("exit 0 with the task moved back to Todo is unreported, not ok", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.run = async () => {
    const found = await backend.getTask("w1");
    backend.tasks[0]!.status = "todo";
    assert.equal(found.status, "running");
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("finished without reporting")));
});

test("an unresolvable pr-review plugin sends the task to Needs me with the reason", async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  deps.config = { ...CONFIG, intake: { ...CONFIG.intake, allowedTools: ["Bash({pr-review}/skills/x.sh *)"] } };
  Object.assign(backend.tasks[0]!, { createdBy: "intake", input: "/review-pr https://github.com/cosuno/cosuno/pull/1 --auto" });
  deps.pluginPath = () => {
    throw new Error("plugin pr-review@ccc is not installed");
  };
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("Cannot resolve the pr-review plugin: plugin pr-review@ccc is not installed")));
  assert.ok(backend.writes.includes("status w1 -> needs-me"));
  assert.ok(calls.some((c) => c.startsWith("append w1:")));
});

test("a missing working directory is named in the error", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.dirExists = () => false;
  backend.tasks[0]!.workdir = "/no/such/dir";
  await runWorker(deps, "w1");
  assert.ok(backend.writes.some((w) => w.includes("/no/such/dir")));
});

test("a task closed during the run is left alone, whatever the outcome", async () => {
  for (const result of [{ exitCode: 0, signal: null }, { exitCode: 1, signal: null }, { exitCode: null, signal: "SIGTERM", timedOut: true }]) {
    const { deps, backend, notes } = setup(result);
    deps.run = async () => {
      backend.tasks[0]!.closed = true;
      return result;
    };
    await runWorker(deps, "w1");
    assert.deepEqual(backend.writes.filter((w) => !/^(heartbeat|session|next) /.test(w)), []);
    assert.deepEqual(notes, []);
  }
});

test("a fresh skill run gets a new session, stored on the task before the run", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  const args: string[][] = [];
  deps.run = async (invocation) => {
    args.push(invocation.args);
    assert.ok(backend.writes.includes("session w1: s-new"), "stored before the run");
    backend.tasks[0]!.status = "needs-me";
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, "w1");
  assert.deepEqual(args[0]?.slice(0, 4), ["-p", "/selftest go", "--session-id", "s-new"]);
});

test("a resume runs the stored session with the user's reply and uses the resume up", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { next: "resume", sessionId: "s-old", machine: "here" });
  backend.notes.set("w1", [note("Done, one question", new Date("2026-11-13T10:00:00Z")), note("please also check X", new Date("2026-11-13T10:05:00Z"), { author: "user" })]);
  const args: string[][] = [];
  deps.run = async (invocation) => {
    args.push(invocation.args);
    backend.tasks[0]!.status = "needs-me";
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, "w1");
  assert.equal(args[0]?.[2], "--resume");
  assert.equal(args[0]?.[3], "s-old");
  assert.match(args[0]?.[1] ?? "", /please also check X/);
  assert.ok(backend.writes.includes("next w1: fresh"));
  assert.ok(!backend.writes.some((w) => w.startsWith("session w1")));
});

test("a run asked to pause gives its task back to Todo with a note naming the lane", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { sessionId: "s" });
  deps.files.writeRun("w1", { lane: "implement", borrowed: true, startedAt: new Date() });
  deps.run = async () => {
    deps.files.requestPause("w1");
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, "w1");
  const pause = backend.writes.find((w) => w.startsWith("pause w1"));
  assert.match(pause ?? "", /Paused on here: its implement lane needed the slot/);
  assert.ok(!backend.writes.some((w) => w.includes("needs-me")));
  assert.equal(deps.files.readRun("w1"), undefined, "the run files are cleared");
});

test("the watch passes liveness on with the run's lane and stops a quiet skill run", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.files.writeRun("w1", { lane: "reviews", borrowed: true, startedAt: new Date() });
  let clock = Date.now();
  deps.now = () => new Date(clock);
  let decision: unknown;
  deps.run = async (_invocation, _taskId, _env, watch) => {
    clock += 20 * 60_000;
    decision = await watch.tick();
    return { exitCode: null, signal: "SIGTERM", stopped: { kind: "stop", why: "inactive", message: "Stopped: the agent made no tool call for 15 minutes." } };
  };
  await runWorker(deps, "w1");
  assert.ok(backend.writes.includes("heartbeat w1 reviews borrowed"));
  assert.deepEqual(decision, { kind: "stop", why: "inactive", message: "Stopped: the agent made no tool call for 15 minutes." });
  assert.ok(backend.writes.some((w) => w.includes("no tool call for 15 minutes")));
});

test("the hook goes into a skill run's settings", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  let settings = "";
  deps.run = async (invocation) => {
    settings = invocation.args[invocation.args.indexOf("--settings") + 1] ?? "";
    backend.tasks[0]!.status = "needs-me";
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, "w1");
  assert.match(settings, /"command":"hook \/run\/test\/agent-board w1"/);
});

test("a fresh skill run binds the task to its directory, and to the worktree it ended in", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { machine: null, workdir: null });
  deps.run = async () => {
    deps.files.writeCwd("w1", "/tmp/.claude/worktrees/feat-x");
    backend.tasks[0]!.status = "needs-me";
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, "w1");
  const workdirs = backend.writes.filter((w) => w.startsWith("workdir w1"));
  assert.deepEqual(workdirs, ["workdir w1: /home/me", "workdir w1: /tmp/.claude/worktrees/feat-x"]);
});

test("a resume starts in the task's directory, and a missing one fails without starting", async () => {
  const resumable = { next: "resume" as const, sessionId: "s-old", machine: "here", workdir: "/repo/.claude/worktrees/feat-x" };
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, resumable);
  backend.notes.set("w1", [note("asked", new Date("2026-11-13T10:00:00Z")), note("go on", new Date("2026-11-13T10:05:00Z"), { author: "user" })]);
  let cwd = "";
  deps.run = async (invocation) => {
    cwd = invocation.cwd;
    backend.tasks[0]!.status = "needs-me";
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, "w1");
  assert.equal(cwd, "/repo/.claude/worktrees/feat-x");

  const gone = setup({ exitCode: 0, signal: null });
  Object.assign(gone.backend.tasks[0]!, resumable);
  gone.backend.notes.set("w1", [note("asked", new Date("2026-11-13T10:00:00Z")), note("go on", new Date("2026-11-13T10:05:00Z"), { author: "user" })]);
  gone.deps.dirExists = (path) => path !== "/repo/.claude/worktrees/feat-x";
  let started = false;
  gone.deps.run = async () => {
    started = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(gone.deps, "w1");
  assert.equal(started, false);
  assert.ok(gone.backend.writes.some((w) => w.includes("task's directory is gone: /repo/.claude/worktrees/feat-x")));
});

test("the run's stream becomes readable log lines and a transcript sent with each check and at the end", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const logged: (string | undefined)[] = [];
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    logged.push(onLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } })));
    await watch.tick();
    logged.push(onLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] } })));
    logged.push(onLine(JSON.stringify({ type: "result", result: "All done", is_error: false })));
    backend.tasks[0]!.status = "needs-me";
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, "w1");
  assert.deepEqual(logged, ["→ Bash: ls", undefined, "All done"]);
  assert.deepEqual(backend.writes.filter((w) => w.startsWith("transcript")), ["transcript w1 s-new tool_use", "transcript w1 s-new tool_result,result"]);
});

test("a transcript batch the board refused is sent again with the next one", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  let failures = 1;
  const sent: string[] = [];
  backend.transcript = async (_id, batch) => {
    if (failures-- > 0) throw new Error("board down");
    sent.push(batch.events.map((e) => e.kind).join(","));
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    onLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } }));
    await watch.tick();
    onLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } }));
    backend.tasks[0]!.status = "needs-me";
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, "w1");
  assert.deepEqual(sent, ["text,text"]);
});
