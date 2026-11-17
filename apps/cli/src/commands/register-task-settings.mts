import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import { MODEL_ALIASES, PRIORITIES } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { plainLine } from '../output/terminal.mts';
import { taskJson } from './board.mts';
import { examples, ID_NOTE, paragraphs, TASK_ARGUMENT, TASKS } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';
import { setDirectory, setModel, setPriority, showSettings } from './task-settings.mts';
import type { TaskSettingsDeps } from './task-settings.mts';

export function registerTaskSettingsCommand(shared: ProgramShared): void {
  const { program, options, writeJson, contextOf, taskIdOf, jsonOptionReadable, dryRunOption, notInRun } = shared;
  dryRunOption(
    jsonOptionReadable(
      program
        .command('task')
        .helpGroup(TASKS)
        .summary("show a task's settings, or change its priority, model or directory")
        .description(
          paragraphs(
            "Without an action, print a task's settings: status, priority, model, agent, who made it, the machine it is pinned to and its directory, when it starts, its schedule, whether its next run resumes a session, and its PR. With --json, print the task as `board tasks --json` does.",
            `\`set priority <${PRIORITIES.join('|')}>\` and \`set model <alias or model id>\` change the setting, \`unset model\` goes back to claude's default model. A model applies from the next run on; a run in progress keeps its own.`,
            "`set dir [path]` pins the task to this machine and the directory (default: the current one; a path is relative to it and `~` expands). `unset dir` removes the directory and the pin: any machine takes the task, in its default directory. Claude Code keeps a session under its working directory and cannot resume it from another one, so changing the directory drops the task's session: the next run starts fresh there and reads the thread. A running or waiting task is refused: stop it first. With a `dirs` list on this machine, the directory must be listed (`board dirs add`).",
            "On a card of a repeating schedule a change applies to that card only: the next occurrence takes its priority, model, machine and directory from the schedule again, which the command says. `set dir` needs this machine's config.json, since it pins the task to the machine's name.",
            '`set` and `unset` are not available inside a board run: only you change where a task runs, and with what. Viewing works there.',
            ID_NOTE,
          ),
        )
        .usage('[options] <task> [set <key> <value> | unset <key>]')
        .argument('<task>', TASK_ARGUMENT)
        .argument('[action...]', 'set priority|model|dir <value>, or unset model|dir')
        .addHelpText(
          'after',
          examples(
            'board task Ab3dEf9x',
            'board task Ab3 --json',
            'board task Ab3 set priority high',
            `board task Ab3 set model ${MODEL_ALIASES[1].value}`,
            'board task Ab3 unset model',
            'board task Ab3 set dir',
            'board task Ab3 set dir ~/workspace/agent-board',
            'board task Ab3 unset dir',
          ),
        ),
    ),
  ).action(async (arg: string, words: string[], flags: { json?: boolean }, command: Command) => {
    const [action, key, ...rest] = words;
    if (action !== undefined && action !== 'set' && action !== 'unset')
      throw new UsageError(`task takes nothing, or set or unset: not "${plainLine(action).slice(0, 40)}"`);
    if (action !== undefined && flags.json) throw new UsageError('--json only prints the settings of a task');
    if (action !== undefined) notInRun(`board task ${action} is not available inside a board run`);
    const context = contextOf(command, { json: flags.json === true, strictConfig: action === 'set' && key === 'dir' });
    const deps: TaskSettingsDeps = {
      backend: context.backend,
      machine: context.config.machine,
      dirs: context.config.dirs,
      cwd: options.cwd ?? realpathSync(process.cwd()),
      dryRun: context.dryRun,
      print: context.print,
    };
    if (action === undefined) {
      const id = await taskIdOf(context, arg);
      if (!flags.json) return void (await showSettings(deps, id));
      return writeJson(taskJson(await context.backend.getTask(id)));
    }
    if (key !== 'priority' && key !== 'model' && key !== 'dir')
      throw new UsageError(`board task ${action} takes priority, model or dir`);
    const id = await taskIdOf(context, arg);
    if (action === 'unset') {
      if (rest.length > 0) throw new UsageError(`board task unset ${key} takes nothing more`);
      if (key === 'priority') throw new UsageError('a task always has a priority; set one of ' + PRIORITIES.join(', '));
      return key === 'model' ? setModel(deps, id, undefined) : setDirectory(deps, id, null);
    }
    if (key === 'dir') {
      if (rest.length > 1) throw new UsageError('board task set dir takes one path');
      return setDirectory(deps, id, rest[0]);
    }
    const [value] = rest;
    if (value === undefined || rest.length > 1) throw new UsageError(`board task set ${key} takes one value`);
    return key === 'priority' ? setPriority(deps, id, value) : setModel(deps, id, value);
  });
}
