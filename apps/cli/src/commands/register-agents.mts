import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { Command } from 'commander';
import { readStdin, UsageError } from '../cli.mts';
import { getPaths } from '../config/config.mts';
import { plainLine } from '../output/terminal.mts';
import { clackPrompts } from '../setup/init.mts';
import { agentsAdd, agentsList, agentsPush, agentsRemove, agentsRemoveFromBoard, agentsShow } from './agents.mts';
import type { AgentsDeps } from './agents.mts';
import { examples, paragraphs, SETUP } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';

const ACTIONS = ['list', 'show', 'export', 'add', 'push', 'rm'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (word: string): word is Action => ACTIONS.some((action) => action === word);

export function registerAgentsCommand(shared: ProgramShared): void {
  const { program, options, env, dryRunOption, writeOut, out, contextOf } = shared;
  dryRunOption(
    program
      .command('agents')
      .helpGroup(SETUP)
      .summary('list, show, export, add or remove the agents of this machine, or push one to every machine')
      .description(
        paragraphs(
          'Manage the agents of this machine: the named sets of tools and rules a task runs as when it names one (see Agents in docs/workers.md). An agent is defined either under `agents` in config.json or as a file `<name>.yaml` (or `.yml`, `.json`) in the `agents` directory beside it; both are checked the same strict way, and a name defined in both places is unusable.',
          'Without arguments (or with `list`), print each agent with its tools, how many allow and deny rules it has, where it is defined, where it came from, and whether it is usable here (a definition that does not parse, or a plugin placeholder such as `{pr-review}` that does not resolve, is not). `show <name>` prints one agent as a YAML document (`--json` for JSON), the same shape `add` reads; `export <name>` prints the same without the `source` this machine recorded, to share it.',
          "`add <file | - | https-url | example:name>` reads a definition (YAML or JSON: the keys of a config.json agent plus `name` and `version`) from a file, from stdin, from an https URL or from an example that ships with the CLI, and writes it to `agents/<name>.yaml` (mode 600). The name is `--name`, else the document's `name`, else the file name. An agent definition decides what a run may do on this machine, so `add` first prints the whole definition and every tool, allow rule, deny rule, env variable and MCP server it grants, flags broad rules (`Bash`, `Bash(*)`, a rule that runs a shell or `curl`, `Read` of a whole tree), env names that look like secrets and an empty deny list, says whether its plugin placeholders resolve, and writes only after you confirm at a terminal or pass `--yes`. An agent that exists needs `--replace`; one defined in config.json is not replaced.",
          "A URL must be https; the fetch takes at most 15 seconds and 256 KB, and follows a redirect only to https on the same host. `#sha256=<hex>` at the end of the URL pins the file: `add` refuses one whose sha256 differs. The URL is recorded as the agent's `source`; nothing updates it later, so run `add --replace` again to take a newer version.",
          "`push <name | file | - | https-url | example:name>` puts one agent on the board for every machine of yours: an agent this machine defines, or a definition read the way `add` reads one. It prints the same definition and grant summary, and pushes only after you confirm at a terminal or pass `--yes`. Every machine applies the board's agents on its next dispatch tick: it writes them to `agents.board/` beside config.json and moves its own definition of the same name to `agents.replaced/` (the board wins a name; nothing is deleted). After a push the agent is the board's on this machine too: its agents/ file or config.json entry goes. The board holds all agents as one sealed document whose version goes up with every push; a push that finds another push came first fetches again and retries once.",
          "`rm <name>` removes the agent's file, or its entry in config.json (the rest of the file stays as it is). `rm --board <name>` takes an agent off the board, and every machine drops its copy on its next tick. `add` refuses a name the board holds. `add`, `push` and `rm` are not available inside a board run.",
          "The list says where each agent comes from (`config.json`, `agents/<file>` or `board v<n>`, the version of the board's agents this machine applied) and the first 12 hex digits of its hash: SHA-256 of the keys that decide what a run may do, the same on every machine for the same definition.",
        ),
      )
      .usage(
        '[options] [list | show <name> | export <name> | add <file|-|url|example:name> | push <name|file|-|url|example:name> | rm [--board] <name>]',
      )
      .argument('[action...]', 'list, show, export, add, push or rm, and a name or a source')
      .option('--json', 'list, show, export: print JSON instead of text or YAML')
      .option('--yaml', 'show, export: print YAML (the default)')
      .option('--name <name>', 'add, push: the name to add or push the agent under')
      .option('--replace', 'add: overwrite an agent of that name')
      .option('-y, --yes', 'add, push: write without asking (read the definition first)')
      .option('--board', "rm: take the agent off the board's agents, for every machine")
      .addHelpText(
        'after',
        examples(
          'board agents',
          'board agents show reviewer',
          'board agents export reviewer > reviewer.yaml',
          'board agents add example:reviewer',
          'board agents add ./reviewer.yaml --name reviewer-strict',
          'board agents add https://example.com/agents/reviewer.yaml#sha256=<hex>',
          'yq -o json reviewer.yaml | board agents add - --yes',
          'board agents rm reviewer',
          'board agents push reviewer',
          'board agents push ./reviewer.yaml',
          'board agents rm --board reviewer',
        ),
      ),
  ).action(
    async (
      words: string[],
      flags: { json?: boolean; yaml?: boolean; name?: string; replace?: boolean; yes?: boolean; board?: boolean },
      command: Command,
    ) => {
      const [action = 'list', ...rest] = words;
      if (!isAction(action))
        throw new UsageError(`agents takes nothing, or ${ACTIONS.join(', ')}: not "${plainLine(action).slice(0, 40)}"`);
      const wants = action === 'list' ? 0 : 1;
      if (rest.length !== wants)
        throw new UsageError(
          wants === 0
            ? 'board agents list takes no argument'
            : `board agents ${action} takes one ${action === 'add' ? 'source' : action === 'push' ? 'name or source' : 'name'}`,
        );
      if (flags.json && flags.yaml) throw new UsageError('--json and --yaml: choose one');
      if (flags.yaml && action !== 'show' && action !== 'export')
        throw new UsageError('--yaml belongs to show and export');
      if (flags.json && action !== 'show' && action !== 'export' && action !== 'list')
        throw new UsageError('--json belongs to list, show and export');
      if (flags.replace && action !== 'add') throw new UsageError('--replace belongs to add');
      if ((flags.name !== undefined || flags.yes) && action !== 'add' && action !== 'push')
        throw new UsageError('--name and --yes belong to add and push');
      if (flags.board && action !== 'rm') throw new UsageError('--board belongs to rm');
      if (
        (action === 'add' || action === 'push' || action === 'rm') &&
        (env['AGENT_BOARD_TASK'] || env['AGENT_BOARD_RESTRICTED'])
      )
        throw new UsageError(`board agents ${action} is not available inside a board run`);
      const dryRun =
        program.opts<{ dryRun?: boolean }>().dryRun === true || command.opts<{ dryRun?: boolean }>().dryRun === true;
      const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
      const prompts = options.prompts ?? clackPrompts();
      const confirm = prompts.confirm;
      const deps: AgentsDeps = {
        configFile: getPaths(env).configFile,
        cwd: options.cwd ?? realpathSync(process.cwd()),
        home: options.home ?? homedir(),
        dryRun,
        print: out,
        write: writeOut,
        readStdin: options.readStdin ?? readStdin,
        confirm: interactive && confirm !== undefined ? confirm : undefined,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(action === 'push' || flags.board ? { backend: contextOf(command).backend } : {}),
      };
      const [target = ''] = rest;
      if (action === 'list') agentsList(deps, flags.json === true);
      else if (action === 'show' || action === 'export')
        agentsShow(deps, target, flags.json ? 'json' : 'yaml', { withSource: action === 'show' });
      else if (action === 'add') {
        // A definition read from stdin leaves no terminal to confirm on.
        await agentsAdd(target === '-' ? { ...deps, confirm: undefined } : deps, target, flags);
      } else if (action === 'push')
        await agentsPush(target === '-' ? { ...deps, confirm: undefined } : deps, target, flags);
      else if (flags.board) await agentsRemoveFromBoard(deps, target);
      else agentsRemove(deps, target);
    },
  );
}
