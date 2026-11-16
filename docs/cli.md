# `board` command reference

`<task>` is a task id; outside a run it can also be a link to the task on the board or the start of an id (3 to 7 or 9 to 11 characters, unique; an id is 12 characters, or 8 for older tasks, and those lengths are whole ids). A link counts only when it is `<web.json url>/t/<id>`, the form the CLI prints. `--json` prints tasks, threads and schedules as JSON for scripts. `--dry-run` reads everything and prints every write as `DRY ...` instead of doing it. A usage error exits 2, any other failure 1. `dispatch` is `board internal dispatch`, started by the timer; a checkout's wrapper `apps/cli/bin/dispatch` takes its own lock (`$XDG_RUNTIME_DIR/agent-board-dispatch.lock`, the one the unit uses), so a run by hand cannot overlap a timer run. When the lock is held they exit 75 without output.

A file given with `--file` (`comment`, `ask`, `add`) is read only from a regular file in `/tmp` (`/private/tmp` on macOS) with no other hard link, without following a link.

The reference below is generated from the program (`pnpm --filter @agent-board/cli run docs`), as `board help <command>` shows it.

<!-- commands:start -->

```
Usage: board [options] [command]

Work with the agent board from a terminal, and from inside a run: comment on
tasks, move them, schedule new ones.

Options:
  -V, --version             print the version
  --dry-run                 read everything, print every write instead of doing
                            it
  -h, --help                display help for command

Tasks:
  tasks                     open tasks per status
  show <task>               a task and its thread as markdown
  attach <task>             open a task's Claude session in the terminal
  comment <task> [text...]  add a note to a task
  pr <task> <url>           report the pull request you opened for a task
  move <task> <status...>   move a task to the bottom of a status
  ask <task>                ask the user 1-4 questions
  wait <task>               park a running task in Waiting until a time or a
                            check
  add                       propose a follow-up task
  polish <task>             post a polished title and prompt for a task

Scheduling:
  schedule <prompt...>      a task from a prompt, run here on this machine
  schedules [action...]     list, pause, resume or delete repeating schedules
  delay <task>              delay a task in Todo, or make it due at once

Setup:
  dirs [action...]          list, add, remove or set up the directories workers
                            may run in on this machine
  init                      write web.json, env and config.json for this machine
  doctor                    check this machine: config, token, server, worker
                            tools and units
  setup                     install the dispatch timer and the listener: systemd
                            user units, or launchd agents on macOS
  self-update               replace this binary with the newest release
  completion <shell>        print a shell completion script
  example [name]            list or print the example files that ship with the
                            CLI
  help [command]            show the help of a command

Run "board help <command>" for the details and examples of one command.
```

## Tasks

### board tasks

```
Usage: board tasks [options]

List the open tasks per status, with their id, priority and title, and when a
delayed task starts. --all adds the closed ones, --status shows one status.

Options:
  --all              closed tasks too
  --status <status>  only this status (backlog, todo, running, waiting,
                     needs-me, done; "Needs me" works too)
  --json             print JSON on stdout instead of text; a value this machine
                     cannot decrypt is null there and named in "unreadable"
                     (text shows "(cannot decrypt: input)" after the task, and
                     "(cannot decrypt this title)" for a title)
  --dry-run          read everything, print every write instead of doing it
  -h, --help         display help for command

Examples:
  board tasks
  board tasks --status needs-me
  board tasks --all --json
```

### board show

```
Usage: board show [options] <task>

Print a task and its thread (input, questions, answers and notes) as markdown. A
resumed run reads this first. With --json, print the task and its notes as JSON.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id

Options:
  --json      print JSON on stdout instead of text; a value this machine cannot
              decrypt is null there and named in "unreadable" (text shows
              "(cannot decrypt: input)" after the task, and "(cannot decrypt
              this title)" for a title)
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board show Ab3dEf9x
  board show Ab3 --json
```

### board attach

```
Usage: board attach [options] <task>

Run `claude --resume` on the task's session, interactively, in the directory the
session ended in. The board hands the session only to the machine whose token
ran the task, and not while the task runs: the headless run owns the session, so
watch its Transcript on the task page.

Without --fork, the next resume of the task continues the session with what you
did in it. --fork starts a forked session, so the session of the board stays as
it was. The exit status is that of claude. Not available inside a board run.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id

Options:
  --fork      fork the session (claude --fork-session) so the board's session
              stays as it was
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board attach 7sPf438z
  board attach 7sPf --fork
```

