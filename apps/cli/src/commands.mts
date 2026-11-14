import { Command, CommanderError } from 'commander';
import { CONTRACT_VERSION, STATUSES } from '@agent-board/shared';
import {
  add,
  ask,
  delay,
  notify,
  move,
  parseStatus,
  readNoteFile,
  scheduleCommand,
  schedules,
  show,
  tasks,
} from './board.mts';
import type { AddFlags, DelayFlags } from './board.mts';
import { buildContext, readStdin, UsageError } from './cli.mts';
import type { Context } from './cli.mts';
import { dispatchMain } from './dispatch.mts';
import { runHook } from './hook.mts';
import { intakeMain } from './intake.mts';
import { addScheduleOptions } from './schedule.mts';
import type { ScheduleFlags } from './schedule.mts';
import { cliVersion } from './version.mts';
import { workerMain } from './worker.mts';

export interface ProgramOptions {
  env?: Record<string, string | undefined>;
  // The context of a command; tests hand over a fake backend.
  context?: (dryRun: boolean) => Context;
  readStdin?: () => Promise<string>;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  version?: string;
}

const TASKS = 'Tasks:';
const SCHEDULING = 'Scheduling:';
const SETUP = 'Setup:';

const STATUS_LIST = STATUSES.join(', ');

// `comment <task> [text...]` in the overview, without commander's `[options]` and without the long usage of `comment`.
function overviewTerm(command: Command): string {
  const args = command.registeredArguments.map((arg) => {
    const name = `${arg.name()}${arg.variadic ? '...' : ''}`;
    return arg.required ? `<${name}>` : `[${name}]`;
  });
  return [command.name(), ...args].join(' ');
}

function paragraphs(...text: string[]): string {
  return text.join('\n\n');
}

function examples(...lines: string[]): string {
  return `\nExamples:\n${lines.map((line) => `  ${line}`).join('\n')}\n`;
}

