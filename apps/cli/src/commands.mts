import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { Argument, Command, CommanderError } from 'commander';
import { API_VERSION, STATUSES } from '@agent-board/shared';
import {
  attach,
  add,
  ask,
  comment,
  delay,
  move,
  parseStatus,
  readNoteFile,
  readThread,
  scheduleCommand,
  schedules,
  noteJson,
  scheduleJson,
  selectTasks,
  taskJson,
  show,
  polish,
  tasks,
  wait,
  DEFAULT_CHECK_EVERY,
  DEFAULT_CHECK_TIMEOUT,
} from './board.mts';
import type {
  AddFlags,
  AttachFlags,
  CommentFlags,
  DelayFlags,
  PolishFlags,
  Spawner,
  TasksFlags,
  WaitFlags,
} from './board.mts';
import { CHECK_TIME_LIMIT_MS, createWaitStore } from './waits.mts';
import type { WaitStore } from './waits.mts';
import { buildContext, readStdin, ReportedFailure, UsageError } from './cli.mts';
import type { ContextOptions, LinkingContext } from './cli.mts';
import { verifyContract } from './backend.mts';
import { completionModel, renderCompletion, SHELLS } from './completion.mts';
import type { Shell } from './completion.mts';
import { getPaths } from './config.mts';
import { runDir } from './runtime.mts';
import { dispatchMain } from './dispatch.mts';
import { formatResult, hasFailure, realDoctorDeps, runChecks } from './doctor.mts';
import type { CheckResult, DoctorDeps } from './doctor.mts';
import { clackPrompts, init } from './init.mts';
import type { InitFlags, Prompts } from './init.mts';
import { EXEC_PATH, isCompiledBinary } from './self.mts';
import { realGh, selfUpdate } from './self-update.mts';
import type { SelfUpdateFlags } from './self-update.mts';
import { SystemError } from './system.mts';
import { releaseVersion } from './version.mts';
import { realSetupDeps, setup, unitDirectory, whichOnPath } from './setup.mts';
import type { SetupDeps, SetupFlags } from './setup.mts';
import { runHook } from './hook.mts';
import { resolveScheduleId, resolveTaskId } from './ids.mts';
import { plainLine } from './terminal.mts';
import { intakeMain } from './intake.mts';
import { listenMain } from './listen.mts';
import { addScheduleOptions } from './schedule.mts';
import type { ScheduleFlags } from './schedule.mts';
import { cliVersion } from './version.mts';
import { workerMain } from './worker.mts';

export interface ProgramOptions {
  env?: Record<string, string | undefined>;
  // The context of a command; tests hand over a fake backend.
  context?: (dryRun: boolean, options: ContextOptions) => LinkingContext;
  readStdin?: () => Promise<string>;
  // Starts claude for `attach`; tests must not launch the real one.
  spawnClaude?: Spawner;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  version?: string;
  // The machine under the setup commands; tests replace what would touch it.
  prompts?: Prompts;
  interactive?: boolean;
  hostName?: string;
  now?: () => Date;
  which?: SetupDeps['which'];
  platform?: string;
  // Runs a systemctl call that changes something (daemon-reload, enable).
  runSystem?: SetupDeps['run'];
  // The exit code of a read-only systemctl call.
  systemctlCode?: DoctorDeps['systemctl'];
  verifyServer?: DoctorDeps['verifyServer'];
  // Runs `gh` for self-update.
  gh?: (args: string[]) => Promise<string>;
  // The command line being run, set by runBoard.
  argv?: string[];
  // Where `board wait --check` stores the check, and the directory it runs in.
  waits?: WaitStore;
  cwd?: string;
}

const TASKS = 'Tasks:';
const SCHEDULING = 'Scheduling:';
const SETUP = 'Setup:';