### board comment

```
Usage: board comment [options] <task> <text...|-|--file <path>>

Add a note to the task's thread. The text is every word after the task, quoted
or not, and is never read as a flag.

`-` reads the text from stdin; `--file <path>` right after the task reads it
from a regular file in /tmp, for long text.

`--suggest <text>` (or `--suggest-file <path>`, a file in /tmp) attaches the
reply you expect the user to send next, which the board offers as a one-click
answer. Give it before the task, because everything after the task is the note.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task                   the task: its id, a board task link or the start of its
                         id
  text                   the note

Options:
  --suggest <text>       a ready-to-send reply in the user's voice, offered on
                         the board
  --suggest-file <path>  like --suggest, from a regular file in /tmp
  --dry-run              read everything, print every write instead of doing it
  -h, --help             display help for command

Examples:
  board comment Ab3dEf9x "step 3 done"
  board comment Ab3dEf9x tests pass, one flaky
  board comment Ab3dEf9x --file /tmp/review.md
  echo "from a script" | board comment Ab3dEf9x -
  board comment Ab3 looks good
  board comment --suggest "Yes, open the PR." Ab3dEf9x "Ready: tests pass, diff reviewed."
```

### board pr

```
Usage: board pr [options] <task> <url>

Inside a run: after you open a pull request for this task, report its URL. The
board then shows it on the task's card and page, like the pull request of a
review task. A later call replaces the earlier URL.

The URL must be a GitHub pull request,
https://github.com/<owner>/<repo>/pull/<number>, and nothing else.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id
  url         the pull request URL

Options:
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board pr Ab3dEf9x https://github.com/acme/app/pull/17741
```

### board move

```
Usage: board move [options] <task> <status...>

Move a task to the bottom of a status: backlog, todo, running, waiting,
needs-me, done. "Backlog", "Todo", "Running", "Needs me" and "Done" work too.

--expect <status> moves the task only while it is in that status: for a script
that decided from a listing. When the task has moved on it prints a message and
exits 3, writing nothing. It is not available inside a board run.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task               the task: its id, a board task link or the start of its id
  status             the status to move it to

Options:
  --expect <status>  move it only while it is in this status; exit 3 when it is
                     not
  --dry-run          read everything, print every write instead of doing it
  -h, --help         display help for command

Examples:
  board move Ab3dEf9x needs-me
  board move Ab3dEf9x Needs me
  board move Ab3 todo
  board move Ab3dEf9x done --expect todo
```

### board ask

```
Usage: board ask [options] <task>

Ask the user 1-4 questions and move the task to needs-me. The user answers on
the board and the run is resumed with the answers.

The questions are JSON in a regular file in /tmp: {"questions": [{"header",
"question", "multiSelect", "options": [{"label", "description",
"recommended"?}]}]}

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task           the task: its id, a board task link or the start of its id

Options:
  --file <path>  the questions as JSON, in /tmp
  --dry-run      read everything, print every write instead of doing it
  -h, --help     display help for command

Examples:
  board ask Ab3dEf9x --file /tmp/pr-Ab3dEf9x-questions.json
```

### board wait

```
Usage: board wait [options] <task>

Inside a run: the task leaves Running for Waiting and frees its slot, while
something outside (CI, a deploy) takes its time. End your turn after it. The
task goes back to the top of Todo and resumes in its session when the time is
up, or when the check passes.

A timer is --in or --at. A check is --check with a shell command that exits 0
once the wait is over: the dispatcher of this machine runs it in this directory
every --every (default 2m, at least 1m; one attempt may take 45 s), with the env
of your Claude Code settings, and wakes the task when it passes or after
--timeout (default 2h). The command stays on this machine; the board only learns
that the task waits for a check, and until when. A wait lasts at most 7 days.

--reason says what the task waits for; it goes into the thread.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task                  the task: its id, a board task link or the start of its
                        id

Options:
  --in <duration>       wake after this long (30m, 2h, 1d, 1h30m)
  --at <time>           wake then (2027-01-01T12:00, 2027-01-01, 09:30)
  --check <command>     wake once this command exits 0
  --every <duration>    with --check: how often it runs (default 2m)
  --timeout <duration>  with --check: wake anyway after this long (default 2h)
  --reason <text>       what the task waits for, for the thread
  --dry-run             read everything, print every write instead of doing it
  -h, --help            display help for command

Examples:
  board wait Ab3dEf9x --check 'gh pr checks 17741 --required' --reason "CI on #17741"
  board wait Ab3dEf9x --check 'curl -fsS https://staging.example.com/health' --every 5m --timeout 1h
  board wait Ab3dEf9x --in 20m --reason "the deploy settles"
```