// A fresh program per call, so tests run it in-process with their own context and output.
export function buildProgram(options: ProgramOptions = {}): Command {
  const env = options.env ?? process.env;
  const stdin = options.readStdin ?? readStdin;
  const makeContext = options.context ?? ((dryRun: boolean) => buildContext(dryRun, { optionalConfig: true }));
  const writeOut = options.writeOut ?? ((text: string) => void process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => void process.stderr.write(text));

  const program = new Command('board')
    .enablePositionalOptions()
    .exitOverride()
    .showSuggestionAfterError()
    .configureOutput({ writeOut, writeErr, outputError: () => undefined })
    .configureHelp({ subcommandTerm: overviewTerm })
    .version(
      `board ${options.version ?? cliVersion()} (contract ${CONTRACT_VERSION})`,
      '-V, --version',
      'print the version',
    )
    .option('--dry-run', 'read everything, print every write instead of doing it')
    .description(
      'Work with the agent board from a terminal, and from inside a run: comment on tasks, move them, schedule new ones.',
    )
    .addHelpText('after', '\nRun "board help <command>" for the details and examples of one command.\n');

  const contextOf = (command: Command): Context => {
    const dryRun =
      program.opts<{ dryRun?: boolean }>().dryRun === true || command.opts<{ dryRun?: boolean }>().dryRun === true;
    return makeContext(dryRun);
  };
  // A run's agent works on untrusted text; a task it schedules would run with the user's full permissions.
  const notInRun = (message: string): void => {
    if (env['AGENT_BOARD_TASK']) throw new UsageError(message);
  };
  // The text of `comment` and `notify`: the words as written, or stdin for `-`; `comment` also reads a file for `--file <path>`.
  const textOf = async (words: string[], { allowFile }: { allowFile: boolean }): Promise<string> => {
    if (allowFile && words[0] === '--file') {
      if (words.length !== 2) throw new UsageError('--file takes one path');
      return readNoteFile(words[1] ?? '');
    }
    const text = words.join(' ');
    const resolved = text === '-' ? (await stdin()).trim() : text;
    if (!resolved) throw new UsageError('the text is missing');
    return resolved;
  };
  const dryRunOption = (command: Command): Command =>
    command.option('--dry-run', 'read everything, print every write instead of doing it');

  dryRunOption(
    program
      .command('tasks')
      .helpGroup(TASKS)
      .summary('open tasks per status')
      .description('List the open tasks per status, with their id, priority and title, and when a delayed task starts.')
      .addHelpText('after', examples('board tasks')),
  ).action((_options, command: Command) => tasks(contextOf(command)));

  dryRunOption(
    program
      .command('show')
      .helpGroup(TASKS)
      .summary('a task and its thread as markdown')
      .description(
        'Print a task and its thread (input, questions, answers and notes) as markdown. A resumed run reads this first.',
      )
      .argument('<task>', 'the task id')
      .addHelpText('after', examples('board show Ab3dEf9x')),
  ).action((task: string, _options, command: Command) => show(contextOf(command), task));

  dryRunOption(
    program
      .command('comment')
      .helpGroup(TASKS)
      .summary('add a note to a task')
      .description(
        paragraphs(
          "Add a note to the task's thread. The text is every word after the task, quoted or not, and is never read as a flag.",
          '`-` reads the text from stdin; `--file <path>` right after the task reads it from a regular file in /tmp, for long text.',
        ),
      )
      .usage('[options] <task> <text...|-|--file <path>>')
      .argument('<task>', 'the task id')
      .argument('[text...]', 'the note')
      .passThroughOptions()
      .addHelpText(
        'after',
        examples(
          'board comment Ab3dEf9x "step 3 done"',
          'board comment Ab3dEf9x tests pass, one flaky',
          'board comment Ab3dEf9x --file /tmp/review.md',
          'echo "from a script" | board comment Ab3dEf9x -',
        ),
      ),
  ).action(async (task: string, words: string[], _options, command: Command) => {
    const text = await textOf(words, { allowFile: true });
    await contextOf(command).backend.addNote(task, text);
  });

  dryRunOption(
    program
      .command('move')
      .helpGroup(TASKS)
      .summary('move a task to the bottom of a status')
      .description(
        `Move a task to the bottom of a status: ${STATUS_LIST}. "Backlog", "Todo", "Running", "Needs me" and "Done" work too.`,
      )
      .argument('<task>', 'the task id')
      .argument('<status...>', 'the status to move it to')
      .addHelpText(
        'after',
        examples('board move Ab3dEf9x needs-me', 'board move Ab3dEf9x Needs me', 'board move Ab3dEf9x todo'),
      ),
  ).action((task: string, status: string[], _options, command: Command) =>
    move(contextOf(command), task, parseStatus(status.join(' '))),
  );

  dryRunOption(
    program
      .command('notify')
      .helpGroup(TASKS)
      .summary('Slack message with the task link')
      .description(
        'Send a Slack message with the task link. The text is every word after the task; `-` reads it from stdin.',
      )
      .argument('<task>', 'the task id')
      .argument('<text...>', 'the message')
      .passThroughOptions()
      .addHelpText('after', examples('board notify Ab3dEf9x "needs your decision"')),
  ).action(async (task: string, words: string[], _options, command: Command) => {
    const text = await textOf(words, { allowFile: false });
    await notify(contextOf(command), task, text);
  });

  dryRunOption(
    program
      .command('ask')
      .helpGroup(TASKS)
      .summary('ask the user 1-4 questions')
      .description(
        paragraphs(
          'Ask the user 1-4 questions and move the task to needs-me; Slack is told. The user answers on the board and the run is resumed with the answers.',
          'The questions are JSON in a regular file in /tmp: {"questions": [{"header", "question", "multiSelect", "options": [{"label", "description", "recommended"?}]}]}',
        ),
      )
      .argument('<task>', 'the task id')
      .requiredOption('--file <path>', 'the questions as JSON, in /tmp')
      .addHelpText('after', examples('board ask Ab3dEf9x --file /tmp/pr-Ab3dEf9x-questions.json')),
  ).action((task: string, flags: { file: string }, command: Command) => ask(contextOf(command), task, flags.file));

  dryRunOption(
    program
      .command('add')
      .helpGroup(TASKS)
      .summary('propose a follow-up task')
      .description(
        'Propose a follow-up task; the file is its prompt. It waits in needs-me until the user starts it, and runs in this directory on this machine.',
      )
      .requiredOption('--title <title>', "the task's title")
      .requiredOption('--file <path>', 'the prompt, a regular file in /tmp')
      .option('--parent <task>', 'the task this follows from')
      .option('--priority <priority>', 'urgent, high, normal or low (default normal)')
      .addHelpText('after', examples('board add --title "Fix the flaky test" --file /tmp/prompt.md --parent Ab3dEf9x')),
  ).action((flags: AddFlags, command: Command) => add(contextOf(command), flags));

  const schedule = program
    .command('schedule')
    .helpGroup(SCHEDULING)
    .summary('a task from a prompt, run here on this machine')
    .description(
      paragraphs(
        'Make a task of the prompt, written as you would type it into Claude Code, bound to this machine and this directory. Prints its URL. A quick Haiku call first checks whether an open task already covers it; --new skips that.',
        'The flags come first; everything from the first other word on is the prompt, flags included (`--auto` below goes to the skill). To start the prompt with dashes, put -- before it.',
        '--in or --at keeps the task in Todo until then. --every or --cron makes a repeating schedule instead, starting at --in/--at (default now), for --times runs or until --until, else forever.',
        'Not available inside a board run: there, propose follow-up work with `board add`.',
      ),
    )
    .usage('[options] <prompt...>')
    .argument('<prompt...>', 'what the task should do')
    .passThroughOptions();
  addScheduleOptions(schedule)
    .option('--dry-run', 'read everything, print every write instead of doing it')
    .addHelpText(
      'after',
      examples(
        'board schedule /review-pr 17741',
        'board schedule --priority high /review-pr cosuno/cosuno#17741 --auto',
        'board schedule "Find out why the bidder export is slow and propose a fix"',
        'board schedule --in 2h /review-pr 17741',
        'board schedule --at 09:00 /grill the plan in docs/x.md',
        'board schedule --every 2h --times 5 /sweep the stale branches',
        'board schedule --cron "0 9 * * 1-5" /review-pr --auto',
        'board schedule --hold -- --weird prompt',
      ),
    )
    .action(async (words: string[], flags: ScheduleFlags, command: Command) => {
      notInRun('board schedule is not available inside a board run; use `board add` to propose follow-up work');
      await scheduleCommand(contextOf(command), flags, words);
    });

  dryRunOption(
    program
      .command('schedules')
      .helpGroup(SCHEDULING)
      .summary('list, pause, resume or delete repeating schedules')
      .description(
        paragraphs(
          'Without arguments, list the repeating schedules: id, rule, next run, runs left, paused or ended, title.',
          '`pause <id>` drops the waiting run and stops the schedule, `resume <id>` makes the next run, `rm <id>` deletes the schedule and its waiting run. Changing a schedule is not available inside a board run.',
        ),
      )
      .usage('[options] [pause|resume|rm <id>]')
      .argument('[action...]', 'pause, resume or rm, and the schedule id')
      .addHelpText(
        'after',
        examples('board schedules', 'board schedules pause s1b2c3d4', 'board schedules rm s1b2c3d4'),
      ),
  ).action((words: string[], _options, command: Command) => {
    if (words.length > 0) notInRun('board schedules changes are not available inside a board run');
    return schedules(contextOf(command), words);
  });

  dryRunOption(
    program
      .command('delay')
      .helpGroup(SCHEDULING)
      .summary('delay a task in Todo, or make it due at once')
      .description(
        'Delay a task in Todo until then, or with --now make it due at once. Give exactly one of --in, --at and --now.',
      )
      .argument('<task>', 'the task id')
      .option('--in <duration>', 'start after this long (30m, 2h, 1d, 1h30m)')
      .option('--at <time>', 'start then (2027-01-01T12:00, 2027-01-01, 09:30)')
      .option('--now', 'clear the delay: due at once')
      .addHelpText(
        'after',
        examples('board delay Ab3dEf9x --in 1d', 'board delay Ab3dEf9x --at 09:00', 'board delay Ab3dEf9x --now'),
      ),
  ).action((task: string, flags: DelayFlags, command: Command) => delay(contextOf(command), task, flags));

  const internal = program
    .command('internal', { hidden: true })
    .description('What the dispatcher, the timers and a run call; not for typing')
    .action(() => {
      throw new UsageError('internal needs dispatch, intake, worker or hook');
    });
  const refuseInternalInRun = (): void => notInRun('board internal is not available inside a board run');
  dryRunOption(internal.command('dispatch').description('One dispatcher tick')).action((_options, command: Command) => {
    refuseInternalInRun();
    return dispatchMain({ dryRun: contextOf(command).dryRun });
  });
  dryRunOption(internal.command('intake').description('Review requests to tasks')).action(
    (_options, command: Command) => {
      refuseInternalInRun();
      return intakeMain({ dryRun: contextOf(command).dryRun });
    },
  );
  internal
    .command('worker')
    .description('Run one task')
    .argument('<task>')
    .action((task: string) => {
      refuseInternalInRun();
      return workerMain(task);
    });
  // The hook of a run must never fail its tool call, so nothing it is given is a usage error.
  internal
    .command('hook')
    .description('The PreToolUse hook of a run')
    .argument('[args...]')
    .allowUnknownOption()
    .passThroughOptions()
    .action((args: string[]) => runHook(args));

  program.commandsGroup(SETUP).helpCommand('help [command]', 'show the help of a command');
  return program;
}

