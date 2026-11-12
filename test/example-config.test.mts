import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildInvocation, expandRule } from "../src/decide.mts";
import { parseConfig } from "../src/config.mts";
import { task } from "./helpers.mts";

const raw: unknown = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
const config = parseConfig(raw);
const entry = config.labels["review-pr"];

test("no shipped rule starts with a wildcard before a path", () => {
  assert.ok(entry?.kind === "skill");
  for (const rule of [...entry.allowedTools, ...entry.disallowedTools]) assert.doesNotMatch(rule, /^Bash\(\*/);
});

test("git cannot be made to write files, and secrets are denied", () => {
  assert.ok(entry?.kind === "skill");
  const secrets = ["~/.config/**", "~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.kube/**", "~/.docker/**", "~/.netrc", "~/.claude/.credentials.json", "**/.env*"].map((path) => `Read(${path})`);
  for (const rule of ["Bash(git log *--output*)", "Bash(git show *--output*)", "Bash(git diff *--output*)", "Bash(git diff *--no-index*)", "Bash(git fetch *:*)", "Bash(git fetch *--upload-pack*)", ...secrets]) {
    assert.ok(entry.disallowedTools.includes(rule), rule);
  }
  for (const rule of ["Bash(jq *)", "Bash(brain notes append *)"]) assert.ok(!entry.allowedTools.includes(rule), rule);
});

test("the plugin placeholder resolves in every shipped script rule", () => {
  assert.ok(entry?.kind === "skill");
  const plan = buildInvocation({ entry, task: task({ id: "a", input: "https://github.com/cosuno/cosuno/pull/1" }), repos: config.repos, home: "/h", fallbackCwd: "/", prReviewPath: "/p", listDir: () => [] });
  assert.ok(plan.ok);
  assert.ok(plan.invocation.args.every((arg) => !arg.includes("{pr-review}")));
  assert.equal(expandRule("Bash({pr-review}/skills/a.sh *)", "/h", "/p"), "Bash(/p/skills/a.sh *)");
});

test("the reviewer's sandbox hides the credentials and lets only what needs them run outside it", () => {
  assert.ok(entry?.kind === "skill" && entry.sandbox);
  const { sandbox } = entry;
  // Outside the sandbox: what reads a credential the sandbox hides. Everything else, scripts included, is confined.
  assert.deepEqual(sandbox.excludedCommands, ["board *", "git fetch origin *"]);
  // Both are allowed tools, or excluding them would be meaningless.
  for (const command of sandbox.excludedCommands) assert.ok(entry.allowedTools.includes(`Bash(${command})`), command);
  assert.deepEqual(sandbox.maskedEnv.map((env) => [env.name, env.injectHosts]), [["GH_TOKEN", ["api.github.com"]]]);
  assert.deepEqual(sandbox.allowedDomains, ["api.github.com"]);
  // Never excluded: a script or a shell that takes a file or a command as an argument.
  for (const command of sandbox.excludedCommands) assert.doesNotMatch(command, /\.sh|^(sh|bash|node|gh)\b/);
  assert.ok(entry.allowedTools.every((rule) => !/^Bash\((sh|bash|node|cat|env) /.test(rule)));
});

test("the reviewer may write its findings file in /tmp, with the rule form Claude Code 2.1.322 honours for the Write tool", () => {
  assert.ok(entry?.kind === "skill");
  assert.ok(entry.allowedTools.includes("Edit(//tmp/pr-*)"));
  assert.ok(!entry.allowedTools.some((rule) => rule.startsWith("Write(")), "Write(...) rules are not honoured; Edit(...) rules cover the Write tool");
});

test("the sandbox derived from the shipped entry denies the home directory and keeps the checkout read-only except .git", () => {
  assert.ok(entry?.kind === "skill");
  const plan = buildInvocation({ entry, task: task({ id: "a", input: "https://github.com/cosuno/cosuno/pull/1" }), repos: { "cosuno/cosuno": "/work/c" }, home: "/h", fallbackCwd: "/", prReviewPath: "/p", listDir: () => [".git", "api", "frontend"] });
  assert.ok(plan.ok);
  const { args } = plan.invocation;
  const settings = JSON.stringify(JSON.parse(args[args.indexOf("--settings") + 1] ?? ""));
  assert.match(settings, /"denyRead":\["~\/"\]/);
  assert.match(settings, /"denyWrite":\["\/work\/c\/api","\/work\/c\/frontend"\]/);
  assert.match(settings, /"allowWrite":\["\/work\/c\/\.git","\/tmp",/);
  assert.match(settings, /"autoAllowBashIfSandboxed":false/);
});
