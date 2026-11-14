import type { Backend } from '@agent-board/shared';
import { UsageError } from './cli.mts';

export interface ResolveOptions {
  // A run's agent works on untrusted text: it addresses only the full id it was given, never a guess.
  inRun: boolean;
}

const FULL_ID_LENGTH = 8;
const MIN_PREFIX_LENGTH = 3;

// The board builds task links from its public URL, which need not be the URL in web.json, so only the path counts; an id of another board fails at the server.
function taskIdOfUrl(arg: string): string {
  let pathname: string;
  try {
    pathname = new URL(arg).pathname;
  } catch {
    throw new UsageError(`"${arg.slice(0, 60)}" is not a link`);
  }
  const id = /^\/t\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (id === undefined) throw new UsageError(`"${arg.slice(0, 60)}" is not a task link (.../t/<id>)`);
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
    `"${prefix}" matches ${matches.length} ${what}s:\n${matches.map((match) => `  ${match.id}  ${match.title}`).join('\n')}`,
  );
}

function needsLookup(arg: string): boolean {
  return arg.length >= MIN_PREFIX_LENGTH && arg.length < FULL_ID_LENGTH;
}

// A full id costs no request; a board task link yields its id; a shorter prefix is matched against every task, closed ones included.
export async function resolveTaskId(backend: Backend, arg: string, options: ResolveOptions): Promise<string> {
  if (options.inRun) return arg;
  if (/^https?:\/\//i.test(arg)) return taskIdOfUrl(arg);
  if (arg.length < MIN_PREFIX_LENGTH)
    throw new UsageError(`"${arg}" is too short for a task id; give at least ${MIN_PREFIX_LENGTH} characters`);
  if (!needsLookup(arg)) return arg;
  return matchPrefix(await backend.listTasks({ all: true }), arg, 'task');
}

export async function resolveScheduleId(backend: Backend, arg: string, options: ResolveOptions): Promise<string> {
  if (options.inRun || !needsLookup(arg)) return arg;
  return matchPrefix(await backend.listSchedules(), arg, 'schedule');
}