function commandPath(command: Command): string[] {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names;
}

// The deepest command the arguments name, to show its usage when they are wrong.
function findCommand(program: Command, args: string[]): Command {
  let command = program;
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const next = command.commands.find((candidate) => candidate.name() === arg || candidate.aliases().includes(arg));
    if (!next) break;
    command = next;
    if (command.commands.length === 0) break;
  }
  return command;
}

function usageDetails(command: Command): string[] {
  const path = commandPath(command);
  if (path.length === 0) return ['usage: board <command> [options]', 'Run "board help" for the commands.'];
  const name = path.join(' ');
  return [`usage: board ${name} ${command.usage()}`, `Run "board help ${name}" for the details.`];
}

// Commander's errors and the actions' UsageErrors become one UsageError that carries the command's usage.
function asUsageError(program: Command, args: string[], error: unknown): unknown {
  const command = findCommand(program, args);
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) return undefined;
    const details = usageDetails(command);
    if (error.code === 'commander.unknownOption' && command.name() === 'schedule')
      details.unshift('To start the prompt with dashes, put -- before it: board schedule -- --weird prompt');
    return new UsageError(error.message.replace(/^error: /, ''), details);
  }
  if (error instanceof UsageError && error.details.length === 0)
    return new UsageError(error.message, usageDetails(command));
  return error;
}

// Runs the command line; throws what `runMain` reports. Help and version output end normally.
export async function runBoard(argv: string[], options: ProgramOptions = {}): Promise<void> {
  const program = buildProgram(options);
  const args = argv.length === 0 ? ['help'] : argv;
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (error) {
    const reported = asUsageError(program, args, error);
    if (reported !== undefined) throw reported;
  }
}
