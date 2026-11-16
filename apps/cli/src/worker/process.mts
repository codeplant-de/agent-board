import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { isRecord } from '@agent-board/shared';
import { closeLog, openLog } from './logs.mts';
import type { Invocation, Supervision } from './plan.mts';

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  // Set when the watch stopped the run.
  stopped?: Exclude<Supervision, { kind: 'continue' }>;
}

// The worker's way to a running agent: its stdin.
export interface RunChannel {
  // Hands the agent a user message, which it takes up at its next tool boundary. False when stdin was closed already: nothing
  // was written.
  send: (text: string) => boolean;
  // Stops what the agent is doing at once; its session stays resumable, and a message sent after the interrupt carries the run on.
  interrupt: () => void;
  // Closes stdin: the agent exits once its turn is over. Nothing can be sent after that.
  end: () => void;
  // Interrupt, end, and kill the process if it is still there after the kill grace: what a stop decision does.
  stop: () => void;
  readonly open: boolean;
}

// Called every `everyMs` while the process runs; a stop decision interrupts it and closes its stdin, and kills it (SIGTERM, then
// SIGKILL) if it is still there `killGraceMs` later. A tick decides from the clock and the run's own files alone: the calls
// to the board it starts (liveness, transcript, inbox) run on their own, so a board that is slow, down or hostile cannot hold
// the run's limits back.
export interface Watch {
  everyMs: number;
  // Default: 30 seconds.
  killGraceMs?: number;
  // Called once the process runs, with the channel to it.
  start?: (channel: RunChannel) => void;
  tick: () => Promise<Supervision>;
}

// How long a stopped process has to exit on its own before it is killed.
const KILL_GRACE_MS = 30_000;

// A user message as `claude --input-format stream-json` reads it.
const userMessageLine = (text: string): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

const interruptLine = (): string =>
  `${JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })}\n`;

// Whether a line of the agent's output is the end of a turn.
function isResultLine(line: string): boolean {
  if (!line.includes('"result"')) return false;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) && parsed['type'] === 'result';
  } catch {
    return false;
  }
}

export function runProcess(
  invocation: Invocation,
  taskId: string,
  env: Record<string, string>,
  watch: Watch,
  onLine: (line: string) => string | undefined = (line) => line,
): Promise<RunResult> {
  const fd = openLog(taskId);
  return new Promise((resolve, reject) => {
    // A new process group, so a stop also ends what the worker started. stdout comes here, line by line; stderr goes
    // straight into the log.
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ['pipe', 'pipe', fd],
      detached: true,
      env: { ...process.env, ...env },
    });
    // A process that exits without reading its stdin must not take the worker down.
    child.stdin?.on('error', () => undefined);
    let ended = false;
    let stopping = false;
    let killTimer: NodeJS.Timeout | undefined;
    // An interrupt is out and its turn has not ended yet; `carryOn`: a message was sent after it, so the run goes on.
    let interruptOut = false;
    let carryOn = false;
    const channel: RunChannel = {
      get open() {
        return !ended;
      },
      send(text) {
        if (ended) return false;
        child.stdin?.write(userMessageLine(text));
        if (interruptOut) carryOn = true;
        return true;
      },
      interrupt() {
        if (ended) return;
        child.stdin?.write(interruptLine());
        interruptOut = true;
      },
      end() {
        if (ended) return;
        ended = true;
        child.stdin?.end();
      },
      stop() {
        // The agent is asked to stop first, so that its session ends cleanly and stays resumable.
        channel.interrupt();
        channel.end();
        stopping = true;
        killTimer ??= setTimeout(terminate, watch.killGraceMs ?? KILL_GRACE_MS);
        killTimer.unref();
      },
    };
    // The prompt goes in on stdin, never in argv, and stdin stays open for what follows.
    child.stdin?.write(userMessageLine(invocation.prompt));
    let buffered = '';
    const emit = (line: string): void => {
      const text = onLine(line);
      if (text !== undefined) writeSync(fd, `${text}\n`);
      // The turn is over and nothing is waiting to be written: close stdin, and the agent exits.
      if (!isResultLine(line)) return;
      if (interruptOut) {
        interruptOut = false;
        if (carryOn) {
          carryOn = false;
          return;
        }
      }
      channel.end();
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        emit(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    });
    let stopped: RunResult['stopped'];
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    const terminate = (): void => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 10_000).unref();
    };
    let checking = false;
    const timer = setInterval(() => {
      if (checking || stopped) return;
      checking = true;
      watch
        .tick()
        .then((decision) => {
          if (decision.kind === 'continue' || stopped) return;
          stopped = decision;
          channel.stop();
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, watch.everyMs);
    // On a spawn failure both "error" and "close" fire.
    let finished = false;
    const finish = (): boolean => {
      if (finished) return false;
      finished = true;
      clearInterval(timer);
      clearTimeout(killTimer);
      ended = true;
      if (buffered !== '') emit(buffered);
      closeLog(fd);
      return true;
    };
    child.on('error', (error) => {
      if (!finish()) return;
      reject(new Error(`could not start ${invocation.command}: ${error.message}`));
    });
    child.on('close', (exitCode, signal) => {
      if (!finish()) return;
      // What a stopped agent left running goes with it.
      if (stopping) terminate();
      resolve(stopped ? { exitCode, signal, stopped } : { exitCode, signal });
    });
    watch.start?.(channel);
  });
}
