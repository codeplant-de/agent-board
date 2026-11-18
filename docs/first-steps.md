# First steps after installing

You ran `board init` and `board setup --enable`, and `board doctor` is green. This page is a tour of what to try next, with links to the reference for each part. If you have not installed yet, start with [Setting up a machine](setup.md).

## Run a first task

In a checkout you work in:

```sh
board schedule "Read this repository and tell me in five lines what it does"
```

`board schedule` prints the task's URL. Open it and watch the card go from Todo to Running to Needs me. The agent's report is the thread on the task page, and **Transcript** shows every tool call. Reply with **Send & continue** and the agent picks up the same session with its context intact.

## The concepts

| Concept    | In one sentence                                                                                                                                                                                               | Details                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Task       | A prompt, written as you would type it into Claude Code: `/review-pr 17741` or plain instructions.                                                                                                            | [Tasks](usage.md#tasks)                           |
| Status     | `backlog → todo → running → needs-me → done`, plus `waiting`. Workers take Todo from the top, by priority. A run that reports, asks or fails ends in Needs me, and nothing moves on until you press a button. | [Tasks](usage.md#tasks)                           |
| Machine    | A computer of yours that runs the `board` units. It claims Todo tasks and starts `claude -p` for each. Tasks only move while a machine that can serve them is on.                                             | [Worker machines](workers.md)                     |
| Directory  | A task runs in the directory it was scheduled from, on that machine. Claude Code loads that checkout's settings, skills and CLAUDE.md. `board dirs` lists the directories workers may use.                    | [Where a task runs](workers.md#where-a-task-runs) |
| Session    | A reply or an answer resumes the agent's Claude session on the machine that ran it. **Re-run fresh** starts a new one.                                                                                        | [Ask and resume](usage.md#ask-and-resume)         |
| Question   | A headless run cannot prompt you, so the agent posts its questions to the board with options to pick. Skills that ask questions work unchanged.                                                               | [Ask and resume](usage.md#ask-and-resume)         |
| Watch      | An agent that waits for CI, a deploy or a timer starts a watch and frees its slot. The task sits in Waiting and wakes when the watch reports.                                                                 | [Waiting](usage.md#waiting)                       |
| Proposal   | Follow-up work an agent suggests. It lands in Backlog and runs only after you press **Start**.                                                                                                                | [Ask and resume](usage.md#ask-and-resume)         |
| Lane       | A machine's parallel slots. A task names its lane, so two reviews and three other tasks can run side by side.                                                                                                 | [Lanes](workers.md#lanes)                         |
| Agent      | A named, narrow set of tools on a machine. A task that names one runs with only those tools and never asks. Use it for unattended work on text you did not read, such as other people's PRs.                  | [Agents](workers.md#agents)                       |
| Encryption | Prompts, notes and transcripts are sealed with a data key that exists only in your browser and on your machines. The server stores ciphertext.                                                                | [Encryption](encryption.md)                       |

There is no sandbox. A task you made runs Claude Code as you, in auto mode, with your SSH agent and your `gh` login. [What a worker may do](workers.md#what-a-worker-may-do) says how far that goes.

## Things to try

- **Answer a question.** Schedule something that needs a decision, for example a `/grill` skill on a plan. The card gets a Question badge. Pick options with the number keys and press **Answer & continue**.
- **Talk to a running agent.** On a running task, **Send** hands your message over at the agent's next tool call. **Stop & send** interrupts it first.
- **Let it open a PR.** A prompt that asks for a code change ends in a PR. The agent works on a new branch, pushes, opens the PR, waits for CI with a watch and fixes what fails. The PR shows as an icon on the card, and **Move merged to Done** clears merged work from Needs me.
- **Park an idea.** `board schedule --backlog "CSV export should include postal codes"` keeps a rough idea out of the workers' reach. **Polish prompt** on the card has an agent turn it into a complete prompt, which you apply or ignore. `--polish` does both in one call.
- **Start later.** `board schedule --in 2h ...` or `--at 09:00 ...` holds a task in Todo until then.
- **Pick a model or a priority.** `--model opus`, `--priority high`. Both are also fields of the New task form.
- **Take over a session.** `board attach <task>` opens the task's Claude session in your terminal, in its directory. With `--fork` the board's session stays as it was.
- **Use the browser only.** **New task** takes the same prompt. Its Working directory field offers every directory your machines listed with `board dirs add`, and typing `/` completes the skills of that directory.

Every command is in the [CLI reference](cli.md), and `board <command> --help` prints the same text.

## Tasks that make themselves

The board makes no tasks by itself. A task that should appear without you typing it comes from a rule or a script you own, built from three parts.

**Repeating schedules.** `--every` or `--cron` makes a rule instead of one task:

```sh
board schedule --cron "0 9 * * 1-5" "Summarise what merged to main since yesterday"
board schedule --every 2h --times 5 /sweep the stale branches
board schedules                      # list, pause, resume, rm
```

A schedule keeps exactly one pending card in Todo. A machine that was off for a week finds one card, not a pile. `--cron` can be given several times, `--max-concurrent` limits how many cards run at once, and `--after` starts a schedule when a card of another one finishes. See [Scheduling](usage.md#scheduling).

**Scripts with a key.** A script that watches something outside the board calls `board schedule --key <key> --version <v> --json -- <prompt>`. The board keeps one task per key however often the script runs, and a new version sends a finished task back to Todo. The call needs no terminal and its output says what happened: `created`, `requeued` or `exists`. Run the script from a systemd timer or cron. See [Scripts](usage.md#scripts).

The shipped example turns GitHub review requests into review tasks:

```sh
board agents add example:reviewer    # the narrow agent the reviews run as; shows what it grants before it writes
board example github-reviews.sh > ~/.local/bin/github-reviews.sh && chmod +x ~/.local/bin/github-reviews.sh
github-reviews.sh acme/app=~/workspace/acme/app
```

Each open PR that requests your review becomes one task that runs `/review-pr <url> --auto` as the `reviewer` agent, and a new head commit queues a fresh review. The reviewer cannot push, merge or approve. It stages a draft review that you submit. [Review requests from GitHub](usage.md#review-requests-from-github) has the timer unit, and the script is short enough to copy for other sources: Shortcut stories with a label, failing nightly builds, Sentry issues.

**Reacting to the board.** `board events --json` prints one line per change, for scripts that go the other way, such as a `notify-send` when a task enters Needs me. See [Board events](usage.md#board-events).

Anything a script schedules unattended should name an agent with `--agent`. Without one the task runs with your full permissions on input nobody read.

## Configuration worth knowing

Machine settings are in `~/.config/agent-board/config.json`. [Config](setup.md#config) lists every key. `board doctor` checks the file and names a misspelt key.

| What                  | How                                                                                                                                        | Why you want it                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Directories           | `board dirs add` in each checkout, then `board dirs set label App`, `set repo acme/app`, `set default true`, `set lane reviews`            | The New task form offers them by label. A task that names a PR of `acme/app` runs in that checkout. Tasks without a directory run in the default one. |
| Lanes                 | `"lanes": { "reviews": { "slots": 2 }, "general": { "slots": 3, "default": true } }`, then `--lane reviews` on the tasks that belong there | Reviews never wait behind long tasks, and the slot count caps how many runs your machine and your quota carry at once. [Lanes](workers.md#lanes)      |
| Usage limits          | `"usageLimits": { "fiveHour": 80, "sevenDay": 90, "priority": "urgent" }`                                                                  | Past 80% of the 5-hour window only urgent tasks start, so the board leaves quota for your own sessions. [Usage limits](workers.md#usage-limits)       |
| Agents                | `board agents`, `board agents add <file, URL or example:name>`                                                                             | Unattended tasks with a fixed tool list. Share a definition as a YAML file. [Sharing and importing agents](workers.md#sharing-and-importing-agents)   |
| Run limits            | `"inactivityMinutes": 15`, `"maxRunHours": 6`                                                                                              | A run with no tool call for 15 minutes, or longer than 6 hours, is stopped. Raise them for long jobs. [Liveness](workers.md#liveness-and-limits)      |
| CLI updates           | `"autoUpdate": "always"`, or `board self-update` by hand                                                                                   | The default only updates when the board refuses the CLI as too old. `always` follows every release. [Updating the CLI](setup.md#updating-the-cli)     |
| Runs after logout     | `loginctl enable-linger $USER` on Linux                                                                                                    | User units stop when you log out otherwise. A Mac runs tasks only while you are logged in and awake.                                                  |
| Desktop notifications | The switch on the board's **Settings** page                                                                                                | An OS notification when a task enters Needs me. [Desktop notifications](usage.md#desktop-notifications)                                               |
| Shell completion      | `board completion bash`, `zsh` or `fish`                                                                                                   | Completes commands and flags.                                                                                                                         |

Two things about `dirs` surprise people:

- **The list is enforced as soon as it has one entry.** From then on `board schedule` refuses in an unlisted directory, and a task that would start in one ends in Needs me with the path and the fix.
- **The default directory has to be listed too.** A fresh config has `defaultCwd` set to `~`. After the first `board dirs add`, `board doctor` fails until you run `board dirs set default true` in one checkout. `board dirs add --from-config` also clears the failure, but it lists your whole home directory.

A second machine needs its own token from **Settings** and the same data key. A task stays on the machine it was scheduled from, since its directory and session live there. See [Two machines](workers.md#two-machines).

## When something looks wrong

- `board doctor` checks config, token, data key, server version and units.
- A task that failed says why in its thread and shows the end of its log. The full log is `~/.local/state/agent-board/logs/<task>.log` on the machine that ran it.
- A task that sits in Todo usually waits for a machine that is off, a free slot, a start time or a usage limit. `board logs dispatch` (on Linux `journalctl --user -u agent-board-dispatch`) shows what each tick decided. After you change the CLI or its checkout, `board restart` restarts the units.
- A running task whose agent has been quiet for 20 minutes offers **Take back** on its page.