### board add

```
Usage: board add [options]

Propose a follow-up task; the file is its prompt. It waits in backlog until the
user starts it, and runs in this directory on this machine. With --json, print
{"id", "url"} on stdout.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Options:
  --title <title>        the task's title
  --file <path>          the prompt, a regular file in /tmp
  --parent <task>        the task this follows from (the task: its id, a board
                         task link or the start of its id)
  --priority <priority>  urgent, high, normal or low (default normal)
  --json                 print JSON on stdout instead of text
  --dry-run              read everything, print every write instead of doing it
  -h, --help             display help for command

Examples:
  board add --title "Fix the flaky test" --file /tmp/prompt.md --parent Ab3dEf9x
```

### board polish

```
Usage: board polish [options] <task>

Post a polished title and prompt for <task>, a backlog task, on the thread of
the task this run is for. It changes nothing: the user reads it on the board and
applies it, which seals the text as theirs. The file is the new prompt, a
regular file in /tmp. Only available inside a board run.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task             the task: its id, a board task link or the start of its id

Options:
  --title <title>  the polished title, one line
  --file <path>    the polished prompt, a regular file in /tmp
  --dry-run        read everything, print every write instead of doing it
  -h, --help       display help for command

Examples:
  board polish Ab3dEf9x --title "Fix the export" --file /tmp/prompt.md
```

## Scheduling

### board schedule

```
Usage: board schedule [options] <prompt...>

Make a task of the prompt, written as you would type it into Claude Code, bound
to this machine and this directory. Prints its URL. A quick Haiku call first
checks whether an open task already covers it; --new skips that.

The flags come first; everything from the first other word on is the prompt,
flags included (`--auto` below goes to the skill). To start the prompt with
dashes, put -- before it.

--in or --at keeps the task in Todo until then. --every or --cron makes a
repeating schedule instead, starting at --in/--at (default now), for --times
runs or until --until, else forever.

--polish parks the task in Backlog and queues a second task, "Polish prompt:
<title>", that asks an agent to turn the prompt into a complete plan, as the
Polish prompt button on the board does. Apply the result from that task's page.
It cannot be combined with --hold, --in, --at or a repeat.

--key <key> is for scripts that run `board schedule` again and again: the board
keeps one task per key (the key itself never leaves this machine), so a second
call finds the first instead of making another, and the duplicate check is
skipped. It cannot be combined with a repeat, --polish, --hold, --backlog, --in
or --at. It prints `created`, `exists` or `requeued`, the task id and URL, and
for exists the reason in parentheses, and exits 0 for all of them. A task that
was closed is `exists (closed)` and never made again.

With --version <v> (a PR head sha, say) the task remembers what it was made for.
When it differs and the task waits in Needs me or is Done, the task goes back to
Todo with a note "New version" (`requeued`). Otherwise it is `exists` with the
reason same-version, no-version (no --version given), busy (Todo, Running,
Waiting or Backlog), changed (the task moved while this ran) or other-agent (it
runs as another --agent than this call names, which cannot be changed later).

With --json, print {"id", "url"} of the task on stdout (and "polishId",
"polishUrl" with --polish; "result", "status" and "reason" with --key);
everything else goes to stderr. Not available inside a board run: there, propose
follow-up work with `board add`.

Arguments:
  prompt                 what the task should do

Options:
  --priority <priority>  urgent, high, normal, low (default normal)
  --model <model>        claude model alias or full name, e.g. fable, opus,
                         sonnet, haiku (default: claude's default)
  --agent <name>         run the task as this agent of this machine's
                         config.json (its tools and lists only, never asking);
                         the board keeps the name sealed
  --title <title>        the task's title (default: the prompt's first line)
  --hold                 land it in needs-me instead of Todo
  --backlog              park it in backlog instead of Todo
  --in <duration>        keep it in Todo for this long (30m, 2h, 1d, 1h30m);
                         with a repeat, the first run
  --at <time>            keep it in Todo until then (2027-01-01T12:00,
                         2027-01-01, 09:30); with a repeat, the first run
  --every <duration>     repeat on a fixed grid from the first run (2h)
  --cron <expr>          repeat by a 5-field cron expression in this machine's
                         time zone ("0 9 * * 1-5")
  --times <n>            end a repeat after this many runs, the first included
  --until <time>         end a repeat after this time
  --polish               park it in backlog and queue a task that polishes its
                         prompt, as "Polish prompt" on the board
  --new                  skip the duplicate check
  --key <key>            one task per key on the board: a second schedule with
                         the same key finds the first instead of making another,
                         with no duplicate check
  --version <version>    with --key: what the task was made for (a PR head sha);
                         a task in needs-me or done goes back to Todo when it
                         differs
  --dry-run              read everything, print every write instead of doing it
  --json                 print JSON on stdout instead of text
  -h, --help             display help for command

Examples:
  board schedule /review-pr 17741
  board schedule --priority high /review-pr cosuno/cosuno#17741 --auto
  board schedule --model opus "Find out why the bidder export is slow and propose a fix"
  board schedule "Find out why the bidder export is slow and propose a fix"
  board schedule --in 2h /review-pr 17741
  board schedule --at 09:00 /grill the plan in docs/x.md
  board schedule --every 2h --times 5 /sweep the stale branches
  board schedule --cron "0 9 * * 1-5" /review-pr --auto
  board schedule --polish "bidder export should include postal codes"
  board schedule --hold -- --weird prompt
  board schedule --json /review-pr 17741
  board schedule --agent reviewer --key https://github.com/o/r/pull/7 --version 3f9c2ab --json /review-pr https://github.com/o/r/pull/7 --auto
```

