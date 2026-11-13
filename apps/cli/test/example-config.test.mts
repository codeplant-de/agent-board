import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildInvocation, expandRule } from "../src/decide.mts";
import { parseConfig } from "../src/config.mts";
import { task } from "./helpers.mts";

const FRESH = { kind: "fresh", sessionId: "s1" } as const;

const raw: unknown = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
const config = parseConfig(raw);
// Intake reviews run unattended on PR text: these are the only rules with a job to do.
const entry = config.intake;

test("no shipped rule starts with a wildcard before a path", () => {
  for (const rule of [...entry.allowedTools, ...entry.disallowedTools]) assert.doesNotMatch(rule, /^Bash\(\*/);
});

test("git cannot be made to write files, and secrets are denied", () => {
  const secrets = ["~/.config/**", "~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.kube/**", "~/.docker/**", "~/.netrc", "~/.claude/.credentials.json", "**/.env*"].map((path) => `Read(${path})`);
  for (const rule of ["Bash(git log *--output*)", "Bash(git show *--output*)", "Bash(git diff *--output*)", "Bash(git diff *--no-index*)", "Bash(git fetch *:**)", "Bash(git fetch *--up*)", ...secrets]) {
    assert.ok(entry.disallowedTools.includes(rule), rule);
  }
  for (const rule of ["Bash(jq *)", "Bash(brain notes append *)"]) assert.ok(!entry.allowedTools.includes(rule), rule);
});

test("the plugin placeholder resolves in every shipped script rule", () => {
  const plan = buildInvocation({ run: FRESH, task: task({ id: "a", input: "/review-pr https://github.com/cosuno/cosuno/pull/1 --auto", createdBy: "intake" }), repos: config.repos, defaultCwd: "/", intake: entry, home: "/h", prReviewPath: "/p" });
  assert.ok(plan.ok);
  assert.ok(plan.invocation.args.every((arg) => !arg.includes("{pr-review}")));
  assert.equal(expandRule("Bash({pr-review}/skills/a.sh *)", "/h", "/p"), "Bash(/p/skills/a.sh *)");
});

test("the reviewer may write its findings file in /tmp, with the rule form Claude Code 2.1.322 honours for the Write tool", () => {
  assert.ok(entry.allowedTools.includes("Edit(//tmp/pr-*)"));
  assert.ok(!entry.allowedTools.some((rule) => rule.startsWith("Write(")), "Write(...) rules are not honoured; Edit(...) rules cover the Write tool");
});

test("no rule ends in the legacy `:*` prefix syntax after a wildcard, which Claude Code would match as a literal", () => {
  const rules = [...entry.allowedTools, ...entry.disallowedTools];
  for (const rule of rules) assert.ok(!/\*.*:\*\)?$/.test(rule), rule);
});

test("the shipped lanes give reviews their own slots and everything else three", () => {
  assert.deepEqual(config.lanes.map((lane) => [lane.name, lane.skills, lane.slots]), [
    ["reviews", ["review-pr"], 2],
    ["general", ["*"], 3],
  ]);
  assert.equal(entry.prompt, "/review-pr {url} --auto");
});
