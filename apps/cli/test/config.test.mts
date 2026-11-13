import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, isSafeMode, parseConfig, readSecretFile } from "../src/config.mts";

const valid = {
  backend: { command: ["~/bin/backend", "--flag"] },
  repos: { "cosuno/cosuno": "~/x" },
  labels: {
    selftest: { command: ["sleep", "300"] },
    "review-pr": { skill: "board-review-pr", allowedTools: ["Read"] },
  },
};

test("a valid config gets defaults and normalised label entries", () => {
  const config = parseConfig(valid);
  assert.equal(config.maxParallel, 2);
  assert.equal(config.backendCommand[1], "--flag");
  assert.ok(!config.backendCommand[0]?.startsWith("~"));
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
    [{ ...valid, backend: undefined }, /backend.command/],
    [{ ...valid, backend: { command: [] } }, /backend.command/],
    [{ ...valid, backend: { command: ["ok", 3] } }, /backend.command/],
    [{ ...valid, labels: {} }, /labels/],
    [{ ...valid, maxParallel: 0 }, /maxParallel/],
    [{ ...valid, labels: { x: { skill: "s", allowedTools: [] } } }, /allowedTools must not be empty/],
    [{ ...valid, labels: { x: { command: [] } } }, /command/],
    [{ ...valid, labels: { x: { skill: "s" } } }, /allowedTools/],
    [{ ...valid, repos: { bad: "/x" } }, /owner\/name/],
    [{ ...valid, repos: {} }, /repos must not be empty/],
    [{ ...valid, backend: { command: ["bin/backend"] } }, /backend.command\[0\] must be an absolute path/],
    [{ ...valid, backend: { command: ["./backend"] } }, /backend.command\[0\] must be an absolute path/],
    [{ ...valid, backend: { command: ["../backend"] } }, /backend.command\[0\] must be an absolute path/],
    [{ ...valid, labels: { x: { skill: "s", allowedTools: ["Read"], sandbox: { allowRead: "x" } } } }, /sandbox.allowRead must be a list/],
    [{ ...valid, labels: { x: { skill: "s", allowedTools: ["Read"], sandbox: { allowWrte: [] } } } }, /allowWrte is not a sandbox key/],
    [{ ...valid, labels: { x: { skill: "s", allowedTools: ["Read"], sandbox: { maskedEnv: [{ name: "gh token", command: ["gh"], injectHosts: ["a.com"] }] } } } }, /name must be an environment variable name/],
    [{ ...valid, labels: { x: { skill: "s", allowedTools: ["Read"], sandbox: { maskedEnv: [{ name: "GH_TOKEN", command: ["gh"], injectHosts: [] }] } } } }, /injectHosts must be a non-empty list/],
    [{ ...valid, labels: { x: { skill: "s", allowedTools: ["Read"], sandbox: { maskedEnv: [{ name: "GH_TOKEN", command: ["bin/gh"], injectHosts: ["a.com"] }] } } } }, /maskedEnv\[0\].command\[0\] must be an absolute path/],
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

test("a skill label's sandbox entry is parsed, with ~/ expanded in paths and the masked command", () => {
  const raw = {
    ...valid,
    labels: {
      "review-pr": {
        skill: "s",
        allowedTools: ["Read"],
        sandbox: {
          allowRead: ["~/state", "{pr-review}"],
          allowWrite: ["~/state"],
          allowedDomains: ["api.github.com"],
          excludedCommands: ["board *"],
          maskedEnv: [{ name: "GH_TOKEN", command: ["gh", "auth", "token"], injectHosts: ["api.github.com"] }],
        },
      },
    },
  };
  const entry = parseConfig(raw).labels["review-pr"];
  assert.ok(entry?.kind === "skill" && entry.sandbox);
  assert.ok(entry.sandbox.allowRead[0]?.startsWith("/") && entry.sandbox.allowRead[0].endsWith("/state"));
  assert.equal(entry.sandbox.allowRead[1], "{pr-review}");
  assert.deepEqual(entry.sandbox.maskedEnv[0]?.command, ["gh", "auth", "token"]);
  assert.deepEqual(entry.sandbox.excludedCommands, ["board *"]);
});

test("intake tasks are normal unless the config says otherwise", () => {
  assert.equal(parseConfig(valid).intakePriority, "normal");
  assert.equal(parseConfig({ ...valid, intakePriority: "high" }).intakePriority, "high");
  assert.throws(() => parseConfig({ ...valid, intakePriority: "asap" }), /intakePriority must be one of urgent, high, normal, low/);
});