### board schedules

```
Usage: board schedules [options] [pause|resume|rm <id>]

Without arguments, list the repeating schedules: id, rule, next run, runs left,
paused or ended, title; --json prints them as JSON.

`pause <id>` drops the waiting run and stops the schedule, `resume <id>` makes
the next run, `rm <id>` deletes the schedule and its waiting run. Changing a
schedule is not available inside a board run. The id can be the start of it (3
to 7 or 9 to 11 characters; 8 and 12 are whole ids) outside a run.

Arguments:
  action      pause, resume or rm, and the schedule id

Options:
  --json      print JSON on stdout instead of text; a value this machine cannot
              decrypt is null there and named in "unreadable" (text shows
              "(cannot decrypt: input)" after the task, and "(cannot decrypt
              this title)" for a title)
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board schedules
  board schedules --json
  board schedules pause s1b2c3d4
  board schedules rm s1b
```

### board delay

```
Usage: board delay [options] <task>

Delay a task in Todo until then, or with --now make it due at once. Give exactly
one of --in, --at and --now.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task             the task: its id, a board task link or the start of its id

Options:
  --in <duration>  start after this long (30m, 2h, 1d, 1h30m)
  --at <time>      start then (2027-01-01T12:00, 2027-01-01, 09:30)
  --now            clear the delay: due at once
  --dry-run        read everything, print every write instead of doing it
  -h, --help       display help for command

Examples:
  board delay Ab3dEf9x --in 1d
  board delay Ab3 --at 09:00
  board delay Ab3dEf9x --now
```

## Setup

### board dirs

