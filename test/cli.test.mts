import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseStatus, readNoteFile } from "../src/board.mts";
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

test("a note file is read only from /tmp, without following links", () => {
  const dir = mkdtempSync("/tmp/pr-note-test-");
  const secret = join(mkdtempSync(join(homedir(), ".agent-board-test-")), "secret");
  try {
    writeFileSync(secret, "TOKEN=1");
    writeFileSync(join(dir, "note.md"), "  findings\n");
    assert.equal(readNoteFile(join(dir, "note.md")), "findings");
    symlinkSync(secret, join(dir, "link.md"));
    assert.throws(() => readNoteFile(join(dir, "link.md")), UsageError);
    symlinkSync(dirname(secret), join(dir, "linkdir"));
    assert.throws(() => readNoteFile(join(dir, "linkdir", "secret")), /must be inside \/tmp\//);
    assert.throws(() => readNoteFile(secret), /must be inside \/tmp\//);
    writeFileSync(join(dir, "big.md"), "x".repeat(1024 * 1024 + 1));
    assert.throws(() => readNoteFile(join(dir, "big.md")), /at most 1 MiB/);
    assert.throws(() => readNoteFile(join(dir, "missing.md")), /cannot read/);
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(dirname(secret), { recursive: true });
  }
});
