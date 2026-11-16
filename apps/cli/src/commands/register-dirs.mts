import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { Command } from 'commander';
import { UsageError } from '../cli.mts';
import { getPaths } from '../config/config.mts';
import { dirsAdd, dirsList, dirsRemove, dirsSet, dirsUnset, reportDirsSync } from './dirs.mts';
import type { DirsDeps } from './dirs.mts';
import { createStyle } from '../output/style.mts';
import { plainLine } from '../output/terminal.mts';
import { examples, paragraphs, SETUP } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';

// How long `board dirs add`, `rm`, `set` and `unset` wait for the board: the local change is made already, so a dead network must not hold them.
const DIRS_BOARD_TIMEOUT_MS = 15_000;

export function registerDirsCommand(shared: ProgramShared): void {
  const { program, options, env, contextOf, dryRunOption, notInRun } = shared;
  dryRunOption(
    program
      .command('dirs')
      .helpGroup(SETUP)
      .summary('list, add, remove or set up the directories workers may run in on this machine')
      .description(
        paragraphs(
          "Manage the `dirs` list of this machine's config.json: the directories workers may run in. Without a `dirs` key nothing is limited; once the key exists, even as `{}`, workers run only in a listed directory or one below it. Without arguments (or with `list`), print the entries, marking one whose directory is gone as missing. `add [path]` lists the real path of a directory (default: the current one); `rm [path]` unlists one. `set <key> <value> [path]` and `unset <key> [path]` change one setting of a listed directory (below). A path is relative to the current directory.",
          '`add` refuses `/` and a path that is not a directory, warns about the home directory (it allows everything below it), and notes when a parent is already listed. `add --from-config` lists the directories the config already routes to: `defaultCwd`, every lane `cwd` and every `repos` checkout that exists, skipping those a listed directory covers and never listing `/` or the home directory.',
          '`rm` asks the board for open tasks and schedules of this machine that run in the directory and in no other listed one, and refuses while there are any, and when the board cannot be reached; --force removes it anyway and needs no board. The list is enforced as soon as it exists, even empty: a worker refuses to start a task outside it, a run that ends outside it keeps the directory it started in, and `board schedule` and `board add` refuse (`board add` falls back to the directory the run started in) outside it. `add`, `rm`, `set` and `unset` rewrite the `dirs` key of config.json and nothing else (the settings of the other entries stay as they are), and are not available inside a board run.',
          "A listed directory can carry four settings. `label` (1 to 64 characters) is a short name the New task form shows with the path, and the only setting the board is sent. `repo` (owner/name) makes the directory the checkout of that repository, like a `repos` entry. `default` (the value is `true`) makes it the directory of tasks that have none, like `defaultCwd`; one directory has it. `lane` (a lane of this config) makes it the directory of that lane's tasks without one, like the lane's `cwd`; one directory per lane. A setting wins over the old key it stands for (`repos`, `defaultCwd`, a lane `cwd`), and `set` refuses one that another directory has: `unset` it there first. `list` shows each entry's settings; `rm` says which of repo, default and lane go with the entry.",
          "The board gets a copy of the list, for the New task form to offer: the listed directories that exist, sent by `add`, `rm`, `set` and `unset` and by every dispatch tick when it changed, each with its label. The copy is advice; workers read only this machine's config.json. If the board cannot be reached, they still succeed, warn, and leave it to the next dispatch tick.",
        ),
      )
      .usage('[options] [list | add [path] | rm [path] | set <key> <value> [path] | unset <key> [path]]')
      .argument('[action...]', 'list, add, rm, set or unset, and a path, or a setting and its value')
      .option('--from-config', 'add: list the directories the config already routes to')
      .option('--force', 'rm: remove although work of this machine still runs there, or the board cannot be checked')
      .addHelpText(
        'after',
        examples(
          'board dirs',
          'board dirs add',
          'board dirs add ~/workspace/agent-board',
          'board dirs add --from-config',
          'board dirs rm ~/workspace/old',
          'board dirs rm --force ~/workspace/gone',
          'board dirs set label Board',
          'board dirs set repo acme/board ~/workspace/agent-board',
          'board dirs set default true',
          'board dirs set lane reviews ~/workspace/reviews',
          'board dirs unset label',
        ),
      ),
  ).action(async (words: string[], flags: { fromConfig?: boolean; force?: boolean }, command: Command) => {
    const [action = 'list', ...rest] = words;
    if (action !== 'list' && action !== 'add' && action !== 'rm' && action !== 'set' && action !== 'unset')
      throw new UsageError(
        `dirs takes nothing, or list, add, rm, set or unset: not "${plainLine(action).slice(0, 40)}"`,
      );
    const settingWords = action === 'set' ? 2 : action === 'unset' ? 1 : 0;
    const [key, value] = rest.slice(0, settingWords);
    const pathWords = rest.slice(settingWords);
    if (action === 'list' && rest.length > 0) throw new UsageError('board dirs list takes no path');
    if (action === 'set' && value === undefined)
      throw new UsageError('board dirs set takes a setting, its value and optionally a path');
    if (action === 'unset' && key === undefined)
      throw new UsageError('board dirs unset takes a setting and optionally a path');
    if (pathWords.length > 1) throw new UsageError(`board dirs ${action} takes one path`);
    if (flags.fromConfig && action !== 'add') throw new UsageError('--from-config belongs to add');
    if (flags.force && action !== 'rm') throw new UsageError('--force belongs to rm');
    if (action !== 'list') notInRun(`board dirs ${action} is not available inside a board run`);
    const context = contextOf(command, { strictConfig: true, timeoutMs: DIRS_BOARD_TIMEOUT_MS });
    const deps: DirsDeps = {
      configFile: getPaths(env).configFile,
      cwd: options.cwd ?? realpathSync(process.cwd()),
      home: options.home ?? homedir(),
      dryRun: context.dryRun,
      print: context.print,
      backend: context.backend,
      bold: createStyle(context.color === true).bold,
    };
    const [path] = pathWords;
    if (action === 'list') dirsList(deps);
    else {
      if (action === 'add') dirsAdd(deps, path, flags);
      else if (action === 'rm') await dirsRemove(deps, path, flags);
      else if (action === 'set') dirsSet(deps, key ?? '', value ?? '', path);
      else dirsUnset(deps, key ?? '', path);
      await reportDirsSync(deps);
    }
  });
}