```
Usage: board dirs [options] [list | add [path] | rm [path] | set <key> <value> [path] | unset <key> [path]]

Manage the `dirs` list of this machine's config.json: the directories workers
may run in. Without a `dirs` key nothing is limited; once the key exists, even
as `{}`, workers run only in a listed directory or one below it. Without
arguments (or with `list`), print the entries, marking one whose directory is
gone as missing. `add [path]` lists the real path of a directory (default: the
current one); `rm [path]` unlists one. `set <key> <value> [path]` and `unset
<key> [path]` change one setting of a listed directory (below). A path is
relative to the current directory.

`add` refuses `/` and a path that is not a directory, warns about the home
directory (it allows everything below it), and notes when a parent is already
listed. `add --from-config` lists the directories the config already routes to:
`defaultCwd`, every lane `cwd` and every `repos` checkout that exists, skipping
those a listed directory covers and never listing `/` or the home directory.

`rm` asks the board for open tasks and schedules of this machine that run in the
directory and in no other listed one, and refuses while there are any, and when
the board cannot be reached; --force removes it anyway and needs no board. The
list is enforced as soon as it exists, even empty: a worker refuses to start a
task outside it, a run that ends outside it keeps the directory it started in,
and `board schedule` and `board add` refuse (`board add` falls back to the
directory the run started in) outside it. `add`, `rm`, `set` and `unset` rewrite
the `dirs` key of config.json and nothing else (the settings of the other
entries stay as they are), and are not available inside a board run.

A listed directory can carry four settings. `label` (1 to 64 characters) is a
short name the New task form shows with the path, and the only setting the board
is sent. `repo` (owner/name) makes the directory the checkout of that
repository, like a `repos` entry. `default` (the value is `true`) makes it the
directory of tasks that have none, like `defaultCwd`; one directory has it.
`lane` (a lane of this config) makes it the directory of that lane's tasks
without one, like the lane's `cwd`; one directory per lane. A setting wins over
the old key it stands for (`repos`, `defaultCwd`, a lane `cwd`), and `set`
refuses one that another directory has: `unset` it there first. `list` shows
each entry's settings; `rm` says which of repo, default and lane go with the
entry.

The board gets a copy of the list, for the New task form to offer: the listed
directories that exist, sent by `add`, `rm`, `set` and `unset` and by every
dispatch tick when it changed, each with its label. The copy is advice; workers
read only this machine's config.json. If the board cannot be reached, they still
succeed, warn, and leave it to the next dispatch tick.

Arguments:
  action         list, add, rm, set or unset, and a path, or a setting and its
                 value

Options:
  --from-config  add: list the directories the config already routes to
  --force        rm: remove although work of this machine still runs there, or
                 the board cannot be checked
  --dry-run      read everything, print every write instead of doing it
  -h, --help     display help for command

Examples:
  board dirs
  board dirs add
  board dirs add ~/workspace/agent-board
  board dirs add --from-config
  board dirs rm ~/workspace/old
  board dirs rm --force ~/workspace/gone
  board dirs set label Board
  board dirs set repo acme/board ~/workspace/agent-board
  board dirs set default true
  board dirs set lane reviews ~/workspace/reviews
  board dirs unset label
```

### board init

```
Usage: board init [options]

Set this machine up for the board: write web.json (the board's URL), env (the
machine token and the data key, mode 600) and, if it is missing, config.json
(from the example, with this machine's name). Then run the checks of `board
doctor`.

Set up encryption in the browser first: init asks for the data key from the
board's Settings page as well as the token. The page offers the env lines to
copy (`AGENT_BOARD_TOKEN=…`, `AGENT_BOARD_DATA_KEY=…`). At a prompt paste one
line: the bare value, or its own line (a prompt takes one line, so the other
line is refused, naming which one it wants); a file or pipe given with
--token-file or --data-key-file may hold both lines. Without flags it asks. For
a script give --url, --token-file and --data-key-file: a secret never goes on
the command line, where it would land in the shell history. A secret file must
be mode 600 or 400 like env, which a pipe is: `printf %s "$TOKEN" | board init
--url … --token-file /dev/stdin --data-key-file ~/key`; only one of the two can
be /dev/stdin. --machine defaults to the host name.

A file that exists is kept unless --force, which copies it to
<name>.bak-<timestamp> first (an env backup is mode 600 at most) and keeps what
you do not give again: the URL, the token, the data key and any other line of
env. An env that has the token but no data key (or the reverse) is completed
without --force: init asks for the missing value only. config.json is never
replaced.

Not available inside a board run.

Options:
  --url <url>             the board's URL (https, or http for localhost)
  --token-file <path>     read the machine token from this file: the bare token
                          or the env line(s) the Settings page offers (mode 600
                          or 400, or a pipe)
  --data-key-file <path>  read the data key from this file: the bare key or the
                          env line(s) the Settings page offers (mode 600 or 400,
                          or a pipe)
  --machine <name>        this machine's name on the board (default: the host
                          name)
  --force                 replace web.json and env after backing them up
  -h, --help              display help for command

Examples:
  board init
  printf %s "$TOKEN" | board init --url https://board.example.com --token-file /dev/stdin --data-key-file ~/key --machine laptop
```

### board doctor

