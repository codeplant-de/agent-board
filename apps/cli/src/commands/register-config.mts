import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { UsageError } from '../cli.mts';
import { getPaths } from '../config/config.mts';
import { plainLine } from '../output/terminal.mts';
import { configEdit, configGet, configPath, configSet, configShow, configUnset } from './config.mts';
import type { ConfigDeps } from './config.mts';
import { examples, paragraphs, SETUP } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';

// How long a change waits for the board when it sends the `dirs` list: the local change is made already.
const CONFIG_BOARD_TIMEOUT_MS = 15_000;

const ACTIONS = ['show', 'get', 'set', 'unset', 'edit', 'path'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (word: string): word is Action => ACTIONS.some((action) => action === word);

function runEditorInTerminal(argv: string[]): number | undefined {
  const [program, ...args] = argv;
  if (program === undefined) return undefined;
  const result = spawnSync(program, args, { stdio: 'inherit' });
  return result.error === undefined ? (result.status ?? 1) : undefined;
}

export function registerConfigCommand(shared: ProgramShared): void {
  const { program, options, env, contextOf, dryRunOption, jsonOption, notInRun } = shared;
  jsonOption(
    dryRunOption(
      program
        .command('config')
        .helpGroup(SETUP)
        .summary("show or change this machine's config.json")
        .description(
          paragraphs(
            "View and edit this machine's config.json (`AGENT_BOARD_CONFIG_DIR` changes where it is) without a text editor. Without arguments (or with `show`), print the path of the file and the settings as the CLI reads them, a value that comes from a default marked `(default)`, the lanes, repos and agents (an agent that cannot be loaded with its error), the size of the `dirs` list, and then every warning about the file (a key the CLI ignores, a `dirs` setting that overrides an older key). `show --json` prints the file as JSON. `path` prints the path alone.",
            '`get <key>` prints the value in the file at a dotted key (`machine`, `lanes.reviews.slots`, `agents.reviewer.tools`): a string bare, anything else as JSON. A key the file leaves out prints its default when it has one (`machine`, `defaultCwd`, `pauseAfterMinutes`, `inactivityMinutes`, `maxRunHours`, `autoUpdate`, `lanes`) and is an error otherwise. A name that holds dots (a lane, a `dirs` path, `owner/name.js` under `repos`) is read as the document has it.',
            '`set <key> <value>` takes the value as JSON when it is JSON (`3`, `true`, `["Read","Bash"]`, `{"skills":["*"],"slots":2}`) and as a string otherwise (write `\'"123"\'` for the string 123), and creates the objects on the way. The whole resulting file is checked before anything is written, and the change is refused, with the file left as it is, when the config would not load, when it would add an agent that cannot be loaded, when the key is not one the CLI reads (the error names the nearest key), or when a directory the config routes work to (`defaultCwd`, the `cwd` of a lane, a `repos` checkout) would newly not be a directory or not be covered by `dirs`. Setting one lane in a file that has no `lanes` key writes the default lane out too. A change to `dirs` that drops a listed directory warns that work still pinned to it stops in Needs me (`board dirs rm` checks for that). `unset <key>` removes a key so its default applies again, with the same check. Setting what is already there writes nothing. The file is rewritten as JSON with 2 spaces and keeps its key order and mode, and a config.json that is a link is changed where it points. `--dry-run` shows what would be written. The entries of `dirs` are changed with `board dirs`; `set` and `unset` refuse a key below `dirs`.',
            '`edit` opens the file in $VISUAL, else $EDITOR (run through the shell the way git runs its editor, so a command line with arguments or quotes such as `code -w` or `emacsclient -a ""` works; there is no default), on a copy beside it, and replaces the file only when the result is JSON the CLI can load. An unknown key, an agent that cannot be loaded or a route that is not a directory or not in `dirs` is a warning there, since you wrote it by hand. If the result is not valid, the file stays as it was and the message names the copy with your edits. It needs a terminal. `set`, `unset` and `edit` are not available inside a board run: the file holds the rules runs work under.',
            'After a change the CLI sends a changed `dirs` list to the board (a failure is a warning), warns when `machine` changed (the board names a machine by its token), and says that the change applies from the next dispatch tick. A run that is already going keeps the settings it started with, except `maxRunHours`, `inactivityMinutes` and `pauseAfterMinutes`: the dispatcher reads those from the file on each tick and applies them to runs already going (a run past a lowered `maxRunHours` is stopped then).',
          ),
        )
        .usage('[options] [show | get <key> | set <key> <value> | unset <key> | edit | path]')
        .argument('[action...]', 'show, get, set, unset, edit or path, and a key and its value')
        .addHelpText(
          'after',
          examples(
            'board config',
            'board config get lanes.reviews.slots',
            'board config set pauseAfterMinutes 10',
            'board config set agents.reviewer.tools \'["Read","Bash"]\'',
            'board config set lanes.reviews \'{"skills":["/review"],"slots":2}\'',
            'board config --dry-run unset maxRunHours',
            'board config edit',
          ),
        ),
    ),
  ).action(async (words: string[], flags: { json?: boolean }, command: Command) => {
    const [action = 'show', ...rest] = words;
    if (!isAction(action))
      throw new UsageError(`config takes nothing, or ${ACTIONS.join(', ')}: not "${plainLine(action).slice(0, 40)}"`);
    const [key, value] = rest;
    const operands = action === 'get' || action === 'unset' ? 1 : action === 'set' ? 2 : 0;
    if (rest.length !== operands)
      throw new UsageError(
        action === 'set'
          ? 'board config set takes a key and a value'
          : operands === 1
            ? `board config ${action} takes a key`
            : `board config ${action} takes nothing more`,
      );
    if (flags.json && action !== 'show') throw new UsageError('--json belongs to show');
    if (action === 'set' || action === 'unset' || action === 'edit')
      notInRun(`board config ${action} is not available inside a board run`);
    const context = contextOf(command, {
      strictConfig: true,
      json: flags.json === true,
      timeoutMs: CONFIG_BOARD_TIMEOUT_MS,
    });
    const editor = [env['VISUAL'], env['EDITOR']].find((name) => name !== undefined && name.trim() !== '');
    const deps: ConfigDeps = {
      configFile: getPaths(env).configFile,
      dryRun: context.dryRun,
      print: context.print,
      printJson: shared.writeJson,
      backend: context.backend,
      editor,
      interactive: options.interactive ?? process.stdin.isTTY === true,
      runEditor: options.runEditor ?? runEditorInTerminal,
    };
    if (action === 'show') configShow(deps, flags);
    else if (action === 'get') configGet(deps, key ?? '');
    else if (action === 'set') await configSet(deps, key ?? '', value ?? '');
    else if (action === 'unset') await configUnset(deps, key ?? '');
    else if (action === 'edit') await configEdit(deps);
    else configPath(deps);
  });
}
