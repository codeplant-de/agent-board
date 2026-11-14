import type { Backend } from '@agent-board/shared';
import { UsageError } from './cli.mts';

export interface ResolveOptions {
  // A run's agent works on untrusted text: it addresses only the full id it was given, never a guess.
  inRun: boolean;
  // The board's URL, to recognise its task links; unset when it cannot be read.
  boardUrl?: (() => string) | undefined;
}

const FULL_ID_LENGTH = 8;
const MIN_PREFIX_LENGTH = 3;

function taskIdOfUrl(arg: string, boardUrl: (() => string) | undefined): string {
  let link: URL;
  let board: URL;
  try {
    link = new URL(arg);
    board = new URL(boardUrl?.() ?? '');
  } catch {
    throw new UsageError(`cannot tell whether "${arg.slice(0, 60)}" is a task of this board`);
  }
  const id = /^\/t\/([^/]+)\/?$/.exec(link.pathname)?.[1];
  if (link.origin !== board.origin || id === undefined)
    throw new UsageError(`"${arg.slice(0, 60)}" is not a task link of ${board.origin}`);
  return id;
}

function matchPrefix(candidates: { id: string; title: string }[], prefix: string, what: string): string {
  const wanted = prefix.toLowerCase();
  const matches = candidates.filter((candidate) => candidate.id.toLowerCase().startsWith(wanted));
  const [only, ...others] = matches;
  if (only === undefined) throw new UsageError(`no ${what} starts with "${prefix}"`);
  if (others.length === 0) return only.id;
  throw new UsageError(
    `"${prefix}" matches ${matches.length} ${what}s:\n${matches.map((match) => `  ${match.id}  ${match.title}`).join('\n')}`,
  );
}

function needsLookup(arg: string): boolean {
  return arg.length >= MIN_PREFIX_LENGTH && arg.length < FULL_ID_LENGTH;
}

// A full id costs no request; a board task link yields its id; a shorter prefix is matched against every task, closed ones included.
export async function resolveTaskId(backend: Backend, arg: string, options: ResolveOptions): Promise<string> {
  if (options.inRun) return arg;
  if (/^https?:\/\//i.test(arg)) return taskIdOfUrl(arg, options.boardUrl);
  if (arg.length < MIN_PREFIX_LENGTH)
    throw new UsageError(`"${arg}" is too short for a task id; give at least ${MIN_PREFIX_LENGTH} characters`);
  if (!needsLookup(arg)) return arg;
  return matchPrefix(await backend.listTasks({ all: true }), arg, 'task');
}

export async function resolveScheduleId(backend: Backend, arg: string, options: { inRun: boolean }): Promise<string> {
  if (options.inRun || !needsLookup(arg)) return arg;
  return matchPrefix(await backend.listSchedules(), arg, 'schedule');
}
