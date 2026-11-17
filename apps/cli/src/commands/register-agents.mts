import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { Command } from 'commander';
import { readStdin, UsageError } from '../cli.mts';
import { getPaths } from '../config/config.mts';
import { plainLine } from '../output/terminal.mts';
import { clackPrompts } from '../setup/init.mts';
import { agentsAdd, agentsList, agentsRemove, agentsShow } from './agents.mts';
import type { AgentsDeps } from './agents.mts';
import { examples, paragraphs, SETUP } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';

const ACTIONS = ['list', 'show', 'export', 'add', 'rm'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (word: string): word is Action => ACTIONS.some((action) => action === word);

export function registerAgentsCommand(shared: ProgramShared): void {
  const { program, options, env, dryRunOption, writeOut, out } = shared;
  dryRunOption(
    program
      .command('agents')
      .helpGroup(SETUP)
      .summary('list, show, export, add or remove the agents of this machine')
      .description(
        paragraphs(
          'Manage the agents of this machine: the named sets of tools and rules a task runs as when it names one (see Agents in docs/workers.md). An agent is defined either under `agents` in config.json or as a file `<name>.yaml` (or `.yml`, `.json`) in the `agents` directory beside it; both are checked the same strict way, and a name defined in both places is unusable.',
          'Without arguments (or with `list`), print each agent with its tools, how many allow and deny rules it has, where it is defined, where it came from, and whether it is usable here (a definition that does not parse, or a plugin placeholder such as `{pr-review}` that does not resolve, is not). `show <name>` prints one agent as a YAML document (`--json` for JSON), the same shape `add` reads; `export <name>` prints the same without the `source` this machine recorded, to share it.',
          "`add <file | - | https-url | example:name>` reads a definition (YAML or JSON: the keys of a config.json agent plus `name` and `version`) from a file, from stdin, from an https URL or from an example that ships with the CLI, and writes it to `agents/<name>.yaml` (mode 600). The name is `--name`, else the document's `name`, else the file name. An agent definition decides what a run may do on this machine, so `add` first prints the whole definition and every tool, allow rule, deny rule, env variable and MCP server it grants, flags broad rules (`Bash`, `Bash(*)`, a rule that runs a shell or `curl`, `Read` of a whole tree), env names that look like secrets and an empty deny list, says whether its plugin placeholders resolve, and writes only after you confirm at a terminal or pass `--yes`. An agent that exists needs `--replace`; one defined in config.json is not replaced.",
          "A URL must be https; the fetch takes at most 15 seconds and 256 KB, and follows a redirect only to https on the same host. `#sha256=<hex>` at the end of the URL pins the file: `add` refuses one whose sha256 differs. The URL is recorded as the agent's `source`; nothing updates it later, so run `add --replace` again to take a newer version.",
          "`rm <name>` removes the agent's file, or its entry in config.json (the rest of the file stays as it is). `add` and `rm` are not available inside a board run.",
        ),
      )
      .usage('[options] [list | show <name> | export <name> | add <file|-|url|example:name> | rm <name>]')
      .argument('[action...]', 'list, show, export, add or rm, and a name or a source')
      .option('--json', 'list, show, export: print JSON instead of text or YAML')
      .option('--yaml', 'show, export: print YAML (the default)')
      .option('--name <name>', 'add: the name to add the agent under')
      .option('--replace', 'add: overwrite an agent of that name')
      .option('-y, --yes', 'add: write without asking (read the definition first)')
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
        ),
      ),
  ).action(
    async (
      words: string[],
      flags: { json?: boolean; yaml?: boolean; name?: string; replace?: boolean; yes?: boolean },
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
            : `board agents ${action} takes one ${action === 'add' ? 'source' : 'name'}`,
        );
      if (flags.json && flags.yaml) throw new UsageError('--json and --yaml: choose one');
      if (flags.yaml && action !== 'show' && action !== 'export')
        throw new UsageError('--yaml belongs to show and export');
      if (flags.json && action !== 'show' && action !== 'export' && action !== 'list')
        throw new UsageError('--json belongs to list, show and export');
      if ((flags.name !== undefined || flags.replace || flags.yes) && action !== 'add')
        throw new UsageError('--name, --replace and --yes belong to add');
      if ((action === 'add' || action === 'rm') && (env['AGENT_BOARD_TASK'] || env['AGENT_BOARD_RESTRICTED']))
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
      };
      const [target = ''] = rest;
      if (action === 'list') agentsList(deps, flags.json === true);
      else if (action === 'show' || action === 'export')
        agentsShow(deps, target, flags.json ? 'json' : 'yaml', { withSource: action === 'show' });
      else if (action === 'add') {
        // A definition read from stdin leaves no terminal to confirm on.
        await agentsAdd(target === '-' ? { ...deps, confirm: undefined } : deps, target, flags);
      } else agentsRemove(deps, target);
    },
  );
}