const STATUS_LIST = STATUSES.join(', ');
const TASK_ARGUMENT = 'the task: its id, a board task link or the start of its id';
const ID_NOTE =
  '<task> can be the full id, a link to the task on this board (as the CLI prints it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but not exactly 8, which counts as a whole older id; an exact-case match wins, else case does not matter; it must be unique). Inside a board run only the full id is accepted.';

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
  const argv = options.argv ?? [];
  const stdin = options.readStdin ?? readStdin;
  const makeContext = options.context ?? buildContext;
  const writeOut = options.writeOut ?? ((text: string) => void process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => void process.stderr.write(text));

  const program = new Command('board')
    .enablePositionalOptions()
    .exitOverride()
    .showSuggestionAfterError()
    .configureOutput({ writeOut, writeErr, outputError: () => undefined })
    .configureHelp({ subcommandTerm: overviewTerm })
    .version(`board ${options.version ?? cliVersion()} (api ${API_VERSION})`, '-V, --version', 'print the version')
    .option('--dry-run', 'read everything, print every write instead of doing it')
    .description(
      'Work with the agent board from a terminal, and from inside a run: comment on tasks, move them, schedule new ones.',
    )
    .addHelpText('after', '\nRun "board help <command>" for the details and examples of one command.\n');

  // `strictConfig`: the command binds work to this machine's name, which needs a config.json to mean anything.
  // `json`: stdout holds the JSON document alone, so every other line goes to stderr.
  const contextOf = (command: Command, { strictConfig = false, json = false } = {}): LinkingContext => {
    const dryRun =
      program.opts<{ dryRun?: boolean }>().dryRun === true || command.opts<{ dryRun?: boolean }>().dryRun === true;
    return makeContext(dryRun, {
      optionalConfig: !strictConfig,
      ...(json ? { print: (line: string) => writeErr(`${line}\n`) } : {}),
    });
  };
  const writeJson = (value: unknown): void => writeOut(`${JSON.stringify(value, null, 2)}\n`);
  const inRun = Boolean(env['AGENT_BOARD_TASK']);
  const taskIdOf = (context: LinkingContext, arg: string): Promise<string> =>
    resolveTaskId(context.backend, arg, {
      inRun,
      // The same source as every link the CLI prints.
      boardLinkPrefix: () => context.taskLink('a').slice(0, -1),
    });
  // `readable`: the command lists tasks, notes or schedules, whose values this machine may be unable to decrypt.
  const jsonOptionReadable = (command: Command): Command => jsonOption(command, { readable: true });
  const jsonOption = (command: Command, { readable = false } = {}): Command =>
    command.option(
      '--json',
      readable
        ? 'print JSON on stdout instead of text; a value this machine cannot decrypt is null there and named in "unreadable" (text shows "(cannot decrypt: input)" after the task, and "(cannot decrypt this title)" for a title)'
        : 'print JSON on stdout instead of text',
    );
  // On the old parser a trailing --dry-run meant a dry run; doing the real thing silently would be the wrong direction.
  const refuseDryRunInText = (words: string[], usage: string): void => {
    if (words[0] === '--dry-run' || words.at(-1) === '--dry-run')
      throw new UsageError(`--dry-run goes before the text, not at its start or end: ${usage}`);
  };
  // A run's agent works on untrusted text; a task it schedules would run with the user's full permissions.
  const notInRun = (message: string): void => {
    if (env['AGENT_BOARD_TASK']) throw new UsageError(message);
  };
  // The text of `comment`: the words as written, or stdin for `-`, or a file for `--file <path>`.
  const textOf = async (words: string[]): Promise<string> => {
    if (words[0] === '--file') {
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
    jsonOptionReadable(
      program
        .command('tasks')
        .helpGroup(TASKS)
        .summary('open tasks per status')
        .description(
          'List the open tasks per status, with their id, priority and title, and when a delayed task starts. --all adds the closed ones, --status shows one status.',
        )
        .option('--all', 'closed tasks too')
        .option('--status <status>', `only this status (${STATUS_LIST}; "Needs me" works too)`)
        .addHelpText('after', examples('board tasks', 'board tasks --status needs-me', 'board tasks --all --json')),
    ),
  ).action(async (flags: TasksFlags, command: Command) => {
    const context = contextOf(command, { json: flags.json === true });
    if (flags.json) writeJson((await selectTasks(context, flags)).map(taskJson));
    else await tasks(context, flags);
  });

  dryRunOption(
    jsonOptionReadable(
      program
        .command('show')
        .helpGroup(TASKS)
        .summary('a task and its thread as markdown')
        .description(
          paragraphs(
            'Print a task and its thread (input, questions, answers and notes) as markdown. A resumed run reads this first. With --json, print the task and its notes as JSON.',
            ID_NOTE,
          ),
        )
        .argument('<task>', TASK_ARGUMENT)
        .addHelpText('after', examples('board show Ab3dEf9x', 'board show Ab3 --json')),
    ),
  ).action(async (arg: string, flags: { json?: boolean }, command: Command) => {
    const context = contextOf(command, { json: flags.json === true });
    const id = await taskIdOf(context, arg);
    if (!flags.json) return show(context, id);
    const { task, notes } = await readThread(context, id);
    writeJson({ task: taskJson(task), notes: notes.map(noteJson) });
  });

  dryRunOption(
    program
      .command('attach')
      .helpGroup(TASKS)
      .summary("open a task's Claude session in the terminal")
      .description(
        paragraphs(
          "Run `claude --resume` on the task's session, interactively, in the directory the session ended in. The board hands the session only to the machine whose token ran the task, and not while the task runs: the headless run owns the session, so watch its Transcript on the task page.",
          'Without --fork, the next resume of the task continues the session with what you did in it. --fork starts a forked session, so the session of the board stays as it was. The exit status is that of claude. Not available inside a board run.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .option('--fork', "fork the session (claude --fork-session) so the board's session stays as it was")
      .addHelpText('after', examples('board attach 7sPf438z', 'board attach 7sPf --fork')),
  ).action(async (arg: string, flags: AttachFlags, command: Command) => {
    notInRun('board attach is not available inside a board run');
    const context = contextOf(command);
    await attach(context, await taskIdOf(context, arg), flags, options.spawnClaude);
  });

  dryRunOption(
    program
      .command('comment')
      .helpGroup(TASKS)
      .summary('add a note to a task')
      .description(
        paragraphs(
          "Add a note to the task's thread. The text is every word after the task, quoted or not, and is never read as a flag.",
          '`-` reads the text from stdin; `--file <path>` right after the task reads it from a regular file in /tmp, for long text.',
          '`--suggest <text>` (or `--suggest-file <path>`, a file in /tmp) attaches the reply you expect the user to send next, which the board offers as a one-click answer. Give it before the task, because everything after the task is the note.',
          ID_NOTE,
        ),
      )
      .usage('[options] <task> <text...|-|--file <path>>')
      .argument('<task>', TASK_ARGUMENT)
      .argument('[text...]', 'the note')
      .option('--suggest <text>', "a ready-to-send reply in the user's voice, offered on the board")
      .option('--suggest-file <path>', 'like --suggest, from a regular file in /tmp')
      .passThroughOptions()
      .addHelpText(
        'after',
        examples(
          'board comment Ab3dEf9x "step 3 done"',
          'board comment Ab3dEf9x tests pass, one flaky',
          'board comment Ab3dEf9x --file /tmp/review.md',
          'echo "from a script" | board comment Ab3dEf9x -',
          'board comment Ab3 looks good',
          'board comment --suggest "Yes, open the PR." Ab3dEf9x "Ready: tests pass, diff reviewed."',
        ),
      ),
  ).action(async (arg: string, words: string[], flags: CommentFlags, command: Command) => {
    refuseDryRunInText(words, 'board comment --dry-run <task> <text...>');
    if (flags.suggest !== undefined && flags.suggestFile !== undefined)
      throw new UsageError('give --suggest or --suggest-file, not both');
    const text = await textOf(words);
    const suggestion = flags.suggestFile === undefined ? flags.suggest : readNoteFile(flags.suggestFile);
    const context = contextOf(command);
    await comment(context, await taskIdOf(context, arg), text, suggestion === undefined ? {} : { suggestion });
  });

  dryRunOption(
    program
      .command('move')
      .helpGroup(TASKS)
      .summary('move a task to the bottom of a status')
      .description(
        paragraphs(
          `Move a task to the bottom of a status: ${STATUS_LIST}. "Backlog", "Todo", "Running", "Needs me" and "Done" work too.`,
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .argument('<status...>', 'the status to move it to')
      .addHelpText(
        'after',
        examples('board move Ab3dEf9x needs-me', 'board move Ab3dEf9x Needs me', 'board move Ab3 todo'),
      ),
  ).action(async (arg: string, status: string[], _options, command: Command) => {
    const target = parseStatus(status.join(' '));
    const context = contextOf(command);
    await move(context, await taskIdOf(context, arg), target);
  });

  dryRunOption(
    program
      .command('ask')
      .helpGroup(TASKS)
      .summary('ask the user 1-4 questions')
      .description(
        paragraphs(
          'Ask the user 1-4 questions and move the task to needs-me. The user answers on the board and the run is resumed with the answers.',
          'The questions are JSON in a regular file in /tmp: {"questions": [{"header", "question", "multiSelect", "options": [{"label", "description", "recommended"?}]}]}',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .requiredOption('--file <path>', 'the questions as JSON, in /tmp')
      .addHelpText('after', examples('board ask Ab3dEf9x --file /tmp/pr-Ab3dEf9x-questions.json')),
  ).action(async (arg: string, flags: { file: string }, command: Command) => {
    const context = contextOf(command);
    await ask(context, await taskIdOf(context, arg), flags.file);
  });

  dryRunOption(
    program
      .command('wait')
      .helpGroup(TASKS)
      .summary('park a running task in Waiting until a time or a check')
      .description(
        paragraphs(
          'Inside a run: the task leaves Running for Waiting and frees its slot, while something outside (CI, a deploy) takes its time. End your turn after it. The task goes back to the top of Todo and resumes in its session when the time is up, or when the check passes.',
          `A timer is --in or --at. A check is --check with a shell command that exits 0 once the wait is over: the dispatcher of this machine runs it in this directory every --every (default ${DEFAULT_CHECK_EVERY}, at least 1m; one attempt may take ${CHECK_TIME_LIMIT_MS / 1000} s), with the env of your Claude Code settings, and wakes the task when it passes or after --timeout (default ${DEFAULT_CHECK_TIMEOUT}). The command stays on this machine; the board only learns that the task waits for a check, and until when. A wait lasts at most 7 days.`,
          '--reason says what the task waits for; it goes into the thread.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .option('--in <duration>', 'wake after this long (30m, 2h, 1d, 1h30m)')
      .option('--at <time>', 'wake then (2027-01-01T12:00, 2027-01-01, 09:30)')
      .option('--check <command>', 'wake once this command exits 0')
      .option('--every <duration>', `with --check: how often it runs (default ${DEFAULT_CHECK_EVERY})`)
      .option('--timeout <duration>', `with --check: wake anyway after this long (default ${DEFAULT_CHECK_TIMEOUT})`)
      .option('--reason <text>', 'what the task waits for, for the thread')
      .addHelpText(
        'after',
        examples(
          `board wait Ab3dEf9x --check 'gh pr checks 17741 --required' --reason "CI on #17741"`,
          `board wait Ab3dEf9x --check 'curl -fsS https://staging.example.com/health' --every 5m --timeout 1h`,
          'board wait Ab3dEf9x --in 20m --reason "the deploy settles"',
        ),
      ),
  ).action(async (arg: string, flags: WaitFlags, command: Command) => {
    const context = contextOf(command, { strictConfig: flags.check !== undefined });
    await wait(context, await taskIdOf(context, arg), flags, {
      waits: options.waits ?? createWaitStore(),
      cwd: options.cwd ?? realpathSync(process.cwd()),
      ...(env['AGENT_BOARD_START_DIR'] ? { settingsDir: env['AGENT_BOARD_START_DIR'] } : {}),
      ...(options.now ? { now: options.now() } : {}),
    });
  });

  dryRunOption(
    jsonOption(
      program
        .command('add')
        .helpGroup(TASKS)
        .summary('propose a follow-up task')
        .description(
          paragraphs(
            'Propose a follow-up task; the file is its prompt. It waits in needs-me until the user starts it, and runs in this directory on this machine. With --json, print {"id", "url"} on stdout.',
            ID_NOTE,
          ),
        )
        .requiredOption('--title <title>', "the task's title")
        .requiredOption('--file <path>', 'the prompt, a regular file in /tmp')
        .option('--parent <task>', `the task this follows from (${TASK_ARGUMENT})`)
        .option('--priority <priority>', 'urgent, high, normal or low (default normal)')
        .addHelpText(
          'after',
          examples('board add --title "Fix the flaky test" --file /tmp/prompt.md --parent Ab3dEf9x'),
        ),
    ),
  ).action(async (flags: AddFlags & { json?: boolean }, command: Command) => {
    const context = contextOf(command, { strictConfig: true, json: flags.json === true });
    const parent = flags.parent === undefined ? undefined : await taskIdOf(context, flags.parent);
    const task = await add(context, { ...flags, ...(parent === undefined ? {} : { parent }) });
    if (flags.json) writeJson({ id: task.id, url: context.taskLink(task.id) });
  });

  dryRunOption(
    program
      .command('polish')
      .helpGroup(TASKS)
      .summary('post a polished title and prompt for a task')
      .description(
        paragraphs(
          'Post a polished title and prompt for <task>, a backlog task, on the thread of the task this run is for. It changes nothing: the user reads it on the board and applies it, which seals the text as theirs. The file is the new prompt, a regular file in /tmp. Only available inside a board run.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .requiredOption('--title <title>', 'the polished title, one line')
      .requiredOption('--file <path>', 'the polished prompt, a regular file in /tmp')
      .addHelpText('after', examples('board polish Ab3dEf9x --title "Fix the export" --file /tmp/prompt.md')),
  ).action(async (arg: string, flags: PolishFlags, command: Command) => {
    const run = env['AGENT_BOARD_TASK'];
    if (!run) throw new UsageError('board polish only works inside a board run: it posts on the task the run is for');
    const context = contextOf(command, { strictConfig: true });
    await polish(context, run, await taskIdOf(context, arg), flags);
  });

  const schedule = program
    .command('schedule')
    .helpGroup(SCHEDULING)
    .summary('a task from a prompt, run here on this machine')
    .description(
      paragraphs(
        'Make a task of the prompt, written as you would type it into Claude Code, bound to this machine and this directory. Prints its URL. A quick Haiku call first checks whether an open task already covers it; --new skips that.',
        'The flags come first; everything from the first other word on is the prompt, flags included (`--auto` below goes to the skill). To start the prompt with dashes, put -- before it.',
        '--in or --at keeps the task in Todo until then. --every or --cron makes a repeating schedule instead, starting at --in/--at (default now), for --times runs or until --until, else forever.',
        'With --json, print {"id", "url"} of the task on stdout; everything else goes to stderr. Not available inside a board run: there, propose follow-up work with `board add`.',
      ),
    )
    .usage('[options] <prompt...>')
    .argument('<prompt...>', 'what the task should do')
    .passThroughOptions();
  jsonOption(addScheduleOptions(schedule).option('--dry-run', 'read everything, print every write instead of doing it'))
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
        'board schedule --json /review-pr 17741',
      ),
    )
    .action(async (words: string[], flags: ScheduleFlags & { json?: boolean }, command: Command) => {
      notInRun('board schedule is not available inside a board run; use `board add` to propose follow-up work');
      // Commander drops a `--`, so the raw arguments tell whether the person wrote one before a prompt that ends in --dry-run.
      const afterCommand = argv.slice(argv.indexOf('schedule') + 1);
      if (words.at(-1) === '--dry-run' && !afterCommand.includes('--'))
        throw new UsageError(
          'the prompt ends in --dry-run: put --dry-run before the prompt (board schedule --dry-run <prompt...>), or put -- before a prompt that really ends in it',
        );
      const context = contextOf(command, { strictConfig: true, json: flags.json === true });
      const task = await scheduleCommand(context, flags, words);
      if (flags.json)
        writeJson(
          task
            ? {
                id: task.id,
                url: context.taskLink(task.id),
                ...(task.scheduleId ? { scheduleId: task.scheduleId } : {}),
              }
            : null,
        );
    });

  dryRunOption(
    jsonOptionReadable(
      program
        .command('schedules')
        .helpGroup(SCHEDULING)
        .summary('list, pause, resume or delete repeating schedules')
        .description(
          paragraphs(
            'Without arguments, list the repeating schedules: id, rule, next run, runs left, paused or ended, title; --json prints them as JSON.',
            '`pause <id>` drops the waiting run and stops the schedule, `resume <id>` makes the next run, `rm <id>` deletes the schedule and its waiting run. Changing a schedule is not available inside a board run. The id can be the start of it (3 to 7 or 9 to 11 characters; 8 and 12 are whole ids) outside a run.',
          ),
        )
        .usage('[options] [pause|resume|rm <id>]')
        .argument('[action...]', 'pause, resume or rm, and the schedule id')
        .addHelpText(
          'after',
          examples(
            'board schedules',
            'board schedules --json',
            'board schedules pause s1b2c3d4',
            'board schedules rm s1b',
          ),
        ),
    ),
  ).action(async (words: string[], flags: { json?: boolean }, command: Command) => {
    if (words.length > 0) notInRun('board schedules changes are not available inside a board run');
    const context = contextOf(command, { json: flags.json === true });
    if (flags.json) {
      if (words.length > 0) throw new UsageError('--json only prints the list of schedules');
      return writeJson((await context.backend.listSchedules()).map(scheduleJson));
    }
    const [action, arg, ...rest] = words;
    const changes = action === 'pause' || action === 'resume' || action === 'rm';
    const id = arg === undefined || !changes ? undefined : await resolveScheduleId(context.backend, arg, { inRun });
    return schedules(context, id === undefined ? words : [action ?? '', id, ...rest]);
  });

  dryRunOption(
    program
      .command('delay')
      .helpGroup(SCHEDULING)
      .summary('delay a task in Todo, or make it due at once')
      .description(
        paragraphs(
          'Delay a task in Todo until then, or with --now make it due at once. Give exactly one of --in, --at and --now.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .option('--in <duration>', 'start after this long (30m, 2h, 1d, 1h30m)')
      .option('--at <time>', 'start then (2027-01-01T12:00, 2027-01-01, 09:30)')
      .option('--now', 'clear the delay: due at once')
      .addHelpText(
        'after',
        examples('board delay Ab3dEf9x --in 1d', 'board delay Ab3 --at 09:00', 'board delay Ab3dEf9x --now'),
      ),
  ).action(async (arg: string, flags: DelayFlags, command: Command) => {
    const context = contextOf(command);
    await delay(context, await taskIdOf(context, arg), flags);
  });

  const out = (line: string): void => writeOut(`${line}\n`);
  const systemctlCode: DoctorDeps['systemctl'] =
    options.systemctlCode ??
    ((args) =>
      new Promise<number>((resolve) => {
        execFile('systemctl', args, (error) =>
          resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : 1),
        );
      }));
  const setupDeps = (): SetupDeps => ({
    ...realSetupDeps(env, out),
    ...(options.which ? { which: options.which } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.runSystem ? { run: options.runSystem } : {}),
    unitEnabled: async (unit) => (await systemctlCode(['--user', 'is-enabled', unit])) === 0,
  });
  const doctorDeps = (): DoctorDeps => {
    const { configDir } = getPaths(env);
    const systemctl = systemctlCode;
    const which = options.which ?? ((program: string) => whichOnPath(program, env['PATH']));
    return {
      ...realDoctorDeps(configDir, unitDirectory(env), systemctl, which, homedir(), options.which),
      verifyServer: options.verifyServer ?? ((config) => verifyContract(config)),
    };
  };
  const reportChecks = (results: CheckResult[], json: boolean): void => {
    if (json) writeJson(results);
    else for (const result of results) out(formatResult(result));
    if (hasFailure(results)) throw new ReportedFailure('a check failed');
  };

  program
    .command('init')
    .helpGroup(SETUP)
    .summary('write web.json, env and config.json for this machine')
    .description(
      paragraphs(
        "Set this machine up for the board: write web.json (the board's URL), env (the machine token and the data key, mode 600) and, if it is missing, config.json (from the example, with this machine's name). Then run the checks of `board doctor`.",
        'Set up encryption in the browser first: init asks for the data key from the board\'s Settings page as well as the token. The page offers the env lines to copy (`AGENT_BOARD_TOKEN=…`, `AGENT_BOARD_DATA_KEY=…`). At a prompt paste one line: the bare value, or its own line (a prompt takes one line, so the other line is refused, naming which one it wants); a file or pipe given with --token-file or --data-key-file may hold both lines. Without flags it asks. For a script give --url, --token-file and --data-key-file: a secret never goes on the command line, where it would land in the shell history. A secret file must be mode 600 or 400 like env, which a pipe is: `printf %s "$TOKEN" | board init --url … --token-file /dev/stdin --data-key-file ~/key`; only one of the two can be /dev/stdin. --machine defaults to the host name.',
        'A file that exists is kept unless --force, which copies it to <name>.bak-<timestamp> first (an env backup is mode 600 at most) and keeps what you do not give again: the URL, the token, the data key and any other line of env. An env that has the token but no data key (or the reverse) is completed without --force: init asks for the missing value only. config.json is never replaced.',
        'Not available inside a board run.',
      ),
    )
    .option('--url <url>', "the board's URL (https, or http for localhost)")
    .option(
      '--token-file <path>',
      'read the machine token from this file: the bare token or the env line(s) the Settings page offers (mode 600 or 400, or a pipe)',
    )
    .option(
      '--data-key-file <path>',
      'read the data key from this file: the bare key or the env line(s) the Settings page offers (mode 600 or 400, or a pipe)',
    )
    .option('--machine <name>', "this machine's name on the board (default: the host name)")
    .option('--force', 'replace web.json and env after backing them up')
    .addHelpText(
      'after',
      examples(
        'board init',
        'printf %s "$TOKEN" | board init --url https://board.example.com --token-file /dev/stdin --data-key-file ~/key --machine laptop',
      ),
    )
    .action(async (flags: InitFlags) => {
      notInRun('board init is not available inside a board run');
      const { configDir } = getPaths(env);
      await init(
        {
          configDir,
          interactive: options.interactive ?? process.stdin.isTTY === true,
          prompts: options.prompts ?? clackPrompts(),
          hostName: options.hostName ?? hostname().split('.')[0] ?? 'machine',
          now: options.now ?? (() => new Date()),
          print: out,
        },
        flags,
      );
      out('');
      const results = await runChecks(doctorDeps());
      for (const result of results) out(formatResult(result));
      out('\nNext, on a worker machine: board setup');
      if (hasFailure(results)) throw new ReportedFailure('a check failed');
    });

  jsonOption(
    program
      .command('doctor')
      .helpGroup(SETUP)
      .summary('check this machine: config, token, server, worker tools and units')
      .description(
        paragraphs(
          'Check this machine, read-only, one line per check: ✓ passes, ✗ fails (with a fix), ! is a warning. Exit 1 if any check fails; warnings alone exit 0. The token is never printed.',
          'Checks: Node 24+ (checkout only), the config directory, web.json, env (mode 600 or 400, token, data key), the board (reachable, token accepted, API version range, and whether it has a data key and this machine holds the same one), config.json, and for a worker machine claude, gh, flock, systemd-run, systemctl and the installed units with their timers and the listener. The worker checks only warn on a machine with no unit installed.',
        ),
      )
      .addHelpText('after', examples('board doctor', 'board doctor --json')),
  ).action(async (flags: { json?: boolean }) => {
    reportChecks(await runChecks(doctorDeps()), flags.json === true);
  });

  program
    .command('setup')
    .helpGroup(SETUP)
    .summary('install the dispatch and intake timers and the listener as systemd user units')
    .description(
      paragraphs(
        'Install this machine as a worker: write the dispatch and intake services and timers and the listener service into ~/.config/systemd/user (or $XDG_CONFIG_HOME/systemd/user) as copies, run `systemctl --user daemon-reload` and print the line that enables them. The listener holds a stream to the board and starts a dispatch tick within a second of a change; the timers stay as the fallback. Run it again after moving the binary or the checkout, or upgrading Node. It needs Linux with systemd and flock.',
        'The services run this CLI the way `board setup` was started: the binary, or the checkout with its Node. --print shows the units and changes nothing; --enable also enables and starts the timers and the listener. When an installed unit differs from what it writes, the differing lines are shown. It refuses unless --force when this checkout is not the one the installed ~/.local/bin/board runs from (a worktree, a scratch copy), or when a binary runs from the temp directory, so it cannot take over the live timers. Not available inside a board run.',
      ),
    )
    .option('--enable', 'also enable and start the timers and the listener')
    .option(
      '--force',
      'install although this checkout is not the installed one, or the binary runs from the temp directory',
    )
    .option('--print', 'print the units and change nothing')
    .addHelpText('after', examples('board setup', 'board setup --print', 'board setup --enable'))
    .action(async (flags: SetupFlags) => {
      notInRun('board setup is not available inside a board run');
      await setup(setupDeps(), flags);
    });

  program
    .command('self-update')
    .helpGroup(SETUP)
    .summary('replace this binary with the newest release')
    .description(
      paragraphs(
        'Download the newest cli-v* release of codeplant-de/agent-board with `gh`, check it against SHA256SUMS and replace this binary with it. Running workers keep the old file until they end. --check only reports whether a newer release exists.',
        'It needs `gh`, logged in. A checkout is updated with `git pull` and `pnpm install` instead, and says so. Not available inside a board run.',
      ),
    )
    .option('--check', 'only report whether a newer release exists')
    .addHelpText('after', examples('board self-update --check', 'board self-update'))
    .action(async (flags: SelfUpdateFlags) => {
      notInRun('board self-update is not available inside a board run');
      await selfUpdate(
        {
          compiled: isCompiledBinary(),
          version: releaseVersion(),
          execPath: EXEC_PATH,
          platform: options.platform ?? process.platform,
          arch: process.arch,
          gh: options.gh ?? realGh(env),
          print: out,
        },
        flags,
      );
    });

  program
    .command('completion')
    .helpGroup(SETUP)
    .summary('print a shell completion script')
    .description(
      paragraphs(
        'Print a completion script for bash, zsh or fish: commands, flags, statuses and priorities, and the ids of your tasks and schedules (asked from the board, with a 2 second limit).',
        'Install it once:\n  bash: board completion bash > ~/.local/share/bash-completion/completions/board\n  zsh:  board completion zsh > "${fpath[1]}/_board"   (a directory on your fpath)\n  fish: board completion fish > ~/.config/fish/completions/board.fish',
      ),
    )
    .addArgument(new Argument('<shell>', 'bash, zsh or fish').choices(SHELLS))
    .addHelpText('after', examples('board completion bash', 'eval "$(board completion zsh)"'))
    .action((shell: Shell) => {
      writeOut(renderCompletion(shell, completionModel(program)));
    });

  // What a completion script asks for: `id<TAB>title` lines. Any failure, a missing config, no network or a run, prints nothing.
  program
    .command('__complete', { hidden: true })
    .argument('[kind]')
    .allowExcessArguments()
    .action(async (kind: string | undefined) => {
      if (inRun) return;
      const limitMs = 2000;
      try {
        const context = makeContext(false, { optionalConfig: true, timeoutMs: limitMs });
        const lines = async (): Promise<string[]> => {
          const oneLine = (text: string): string => plainLine(text.replace(/\s+/g, ' '));
          if (kind === 'tasks')
            return (await context.backend.listTasks()).map((task) => `${task.id}\t${oneLine(task.title)}`);
          if (kind === 'schedules')
            return (await context.backend.listSchedules()).map((item) => `${item.id}\t${oneLine(item.title)}`);
          return [];
        };
        const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), limitMs).unref());
        for (const line of await Promise.race([lines().catch(() => []), timeout])) out(line);
      } catch {
        // Completion stays silent: a broken prompt is worse than a missing suggestion.
      }
    });

  const internal = program
    .command('internal', { hidden: true })
    .description('What the dispatcher, the timers and a run call; not for typing')
    .action(() => {
      throw new UsageError('internal needs dispatch, intake, listen, worker or hook');
    });
  const refuseInternalInRun = (): void => {
    notInRun('board internal is not available inside a board run');
    const platform = options.platform ?? process.platform;
    if (platform !== 'linux')
      throw new SystemError(`board internal runs worker machines and needs Linux with systemd; this is ${platform}`);
  };
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
    .command('listen')
    .description('Run a dispatch tick when the board says tasks changed')
    .action(() => {
      refuseInternalInRun();
      return listenMain();
    });
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
    .action((args: string[]) => {
      // `Bash(board *)` reaches this: a run may only touch its own task's files.
      const run = env['AGENT_BOARD_TASK'];
      if (run && (args[1] !== run || args[0] !== runDir(env))) return;
      return runHook(args);
    });

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
    if (error.code === 'commander.help') return new UsageError('a command is required', usageDetails(command));
    const details = usageDetails(command);
    if (error.code === 'commander.unknownOption' && command.name() === 'schedule')
      details.unshift('To start the prompt with dashes, put -- before it: board schedule -- --weird prompt');
    return new UsageError(error.message.replace(/^error: /, ''), details);
  }
  if (error instanceof UsageError && error.details.length === 0)
    return new UsageError(error.message, usageDetails(command));
  return error;
}

// A bare `board` shows the overview, and `board help nosuch` is an unknown command like `board nosuch`.
function commandLine(program: Command, argv: string[]): string[] {
  if (argv.every((arg) => arg === '--dry-run')) return [...argv, 'help'];
  const [first, topic] = argv;
  const known = (name: string): boolean => program.commands.some((command) => command.name() === name);
  return first === 'help' && topic !== undefined && !known(topic) ? [topic] : argv;
}

// Runs the command line; throws what `runMain` reports. Help and version output end normally.
export async function runBoard(argv: string[], options: ProgramOptions = {}): Promise<void> {
  const program = buildProgram({ ...options, argv });
  const args = commandLine(program, argv);
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (error) {
    const reported = asUsageError(program, args, error);
    if (reported !== undefined) throw reported;
  }
}
