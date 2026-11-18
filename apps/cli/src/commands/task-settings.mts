// `board task <task> [set <key> <value> | unset <key>]`: the settings of a task after it was made. Without an action it prints
// them; `set` and `unset` change the priority, the model and the directory the task runs in (which pins it to this machine).
import { resolve } from 'node:path';
import { isModelName, isPriority, isSafeWorkdir, PRIORITIES } from '@agent-board/shared';
import type { Backend, Task, UnreadableField } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { expandHome } from '../config/config.mts';
import type { Config } from '../config/config.mts';
import { isAllowedDir, isDirectory, tryRealpath } from '../config/dirs.mts';
import { pinnedMachine } from '../dispatch/decide.mts';
import { plainLine } from '../output/terminal.mts';
import { localTime } from './schedule.mts';

export const SETTING_KEYS = ['priority', 'model', 'dir'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface TaskSettingsDeps {
  backend: Pick<Backend, 'getTask' | 'configureTask'>;
  // This machine's name and its `dirs` list (undefined: nothing is limited).
  machine: Config['machine'];
  dirs: Config['dirs'];
  cwd: string;
  dryRun: boolean;
  print: (line: string) => void;
}

const UNREADABLE = '(cannot decrypt)';
const DEFAULT_DIRECTORY = 'the default directory of the machine that takes it';

const isUnreadable = (task: Task, field: UnreadableField): boolean => task.unreadable.includes(field);

// A path as it stands, or as typed when it is not there: only to judge a directory the board holds against this machine's list.
const realOrSame = (path: string): string => tryRealpath(path) ?? path;

function machineLine(task: Task): string {
  if (task.machine === null) return 'any';
  const pinned = pinnedMachine(task) === task.machine;
  return `${plainLine(task.machine)} (${pinned ? 'runs only there' : 'ran there last; any machine may take it'})`;
}

function directoryLine(deps: TaskSettingsDeps, task: Task): string {
  if (isUnreadable(task, 'workdir')) return UNREADABLE;
  if (task.workdir === null) return DEFAULT_DIRECTORY;
  const unlisted =
    task.machine === deps.machine && deps.dirs !== undefined && !isAllowedDir(deps.dirs, task.workdir, realOrSame);
  return `${plainLine(task.workdir)}${unlisted ? ' (not listed on this machine)' : ''}`;
}

function sessionLine(task: Task): string {
  return task.sessionId !== null && task.next === 'resume' ? 'resumes its session' : 'starts fresh';
}

/** The settings of a task as aligned plain text; every value the board or the task's sealed fields hold goes through `plainLine`. */
export function formatSettings(deps: TaskSettingsDeps, task: Task): string[] {
  const rows: [string, string][] = [
    ['status', `${task.status}${task.closed ? ' (closed)' : ''}`],
    ['priority', task.priority],
    ['model', task.model === null ? 'default' : plainLine(task.model)],
    ['agent', isUnreadable(task, 'agent') ? UNREADABLE : task.agent == null ? 'none' : plainLine(task.agent)],
    ['created by', task.createdBy],
    ['machine', machineLine(task)],
    ['directory', directoryLine(deps, task)],
    ['starts', task.notBefore === null ? 'when a worker is free' : localTime(task.notBefore)],
    [
      'schedule',
      task.scheduleId === null
        ? 'none'
        : `${plainLine(task.scheduleId)}${task.held ? ' (at its limit: waits for a free slot)' : ''}`,
    ],
    ...(task.forkOf === undefined ? [] : [['fork of', plainLine(task.forkOf)] satisfies [string, string]]),
    ['session', sessionLine(task)],
    ['pr', task.prs.length === 0 ? 'none' : task.prs.map((pr) => plainLine(pr.url)).join(', ')],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return [
    `${task.id}  ${isUnreadable(task, 'title') ? UNREADABLE : plainLine(task.title)}`,
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
    ...(task.unreadable.length > 0 ? [`  (cannot decrypt: ${task.unreadable.join(', ')})`] : []),
  ];
}

export async function showSettings(deps: TaskSettingsDeps, id: string): Promise<Task> {
  const task = await deps.backend.getTask(id);
  for (const line of formatSettings(deps, task)) deps.print(line);
  return task;
}

// Nothing is confirmed in a dry run: the DRY lines already say what would happen.
function confirmed(deps: TaskSettingsDeps, line: string): void {
  if (!deps.dryRun) deps.print(line);
}

function noteSchedule(deps: TaskSettingsDeps, task: Task): void {
  if (task.scheduleId !== null)
    deps.print(
      'note: this card belongs to a schedule; the change applies to it only, and the next occurrence takes priority, model, machine and directory from the schedule again',
    );
}

export async function setPriority(deps: TaskSettingsDeps, id: string, value: string): Promise<void> {
  if (!isPriority(value))
    throw new UsageError(`priority is one of ${PRIORITIES.join(', ')}, not "${plainLine(value)}"`);
  const task = await deps.backend.getTask(id);
  if (task.priority === value) return deps.print(`${id} is already ${value}`);
  await deps.backend.configureTask(id, { priority: value });
  noteSchedule(deps, task);
  confirmed(deps, `${id} priority is now ${value}`);
}

/** A model name, or undefined for claude's default. */
export async function setModel(deps: TaskSettingsDeps, id: string, model: string | undefined): Promise<void> {
  if (model !== undefined && !isModelName(model))
    throw new UsageError(
      `"${plainLine(model).slice(0, 40)}" is not a model name: use an alias such as opus, or a full model id`,
    );
  const task = await deps.backend.getTask(id);
  const shown = model ?? 'the default model';
  if (task.model === (model ?? null)) return deps.print(`${id} already uses ${shown}`);
  await deps.backend.configureTask(id, { model: model ?? null });
  noteSchedule(deps, task);
  const running = task.status === 'running' ? ' (the run in progress keeps its model)' : '';
  confirmed(deps, `${id} uses ${shown} from its next run on${running}`);
}

// What a typed path means: relative to the working directory, `~` expanded; it must be there and, with a `dirs` list, listed.
function chosenDirectory(deps: TaskSettingsDeps, path: string | undefined): string {
  const wanted = path === undefined ? deps.cwd : resolve(deps.cwd, expandHome(path));
  const real = tryRealpath(wanted);
  if (real === undefined || !isDirectory(real)) throw new UsageError(`${plainLine(wanted)} is not a directory`);
  if (!isSafeWorkdir(real)) throw new UsageError(`${plainLine(real)} cannot be a task's directory`);
  if (!isAllowedDir(deps.dirs, real))
    throw new UsageError(
      `${plainLine(real)} is not a listed directory on ${deps.machine}, so the task would stop in Needs me there. Run "board dirs add" there first, or give a listed directory.`,
    );
  return real;
}

/** Pins the task to this machine and `path` (default: the current directory), or with `null` gives it no directory of its own. */
export async function setDirectory(deps: TaskSettingsDeps, id: string, path: string | null | undefined): Promise<void> {
  const directory = path === null ? null : chosenDirectory(deps, path);
  const task = await deps.backend.getTask(id);
  if (task.status === 'running' || task.status === 'waiting')
    throw new UsageError(
      `${id} is ${task.status}: stop it first (Stop on its page), then change where it runs; its session is held by the run`,
    );
  const unchanged =
    directory === null
      ? task.machine === null && task.workdir === null && !isUnreadable(task, 'workdir')
      : task.machine === deps.machine && task.workdir === directory;
  if (unchanged)
    return deps.print(
      directory === null
        ? `${id} already has no directory of its own`
        : `${id} already runs only on ${deps.machine}, in ${plainLine(directory)}`,
    );
  if (task.sessionId !== null)
    deps.print(
      'note: its Claude session is dropped, because a session cannot be resumed from another directory; the next run starts fresh there and reads the thread',
    );
  await deps.backend.configureTask(id, {
    place: directory === null ? null : { workdir: directory },
    seal: {
      createdBy: task.createdBy,
      scheduleId: task.scheduleId,
      agent: task.agent ?? null,
      forkOf: task.forkOf ?? null,
    },
  });
  noteSchedule(deps, task);
  confirmed(
    deps,
    directory === null
      ? `${id} has no directory of its own now: any machine may take it, in its default directory`
      : `${id} now runs only on ${deps.machine}, in ${plainLine(directory)}`,
  );
}
