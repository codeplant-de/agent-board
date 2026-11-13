import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, isSafeMode, parseConfig, readSecretFile } from "../src/config.mts";

const valid = {
  backend: { command: ["~/bin/backend", "--flag"] },
  repos: { "cosuno/cosuno": "~/x" },
};

test("a valid config gets defaults", () => {
  const config = parseConfig(valid);
  assert.deepEqual(config.lanes, [{ name: "general", skills: ["*"], slots: 3 }]);
  assert.deepEqual(config.intake, { prompt: "/review-pr {url} --auto", priority: "normal", allowedTools: [], disallowedTools: [] });
  assert.ok(config.defaultCwd.startsWith("/") && !config.defaultCwd.includes("~"));
  assert.deepEqual([config.pauseAfterMinutes, config.inactivityMinutes, config.maxRunHours], [5, 15, 6]);
  assert.equal(config.backendCommand[1], "--flag");
  assert.ok(!config.backendCommand[0]?.startsWith("~"));
  assert.ok(!config.repos["cosuno/cosuno"]?.startsWith("~"));
});

test("invalid configs are refused with a pointed message", () => {
  const cases: [unknown, RegExp][] = [
    ["nope", /top level/],
    [{ ...valid, backend: undefined }, /backend.command/],
    [{ ...valid, backend: { command: [] } }, /backend.command/],
    [{ ...valid, backend: { command: ["ok", 3] } }, /backend.command/],
    [{ ...valid, inactivityMinutes: 0 }, /inactivityMinutes/],
    [{ ...valid, lanes: { reviews: { skills: [] } } }, /skills must be a non-empty list/],
    [{ ...valid, lanes: { a: { skills: ["review-pr"] }, b: { skills: ["/pr-review:review-pr"] } } }, /in lanes a and b/],
    [{ ...valid, lanes: { a: { skills: ["*"] }, b: { skills: ["*"] } } }, /"\*" is in lanes a and b/],
    [{ ...valid, lanes: { "a b": { skills: ["x"] } } }, /lane name/],
    [{ ...valid, lanes: { a: { skills: ["x"], slots: 0 } } }, /lanes.a.slots/],
    [{ ...valid, intake: { prompt: "/review-pr --auto" } }, /intake.prompt must be a prompt with \{url\}/],
    [{ ...valid, intake: { priority: "asap" } }, /intake.priority must be one of/],
    [{ ...valid, defaultCwd: "relative" }, /defaultCwd/],
    [{ ...valid, repos: { bad: "/x" } }, /owner\/name/],
    [{ ...valid, backend: { command: ["bin/backend"] } }, /backend.command\[0\] must be an absolute path/],
    [{ ...valid, backend: { command: ["./backend"] } }, /backend.command\[0\] must be an absolute path/],
    [{ ...valid, backend: { command: ["../backend"] } }, /backend.command\[0\] must be an absolute path/],
  ];
  for (const [input, message] of cases) assert.throws(() => parseConfig(input), (error) => error instanceof ConfigError && message.test(error.message));
});

test("only modes 600 and 400 pass", () => {
  assert.equal(isSafeMode(0o100600), true);
  assert.equal(isSafeMode(0o100400), true);
  for (const mode of [0o644, 0o640, 0o660, 0o700, 0o666]) assert.equal(isSafeMode(mode), false);
});

test("a secret file is refused unless owner-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-board-"));
  const file = join(dir, "secret");
  writeFileSync(file, "x\n");
  chmodSync(file, 0o644);
  assert.throws(() => readSecretFile(file, "secret file"), /mode 600 or 400, is 644/);
  chmodSync(file, 0o600);
  assert.equal(readSecretFile(file, "secret file"), "x\n");
  assert.throws(() => readSecretFile(join(dir, "missing"), "secret file"), /secret file missing/);
});

test("a backend command is an absolute path, a ~/ path or a bare command name", () => {
  assert.deepEqual(parseConfig({ ...valid, backend: { command: ["trello-backend", "--x"] } }).backendCommand, ["trello-backend", "--x"]);
  assert.equal(parseConfig({ ...valid, backend: { command: ["/opt/backend"] } }).backendCommand[0], "/opt/backend");
  assert.ok(parseConfig(valid).backendCommand[0]?.startsWith("/"));
});


test("lanes keep their order, name skills without slash or plugin, and default to one slot", () => {
  const config = parseConfig({ ...valid, lanes: { reviews: { skills: ["/pr-review:review-pr"], slots: 2 }, general: { skills: ["*"] } } });
  assert.deepEqual(config.lanes, [
    { name: "reviews", skills: ["review-pr"], slots: 2 },
    { name: "general", skills: ["*"], slots: 1 },
  ]);
});

test("old keys (labels with their sandbox, intakeLabel) are ignored, so a config from before still loads", () => {
  const config = parseConfig({ ...valid, intakeLabel: "review-pr", labels: { x: { skill: "s", allowedTools: ["Read"], sandbox: { maskedEnv: [] } } } });
  assert.equal(config.intake.prompt, "/review-pr {url} --auto");
});
