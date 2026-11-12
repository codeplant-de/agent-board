import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { logPath } from "../src/logs.mts";
import { runProcess } from "../src/worker.mts";

process.env["AGENT_BOARD_STATE_DIR"] = mkdtempSync(join(tmpdir(), "agent-board-state-"));

test("a finished process reports its exit code and writes its log", async () => {
  const result = await runProcess({ command: "sh", args: ["-c", "echo hello; exit 3"], cwd: tmpdir() }, "proc1", 5_000);
  assert.deepEqual(result, { exitCode: 3, signal: null, timedOut: false });
  assert.match(readFileSync(logPath("proc1"), "utf8"), /hello/);
});

test("a process past its timeout is stopped with everything it started", async () => {
  const started = Date.now();
  const result = await runProcess({ command: "sh", args: ["-c", "sleep 30 & wait"], cwd: tmpdir() }, "proc2", 200);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5_000);
});

test("a missing command rejects", async () => {
  await assert.rejects(runProcess({ command: "no-such-command-xyz", args: [], cwd: tmpdir() }, "proc3", 1_000), /could not start/);
});
