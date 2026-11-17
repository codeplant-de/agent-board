import type { EventEmitter } from 'node:events';
import { isSafeMachineName, MACHINE_NAME_RULE } from '@agent-board/shared';
import { BackendError, requireFeature } from '../backend/backend.mts';
import { verifyContract } from '../backend/contract-check.mts';
import { realTimers } from '../backend/event-stream.mts';
import { loadWebConfig } from '../backend/web-config.mts';
import { ReportedFailure, UsageError } from '../cli.mts';
import type { LinkingContext } from '../cli.mts';
import { getPaths } from '../config/config.mts';
import { EVENT_TYPES } from '../events/diff.mts';
import type { BoardEvent, EventFilter, EventType } from '../events/diff.mts';
import { eventJson, eventLine } from '../events/format.mts';
import { runEvents } from '../events/run.mts';
import type { EventsDeps, EventsTarget } from '../events/run.mts';
import { createStyle } from '../output/style.mts';
import { parseStatus } from './board.mts';

// `--task`, `--status` and `--type` repeat, and commander hands every value over as a list.
export interface EventsFlags {
  task?: string[];
  status?: string[];
  type?: string[];
  machine?: string;
  json?: boolean;
}

export const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

function parseEventType(name: string): EventType {
  const found = EVENT_TYPES.find((type) => type === name.trim().toLowerCase());
  if (found === undefined)
    throw new UsageError(`unknown event type "${name.slice(0, 40)}"; use one of ${EVENT_TYPES.join(', ')}`);
  return found;
}

/** What `board events` prints: the flags as a filter. Tasks are resolved (ids, prefixes, links) by `resolveTask`, once. */
export async function parseEventsFilter(
  flags: EventsFlags,
  resolveTask: (arg: string) => Promise<string>,
): Promise<EventFilter> {
  const { machine } = flags;
  if (machine !== undefined && !isSafeMachineName(machine))
    throw new UsageError(`"${machine.slice(0, 40)}" is not a valid machine name: use ${MACHINE_NAME_RULE}`);
  return {
    tasks: await Promise.all((flags.task ?? []).map(resolveTask)),
    statuses: (flags.status ?? []).map(parseStatus),
    types: (flags.type ?? []).map(parseEventType),
    ...(machine === undefined ? {} : { machine }),
  };
}

export interface EventsCommand {
  flags: EventsFlags;
  context: LinkingContext;
  resolveTask: (arg: string) => Promise<string>;
  env: Record<string, string | undefined>;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  overrides: Partial<Pick<EventsDeps, 'verify' | 'fetch' | 'timers' | 'random' | 'signal' | 'options'>>;
  now: (() => Date) | undefined;
  // Where output goes, for its errors; the process's stdout unless a test hands one over.
  stdout?: Pick<EventEmitter, 'on' | 'off'>;
}

// Ends the run on Ctrl-C and SIGTERM, and when stdout fails under it. A closed pipe (`| head -1`: EPIPE) is no failure; any other
// write error (a full disk behind `> file`) is, and `failure()` returns it. Node and Bun report these as an `error` event, not a throw.
function stopOnSignalsAndFailedWrites(stdout: Pick<EventEmitter, 'on' | 'off'>): {
  signal: AbortSignal;
  release: () => void;
  failure: () => Error | undefined;
} {
  const stop = new AbortController();
  const names = ['SIGINT', 'SIGTERM'] as const;
  let failed: Error | undefined;
  const onSignal = (): void => stop.abort();
  const onStdoutError = (error: Error): void => {
    if ((error as { code?: string }).code !== 'EPIPE') failed ??= error;
    stop.abort();
  };
  for (const name of names) process.once(name, onSignal);
  stdout.on('error', onStdoutError);
  return {
    signal: stop.signal,
    release: () => {
      for (const name of names) process.off(name, onSignal);
      stdout.off('error', onStdoutError);
    },
    failure: () => failed,
  };
}

export async function runEventsCommand(command: EventsCommand): Promise<void> {
  const { flags, context, env, writeOut, writeErr, overrides } = command;
  const filter = await parseEventsFilter(flags, command.resolveTask);
  const verify =
    overrides.verify ??
    (async (): Promise<EventsTarget> => {
      const config = loadWebConfig(getPaths(env).configDir);
      const { features } = await verifyContract(config);
      requireFeature(features, 'events');
      return { ...config, features };
    });
  // Asking for notes of a board that cannot count them is a mistake to refuse, not a state to wait out.
  if (filter.types.includes('note')) {
    try {
      requireFeature((await verify()).features, 'task.note-count');
    } catch (error) {
      if (error instanceof BackendError && error.missingFeature === 'task.note-count') throw error;
    }
  }
  const style = createStyle(context.color === true);
  const emit = (event: BoardEvent): void =>
    writeOut(
      flags.json === true ? `${JSON.stringify(eventJson(event, context.taskLink))}\n` : `${eventLine(event, style)}\n`,
    );
  const signals =
    overrides.signal === undefined ? stopOnSignalsAndFailedWrites(command.stdout ?? process.stdout) : undefined;
  const code = await runEvents({
    timers: realTimers,
    random: Math.random,
    fetch: (url, init) => fetch(url, init),
    ...overrides,
    signal: overrides.signal ?? signals?.signal ?? new AbortController().signal,
    verify,
    log: (line) => writeErr(`board events: ${line}\n`),
    backend: context.backend,
    filter,
    emit,
    now: command.now ?? (() => new Date()),
  }).finally(() => signals?.release());
  const failure = signals?.failure();
  if (failure !== undefined) {
    writeErr(`board events: cannot write: ${failure.message}\n`);
    throw new ReportedFailure('board events ended', 1);
  }
  if (code !== 0) throw new ReportedFailure('board events ended', code);
}
