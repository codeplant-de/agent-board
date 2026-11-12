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
  for (const rule of ["Bash(git log *--output*)", "Bash(git show *--output*)", "Bash(git diff *--output*)", "Bash(git diff *--no-index*)", "Bash(git fetch *:*)", "Read(~/.config/**)", "Read(~/.ssh/**)", "Read(**/.env*)"]) {
    assert.ok(entry.disallowedTools.includes(rule), rule);
  }
  for (const rule of ["Bash(jq *)", "Bash(brain notes append *)"]) assert.ok(!entry.allowedTools.includes(rule), rule);
});

test("the plugin placeholder resolves in every shipped script rule", () => {
  assert.ok(entry?.kind === "skill");
  const plan = buildInvocation({ entry, task: task({ id: "a", input: "https://github.com/cosuno/cosuno/pull/1" }), repos: config.repos, home: "/h", fallbackCwd: "/", prReviewPath: "/p" });
  assert.ok(plan.ok);
  assert.ok(plan.invocation.args.every((arg) => !arg.includes("{pr-review}")));
  assert.equal(expandRule("Bash({pr-review}/skills/a.sh *)", "/h", "/p"), "Bash(/p/skills/a.sh *)");
});
