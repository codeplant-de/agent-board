// Asks `claude` which skills and models this machine has: starts it in a directory like a worker would, sends the one control
// request the Agent SDK uses to initialise a session, and reads the answer. No prompt is sent, so no model is called and no
// session is written. The `initialize` request is not a documented CLI interface; it was checked against Claude Code 2.1.326,
// and anything else in the answer than the shape read here makes the probe return nothing.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cleanCatalogText,
  isModelName,
  isRecord,
  isSafeSkillName,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_HINT_CHARS,
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
  MAX_CATALOG_VERSION_CHARS,
} from '@agent-board/shared';
import type { CatalogModel } from '@agent-board/shared';

/** What a worker runs: the same program and the same lookup on the PATH. */
export const CLAUDE_COMMAND = 'claude';

export const PROBE_TIMEOUT_MS = 30_000;
// How long a probe that has its answer, or ran out of time, waits for the process to end before it is killed.
export const EXIT_GRACE_MS = 3000;
// A cap for the cache file, not for the board: the commands of a directory with a great many plugins.
const MAX_PROBED_COMMANDS = 2000;

/** A command `claude` lists: a skill, a plugin's, or one of its own (`builtin`, of which only those a run reports are skills). */
export interface ProbedCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  builtin: boolean;
}

/** What one probe found, cleaned: commands with a safe skill name only, and models other than `default`. */
export interface ProbeResult {
  claude?: string;
  models: CatalogModel[];
  commands: ProbedCommand[];
}

// The part of a child process the probe uses, so that a test supplies its own.
export interface ProbeProcess {
  stdin: {
    write: (text: string) => unknown;
    end: () => unknown;
    on: (event: 'error', listener: () => void) => unknown;
  };
  stdout: {
    setEncoding: (encoding: 'utf8') => unknown;
    on: (event: 'data', listener: (chunk: string) => void) => unknown;
  };
  on: (event: 'error' | 'close', listener: () => void) => unknown;
  // Signals the process and what it started.
  kill: (signal: 'SIGTERM' | 'SIGKILL') => void;
}

export type ProbeSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ProbeProcess;

/** Starts a process of its own group, so that killing it also ends what a SessionStart hook started. */
export const spawnProbe: ProbeSpawn = (command, args, { cwd, env }) => {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    on: (event, listener) => child.on(event, listener),
    kill: (signal) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    },
  };
};

// The options only: the request goes in on stdin, and none of a run's options (a session, a model, hooks, permissions). With
// `--strict-mcp-config` and no `--mcp-config`, no MCP server starts: the probe drops MCP prompts anyway.
const PROBE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--strict-mcp-config',
];

const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = cleanCatalogText(value, max);
  return text === '' ? undefined : text;
};

function readCommand(entry: unknown): ProbedCommand[] {
  if (!isRecord(entry)) return [];
  const { name } = entry;
  if (typeof name !== 'string' || !isSafeSkillName(name)) return [];
  const description = cleanText(entry['description'], MAX_CATALOG_DESCRIPTION_CHARS);
  const argumentHint = cleanText(entry['argumentHint'], MAX_CATALOG_HINT_CHARS);
  return [
    {
      name,
      ...(description === undefined ? {} : { description }),
      ...(argumentHint === undefined ? {} : { argumentHint }),
      builtin: entry['builtin'] === true,
    },
  ];
}

function readModel(entry: unknown): CatalogModel[] {
  if (!isRecord(entry)) return [];
  const { value } = entry;
  if (typeof value !== 'string' || value === 'default' || !isModelName(value)) return [];
  const description = cleanText(entry['description'], MAX_CATALOG_DESCRIPTION_CHARS);
  return [
    {
      value,
      // `displayName` in an answer of claude, `label` in what the cache stored of one.
      label: cleanText(entry['displayName'] ?? entry['label'], MAX_CATALOG_LABEL_CHARS) ?? value,
      ...(description === undefined ? {} : { description }),
    },
  ];
}

/** What the answer of `initialize` says, cleaned; undefined when it is not shaped like one (no `commands` list). */
export function readProbeAnswer(payload: unknown): ProbeResult | undefined {
  if (!isRecord(payload) || !Array.isArray(payload['commands'])) return undefined;
  const models: unknown = payload['models'] ?? [];
  if (!Array.isArray(models)) return undefined;
  const commands: unknown[] = payload['commands'];
  const claude = cleanText(payload['claude_code_version'], MAX_CATALOG_VERSION_CHARS);
  return {
    ...(claude === undefined ? {} : { claude }),
    models: models.flatMap(readModel).slice(0, MAX_CATALOG_MODELS),
    commands: commands.flatMap(readCommand).slice(0, MAX_PROBED_COMMANDS),
  };
}

// The payload of the control response to `requestId` in a line of output, or undefined for any other line.
function answerIn(line: string, requestId: string): { payload: unknown } | { failed: true } | undefined {
  if (!line.includes('control_response')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed['type'] !== 'control_response') return undefined;
  const response = parsed['response'];
  if (!isRecord(response) || response['request_id'] !== requestId) return undefined;
  return response['subtype'] === 'success' ? { payload: response['response'] } : { failed: true };
}

export interface ProbeDeps {
  spawn?: ProbeSpawn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  exitGraceMs?: number;
}

/**
 * Asks `claude` in `cwd` for its skills and models; undefined when it does not answer in time, exits, cannot start or answers
 * something else. Never throws. The process and its group are gone when this returns.
 */
export function probeClaude(cwd: string, deps: ProbeDeps = {}): Promise<ProbeResult | undefined> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let child: ProbeProcess;
    try {
      child = (deps.spawn ?? spawnProbe)(CLAUDE_COMMAND, PROBE_ARGS, { cwd, env: deps.env ?? process.env });
    } catch {
      resolve(undefined);
      return;
    }
    let buffered = '';
    let outcome: ProbeResult | undefined;
    let ended = false;
    let killTimer: NodeJS.Timeout | undefined;
    // The answer is in, or time is up: stdin closes, the process gets SIGTERM, and SIGKILL when it is still there after the grace.
    const end = (result: ProbeResult | undefined): void => {
      if (ended) return;
      ended = true;
      outcome = result;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(outcome);
      }, deps.exitGraceMs ?? EXIT_GRACE_MS);
    };
    const timer = setTimeout(() => end(undefined), deps.timeoutMs ?? PROBE_TIMEOUT_MS);
    child.stdin.on('error', () => undefined);
    child.on('error', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      // `claude` is gone, but a process of its group may have ignored the SIGTERM.
      child.kill('SIGKILL');
      resolve(outcome);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (ended) return;
      buffered += chunk;
      for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
        const answer = answerIn(buffered.slice(0, newline), requestId);
        buffered = buffered.slice(newline + 1);
        if (answer === undefined) continue;
        end('payload' in answer ? readProbeAnswer(answer.payload) : undefined);
        return;
      }
    });
    child.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })}\n`,
    );
  });
}
