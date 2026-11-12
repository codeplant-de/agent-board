// The `--settings` for a skill run: Claude Code's Bash sandbox (bubblewrap on Linux), derived from the label's
// `sandbox` entry. Docs: https://code.claude.com/docs/en/sandboxing and .../settings-reference (sandbox).
import { join } from "node:path";
import type { SandboxEntry } from "./config.mts";

export const CWD_PLACEHOLDER = "{cwd}";
export const PLUGIN_PLACEHOLDER = "{pr-review}";

export interface SandboxInput {
  entry: SandboxEntry;
  cwd: string;
  // Install path of the pr-review plugin; undefined when it could not be resolved.
  prReviewPath: string | undefined;
  // Names directly inside the checkout, `.git` included. They become read-only; see below.
  checkoutEntries: string[];
}

export function usesPlaceholder(entry: SandboxEntry, placeholder: string): boolean {
  return [...entry.allowRead, ...entry.allowWrite, ...entry.excludedCommands].some((value) => value.includes(placeholder));
}

function expand(value: string, input: SandboxInput): string {
  const withCwd = value.replaceAll(CWD_PLACEHOLDER, input.cwd);
  return input.prReviewPath === undefined ? withCwd : withCwd.replaceAll(PLUGIN_PLACEHOLDER, input.prReviewPath);
}

export function buildSandboxSettings(input: SandboxInput): Record<string, unknown> {
  const { entry, cwd } = input;
  const masked = entry.maskedEnv;
  return {
    sandbox: {
      enabled: true,
      // No sandbox, no run: a missing bubblewrap or socat must not mean an unconfined reviewer.
      failIfUnavailable: true,
      // Without these two the allow list would not bind: by default every sandboxed command is approved, and the
      // model may ask to leave the sandbox.
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      excludedCommands: entry.excludedCommands.map((command) => expand(command, input)),
      filesystem: {
        // The home directory is closed except for what is listed: credentials in ~/.config, ~/.ssh, ~/.aws,
        // ~/.gnupg, ~/.claude and the rest cannot be read by name or by guess.
        denyRead: ["~/"],
        allowRead: [cwd, ...entry.allowRead.map((path) => expand(path, input))],
        // The sandbox's default write access is the whole checkout, and a deny on the checkout itself breaks the
        // sandbox's mounts. So everything in it but `.git` (needed by git) is denied by name.
        allowWrite: [join(cwd, ".git"), "/tmp", ...entry.allowWrite.map((path) => expand(path, input))],
        denyWrite: input.checkoutEntries.filter((name) => name !== ".git").map((name) => join(cwd, name)),
      },
      network: {
        allowedDomains: entry.allowedDomains,
        // The proxy has to read requests to put a masked value into them.
        ...(masked.length > 0 ? { tlsTerminate: {} } : {}),
      },
      credentials: { envVars: masked.map((env) => ({ name: env.name, mode: "mask", injectHosts: env.injectHosts })) },
    },
  };
}
