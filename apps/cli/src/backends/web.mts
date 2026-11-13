#!/usr/bin/env node
/**
 * The web backend: implements the backend contract (see README) against the board server's machine API.
 * The server URL comes from web.json next to config.json, the machine token (AGENT_BOARD_TOKEN) from the env file.
 *
 *   web-backend version | list-tasks [--all] | get-task <id> | add-task | update-task <id> | claim-task <id> --machine <name>
 *               | add-note <id> [--author agent|system] | ask <id> | heartbeat <id> | pause <id> | read-notes <id> | setup [--dry-run]
 *
 * Every subcommand is one POST to <url>/api/machine/<subcommand>; the server does the work in one transaction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAIM_LOST_EXIT, CONTRACT_VERSION, ContractError, isRecord, isSafeMachineName, isSafeTaskId, UNKNOWN_COMMAND_EXIT } from "@agent-board/shared";
import { ConfigError, getPaths } from "../config.mts";
import { loadEnvFile } from "../env-file.mts";

const REQUEST_TIMEOUT_MS = 45_000;

export class WebError extends Error {
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface WebConfig {
  url: string;
  token: string;
}

export function parseWebConfig(raw: unknown, env: Record<string, string>): WebConfig {
  if (!isRecord(raw)) throw new ConfigError("web.json: top level must be an object");
  const url = raw["url"];
  if (typeof url !== "string" || !/^https?:\/\/[^\s/]+/.test(url)) throw new ConfigError("web.json: url must be the board's http(s) URL");
  // Plain http only to this machine: the token must not cross a network in the clear.
  if (url.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)) {
    throw new ConfigError("web.json: url must use https unless it is localhost");
  }
  const token = env["AGENT_BOARD_TOKEN"];
  if (!token) throw new ConfigError("the credentials file needs AGENT_BOARD_TOKEN (create one on the board's Settings page)");
  return { url: url.replace(/\/+$/, ""), token };
}

export function loadWebConfig(configDir: string): WebConfig {
  const path = join(configDir, "web.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(error instanceof SyntaxError ? `web.json is not valid JSON: ${path}` : `web.json missing: ${path}`);
  }
  return parseWebConfig(raw, loadEnvFile(join(configDir, "env")));
}

export interface MachineRequest {
  id?: string;
  all?: boolean;
  dryRun?: boolean;
  machine?: string;
  author?: string;
  // The subcommand's stdin: JSON for add-task, update-task, ask and setup; the text for add-note.
  body?: unknown;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// One request. A non-2xx answer is a WebError with the server's one-line reason; the token is never part of a message.
export async function callServer(config: WebConfig, command: string, request: MachineRequest, fetcher: Fetch = fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`${config.url}/api/machine/${command}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    throw new WebError(`cannot reach ${config.url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // A login page or a proxy error, not the API.
    throw new WebError(`${command}: the server answered ${response.status} without JSON (is /api/machine routed past the login?)`, response.status);
  }
  if (!response.ok) {
    const reason = isRecord(payload) && typeof payload["error"] === "string" ? payload["error"] : `HTTP ${response.status}`;
    throw new WebError(`${command}: ${reason}`, response.status);
  }
  if (!isRecord(payload) || !("result" in payload)) throw new WebError(`${command}: the answer has no result`);
  return payload["result"];
}

async function readStdin(): Promise<string> {
  let content = "";
  for await (const chunk of process.stdin) content += String(chunk);
  return content;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ContractError(`${what} on stdin is not valid JSON`);
  }
}

// Turns argv and stdin into the request; refuses anything the contract does not allow before a byte leaves.
export async function buildRequest(command: string, args: string[], stdin: () => Promise<string>): Promise<MachineRequest> {
  const usage = (shape: string): never => {
    throw new ContractError(`usage: ${command} ${shape}`.trim());
  };
  const id = (value: string | undefined, shape: string): string => {
    if (value === undefined || !isSafeTaskId(value)) return usage(shape);
    return value;
  };
  switch (command) {
    case "list-tasks":
      if (args.length > 1 || (args.length === 1 && args[0] !== "--all")) usage("[--all]");
      return { all: args[0] === "--all" };
    case "get-task":
    case "read-notes":
      if (args.length !== 1) usage("<id>");
      return { id: id(args[0], "<id>") };
    case "add-task":
      if (args.length > 0) usage("");
      return { body: parseJson(await stdin(), "draft") };
    case "update-task":
    case "ask":
    case "heartbeat":
    case "transcript":
      if (args.length !== 1) usage("<id>");
      return { id: id(args[0], "<id>"), body: parseJson(await stdin(), command) };
    case "pause": {
      if (args.length !== 1) usage("<id>");
      const note = await stdin();
      if (note.trim() === "") throw new ContractError("pause note on stdin is empty");
      return { id: id(args[0], "<id>"), body: note };
    }
    case "claim-task": {
      const [taskId, flag, machine] = args;
      if (args.length !== 3 || flag !== "--machine" || machine === undefined || !isSafeMachineName(machine)) usage("<id> --machine <name>");
      return { id: id(taskId, "<id> --machine <name>"), machine };
    }
    case "add-note": {
      const [taskId, flag, author] = args;
      if (!(args.length === 1 || (args.length === 3 && flag === "--author" && (author === "agent" || author === "system")))) usage("<id> [--author agent|system]");
      const text = await stdin();
      if (text.trim() === "") throw new ContractError("note text on stdin is empty");
      return { id: id(taskId, "<id>"), author: author ?? "agent", body: text };
    }
    case "setup":
      if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) usage("[--dry-run]");
      return { dryRun: args[0] === "--dry-run", body: parseJson(await stdin(), "setup request") };
    default:
      return usage("");
  }
}

const COMMANDS = ["list-tasks", "get-task", "add-task", "update-task", "claim-task", "add-note", "ask", "heartbeat", "pause", "transcript", "read-notes", "setup"];

export async function main(argv: string[], fetcher: Fetch = fetch): Promise<number> {
  const [command, ...args] = argv;
  if (command === "version") {
    console.log(JSON.stringify({ contract: CONTRACT_VERSION }));
    return 0;
  }
  if (command === undefined || !COMMANDS.includes(command)) {
    console.error(`web-backend: unknown command "${command ?? ""}"`);
    return UNKNOWN_COMMAND_EXIT;
  }
  const request = await buildRequest(command, args, readStdin);
  const config = loadWebConfig(getPaths().configDir);
  try {
    const result = await callServer(config, command, request, fetcher);
    // add-note, ask and heartbeat print nothing; everything else prints its result.
    if (!["add-note", "ask", "heartbeat", "transcript"].includes(command)) console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    // A lost claim is an answer, not a failure: the core moves on to the next task.
    if (command === "claim-task" && error instanceof WebError && error.status === 409) {
      console.error(`web-backend: ${error.message}`);
      return CLAIM_LOST_EXIT;
    }
    throw error;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const expected = error instanceof ConfigError || error instanceof WebError || error instanceof ContractError;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`web-backend: ${expected ? message : `unexpected error: ${message}`}`);
    process.exitCode = 1;
  }
}
