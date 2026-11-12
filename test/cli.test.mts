import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatus } from "../src/board.mts";
import { rejectExtraArgs, takeFlag, UsageError } from "../src/cli.mts";

test("leftover arguments are a usage error, so a typo never becomes a real run", () => {
  const args = ["--dryrun"];
  assert.equal(takeFlag(args, "--dry-run"), false);
  assert.throws(() => rejectExtraArgs(args, "usage: dispatch [--dry-run]"), UsageError);
  const ok = ["--dry-run"];
  takeFlag(ok, "--dry-run");
  assert.doesNotThrow(() => rejectExtraArgs(ok, "usage"));
});

test("board move takes the human status names as well as the neutral ones", () => {
  assert.equal(parseStatus("Needs me"), "needs-me");
  assert.equal(parseStatus("needs-me"), "needs-me");
  assert.equal(parseStatus("Todo"), "todo");
  assert.equal(parseStatus("Running"), "running");
  assert.equal(parseStatus("Done"), "done");
  assert.throws(() => parseStatus("Backlog"), UsageError);
});
