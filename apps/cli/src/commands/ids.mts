import type { Backend } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { plainLine } from '../output/terminal.mts';

export interface ResolveOptions {
  // A run's agent works on untrusted text: it addresses only the full id it was given, never a guess.
  inRun: boolean;
  // How a link of this machine's board starts (`<web.json url>/t/`), asked only when a link is given.
  boardLinkPrefix?: () => string;
}

// A task's id is 12 characters (clients choose them now) or 8 (older tasks): either is taken as a whole id, anything
// shorter or in between as the start of one. So the first 8 characters of a 12-character id read as a whole, unknown id.
const FULL_ID_LENGTHS = [8, 12];
const LONGEST_PREFIX = 11;
const MIN_PREFIX_LENGTH = 3;

// Every link the CLI prints is `<web.json url>/t/<id>` (the board sends none), so a link counts only when it starts with
// that: another origin most likely means another board that has the same ids, such as a restored dump on localhost.
function taskIdOfUrl(arg: string, boardLinkPrefix: (() => string) | undefined): string {
  let prefix: string;
  try {
    prefix = boardLinkPrefix?.() ?? '';
  } catch {
    throw new UsageError(
      `cannot tell whether "${arg.slice(0, 60)}" is a link of this board: this machine's web.json is unreadable`,
    );
  }
  if (prefix === '' || !arg.startsWith(prefix))
    throw new UsageError(
      `"${arg.slice(0, 60)}" is not a link of this board: this machine's board is ${prefix.slice(0, -'/t/'.length) || '(unknown)'}, which a task link starts with (${prefix})`,
    );
  const id = /^([^/?#]+)\/?$/.exec(arg.slice(prefix.length))?.[1];
  if (id === undefined) throw new UsageError(`"${arg.slice(0, 60)}" is not a task link (${prefix}<id>)`);
  return id;
}

// An exact-case match wins; case only decides when there is none, so `Ab3` is not ambiguous with `aB3...`.
function matchPrefix(candidates: { id: string; title: string }[], prefix: string, what: string): string {
  const exact = candidates.filter((candidate) => candidate.id.startsWith(prefix));
  const wanted = prefix.toLowerCase();
  const matches =
    exact.length > 0 ? exact : candidates.filter((candidate) => candidate.id.toLowerCase().startsWith(wanted));
  const [only, ...others] = matches;
  if (only === undefined) throw new UsageError(`no ${what} starts with "${prefix}"`);
  if (others.length === 0) return only.id;
  throw new UsageError(
    `"${prefix}" matches ${matches.length} ${what}s:\n${matches.map((match) => `  ${match.id}  ${plainLine(match.title)}`).join('\n')}`,
  );
}

function needsLookup(arg: string): boolean {
  return arg.length >= MIN_PREFIX_LENGTH && arg.length <= LONGEST_PREFIX && !FULL_ID_LENGTHS.includes(arg.length);
}

// A full id costs no request; a board task link yields its id; a shorter prefix is matched against every task, closed ones included.
export async function resolveTaskId(backend: Backend, arg: string, options: ResolveOptions): Promise<string> {
  if (options.inRun) return arg;
  if (/^https?:\/\//i.test(arg)) return taskIdOfUrl(arg, options.boardLinkPrefix);
  if (arg.length < MIN_PREFIX_LENGTH)
    throw new UsageError(`"${arg}" is too short for a task id; give at least ${MIN_PREFIX_LENGTH} characters`);
  if (!needsLookup(arg)) return arg;
  return matchPrefix(await backend.listTasks({ all: true }), arg, 'task');
}

export async function resolveScheduleId(backend: Backend, arg: string, options: ResolveOptions): Promise<string> {
  if (options.inRun || !needsLookup(arg)) return arg;
  return matchPrefix(await backend.listSchedules(), arg, 'schedule');
}