```
Usage: board doctor [options]

Check this machine, read-only, one line per check: ✓ passes, ✗ fails (with a
fix), ! is a warning. Exit 1 if any check fails; warnings alone exit 0. The
token is never printed.

Checks: Node 24+ (checkout only), the config directory, web.json, env (mode 600
or 400, token, data key), the board (reachable, token accepted, API version
range, and whether it has a data key and this machine holds the same one),
config.json, and for a worker machine claude, gh, flock, systemd-run, systemctl
and the installed units with their timers and the listener (on macOS: claude,
gh, lockf, the launchd agents and whether launchd has loaded them, the run
directory, and a warning for a checkout under ~/Documents, ~/Desktop,
~/Downloads or iCloud Drive, which macOS keeps background jobs out of). The
worker checks only warn on a machine with no unit or agent installed, and are
left out on a system other than Linux and macOS, where no worker runs.

Options:
  --json      print JSON on stdout instead of text
  -h, --help  display help for command

Examples:
  board doctor
  board doctor --json
```

### board setup

```
Usage: board setup [options]

Install this machine as a worker: write the dispatch service and timer and the
listener service into ~/.config/systemd/user (or $XDG_CONFIG_HOME/systemd/user)
as copies, run `systemctl --user daemon-reload` and print the line that enables
them. The listener holds a stream to the board and starts a dispatch tick within
a second of a change; the timers stay as the fallback. Run it again after moving
the binary or the checkout, or upgrading Node. It needs Linux with systemd and
flock, or macOS.

On macOS it writes two launchd agents, de.codeplant.agent-board.dispatch (every
2 minutes) and de.codeplant.agent-board.listen, into ~/Library/LaunchAgents as
copies, creates the log and run directories and loads the agents that are loaded
already (all of them with --enable) with `launchctl bootout` and `launchctl
bootstrap gui/<uid>`; without --enable it prints the bootstrap lines. The agents
log to launchd.dispatch.log and launchd.listen.log in the log directory.

The services run this CLI the way `board setup` was started: the binary, or the
checkout with its Node. --print shows the units (or agents) and changes nothing;
--enable also enables and starts the timer and the listener (loads the agents).
When an installed unit differs from what it writes, the differing lines are
shown. It refuses unless --force when this checkout is not the one the installed
~/.local/bin/board runs from (a worktree, a scratch copy), or when a binary runs
from the temp directory, so it cannot take over the live timers. Setup also
stops and deletes the timer, service or launchd agent of the removed built-in
intake when it finds one (not with --print). Not available inside a board run.

Options:
  --enable    also enable and start the timer and the listener
  --force     install although this checkout is not the installed one, or the
              binary runs from the temp directory
  --print     print the units and change nothing
  -h, --help  display help for command

Examples:
  board setup
  board setup --print
  board setup --enable
```

### board self-update

```
Usage: board self-update [options]

Download the newest cli-v* release of codeplant-de/agent-board with `gh`, check
it against SHA256SUMS and replace this binary with it, then restart the listener
if it runs (`systemctl --user try-restart`, or `launchctl kickstart -k` on macOS
when launchd has the agent loaded). Running workers keep the old file until they
end. --check only reports whether a newer release exists.

It needs `gh`, logged in. A checkout is updated with `git pull` and `pnpm
install` instead, and says so. Not available inside a board run.

Options:
  --check     only report whether a newer release exists
  -h, --help  display help for command

Examples:
  board self-update --check
  board self-update
```

### board completion

```
Usage: board completion [options] <shell>

Print a completion script for bash, zsh or fish: commands, flags, statuses and
priorities, and the ids of your tasks and schedules (asked from the board, with
a 2 second limit).

Install it once:
  bash: board completion bash > ~/.local/share/bash-completion/completions/board
  zsh:  board completion zsh > "${fpath[1]}/_board"   (a directory on your
fpath)
  fish: board completion fish > ~/.config/fish/completions/board.fish

Arguments:
  shell       bash, zsh or fish (choices: "bash", "zsh", "fish")

Options:
  -h, --help  display help for command

Examples:
  board completion bash
  eval "$(board completion zsh)"
```

### board example

```
Usage: board example [options] [name]

Without a name, list the examples: scripts and config files to start from. With
a name, print that file on stdout, so `board example github-reviews.sh >
~/bin/github-reviews.sh` saves it. The files are built into the CLI, so they
match its version.

The scripts and the timer that runs them are described under Scripts in
docs/usage.md.

Arguments:
  name        the example to print

Options:
  -h, --help  display help for command

Examples:
  board example
  board example github-reviews.sh > github-reviews.sh
```

<!-- commands:end -->
