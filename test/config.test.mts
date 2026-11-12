import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, isSafeMode, loadCredentials, parseConfig, parseEnv } from "../src/config.mts";

const valid = {
  boardId: "abc",
  repos: { "cosuno/cosuno": "~/x" },
  labels: {
    selftest: { command: ["sleep", "300"] },
    "review-pr": { skill: "board-review-pr", allowedTools: ["Read"] },
  },
};

test("a valid config gets defaults and normalised label entries", () => {
  const config = parseConfig(valid);
  assert.equal(config.maxParallel, 2);
  assert.equal(config.timeoutMinutes, 45);
  assert.equal(config.labels["selftest"]?.kind, "command");
  const skill = config.labels["review-pr"];
  assert.ok(skill?.kind === "skill");
  assert.equal(skill.cwd, "pr-repo");
  assert.ok(!config.repos["cosuno/cosuno"]?.startsWith("~"));
});

test("invalid configs are refused with a pointed message", () => {
  const cases: [unknown, RegExp][] = [
    ["nope", /top level/],
    [{ ...valid, boardId: "" }, /boardId/],
    [{ ...valid, labels: {} }, /labels/],
    [{ ...valid, maxParallel: 0 }, /maxParallel/],
    [{ ...valid, labels: { x: { skill: "s", allowedTools: [] } } }, /allowedTools must not be empty/],
    [{ ...valid, labels: { x: { command: [] } } }, /command/],
    [{ ...valid, labels: { x: { skill: "s" } } }, /allowedTools/],
    [{ ...valid, repos: { bad: "/x" } }, /owner\/name/],
    [{ ...valid, repos: {} }, /repos must not be empty/],
  ];
  for (const [input, message] of cases) assert.throws(() => parseConfig(input), (error) => error instanceof ConfigError && message.test(error.message));
});

test("only modes 600 and 400 pass", () => {
  assert.equal(isSafeMode(0o100600), true);
  assert.equal(isSafeMode(0o100400), true);
  for (const mode of [0o644, 0o640, 0o660, 0o700, 0o666]) assert.equal(isSafeMode(mode), false);
});

test("the env file is refused unless owner-only, and must hold both keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-board-"));
  const file = join(dir, "env");
  writeFileSync(file, "TRELLO_API_KEY=k\nTRELLO_TOKEN='t'\n");
  chmodSync(file, 0o644);
  assert.throws(() => loadCredentials(file), /mode 600 or 400, is 644/);
  chmodSync(file, 0o600);
  assert.deepEqual(loadCredentials(file), { key: "k", token: "t" });
  writeFileSync(file, "TRELLO_API_KEY=k\n");
  assert.throws(() => loadCredentials(file), /needs TRELLO_API_KEY and TRELLO_TOKEN/);
  assert.throws(() => loadCredentials(join(dir, "missing")), /credentials file missing/);
});

test("env parsing ignores comments and strips quotes and export", () => {
  assert.deepEqual(parseEnv("# c\nexport A=1\nB=\"two\"\n\nC = 3\n"), { A: "1", B: "two", C: "3" });
});
