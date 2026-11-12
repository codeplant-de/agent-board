import assert from "node:assert/strict";
import { test } from "node:test";
import { rejectExtraArgs, takeFlag, UsageError } from "../src/cli.mts";

test("leftover arguments are a usage error, so a typo never becomes a real run", () => {
  const args = ["--dryrun"];
  assert.equal(takeFlag(args, "--dry-run"), false);
  assert.throws(() => rejectExtraArgs(args, "usage: dispatch [--dry-run]"), UsageError);
  const ok = ["--dry-run"];
  takeFlag(ok, "--dry-run");
  assert.doesNotThrow(() => rejectExtraArgs(ok, "usage"));
});
