import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSandboxSettings } from "../src/sandbox.mts";
import type { SandboxEntry } from "../src/config.mts";

const entry: SandboxEntry = {
  allowRead: ["{pr-review}", "/home/u/.local/state/pr-review"],
  allowWrite: ["/home/u/.local/state/pr-review"],
  allowedDomains: ["api.github.com"],
  excludedCommands: ["board *", "{pr-review}/x.sh *"],
  maskedEnv: [{ name: "GH_TOKEN", command: ["gh", "auth", "token"], injectHosts: ["api.github.com"] }],
};
const input = { entry, cwd: "/work/repo", prReviewPath: "/plugins/pr", checkoutEntries: [".git", "src", "package.json"] };

function settings(overrides: Partial<typeof input> = {}): Record<string, unknown> {
  const sandbox = buildSandboxSettings({ ...input, ...overrides })["sandbox"];
  assert.ok(typeof sandbox === "object" && sandbox !== null && !Array.isArray(sandbox));
  return Object.fromEntries(Object.entries(sandbox));
}

test("the sandbox is required, closed to the home directory, and cannot be left or bypass the allow list", () => {
  const sandbox = settings();
  assert.equal(sandbox["enabled"], true);
  assert.equal(sandbox["failIfUnavailable"], true, "no sandbox, no run");
  assert.equal(sandbox["allowUnsandboxedCommands"], false);
  assert.equal(sandbox["autoAllowBashIfSandboxed"], false, "otherwise dontAsk approves every sandboxed command");
  assert.deepEqual(sandbox["filesystem"], {
    denyRead: ["~/"],
    allowRead: ["/work/repo", "/plugins/pr", "/home/u/.local/state/pr-review"],
    allowWrite: ["/work/repo/.git", "/tmp", "/home/u/.local/state/pr-review"],
    denyWrite: ["/work/repo/src", "/work/repo/package.json"],
  });
});

test("the placeholders expand in the commands that run outside the sandbox", () => {
  assert.deepEqual(settings()["excludedCommands"], ["board *", "/plugins/pr/x.sh *"]);
});

test("a masked variable is masked for its hosts only, and the proxy may read the traffic", () => {
  const sandbox = settings();
  assert.deepEqual(sandbox["credentials"], { envVars: [{ name: "GH_TOKEN", mode: "mask", injectHosts: ["api.github.com"] }] });
  assert.deepEqual(sandbox["network"], { allowedDomains: ["api.github.com"], tlsTerminate: {} });
  const none = settings({ entry: { ...entry, maskedEnv: [] } });
  assert.deepEqual(none["network"], { allowedDomains: ["api.github.com"] });
});

test("the settings never carry a secret value", () => {
  assert.doesNotMatch(JSON.stringify(settings()), /ghp_|gho_|token\b.*[A-Za-z0-9]{20}/);
});
