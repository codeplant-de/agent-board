import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInstallPath, PluginError } from "../src/plugins.mts";

const file = { version: 2, plugins: { "pr-review@ccc": [{ scope: "user", installPath: "/home/u/.claude/plugins/cache/ccc/pr-review/abc" }] } };

test("the install path is read from installed_plugins.json", () => {
  assert.equal(parseInstallPath(file, "pr-review@ccc"), "/home/u/.claude/plugins/cache/ccc/pr-review/abc");
});

test("a missing, malformed or relative entry is refused", () => {
  for (const raw of [null, "x", {}, { plugins: {} }, { plugins: { "pr-review@ccc": [] } }, { plugins: { "pr-review@ccc": [{ installPath: "rel/path" }] } }, { plugins: { "pr-review@ccc": "nope" } }]) {
    assert.throws(() => parseInstallPath(raw, "pr-review@ccc"), PluginError);
  }
});
