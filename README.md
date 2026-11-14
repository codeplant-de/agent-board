# agent-board

A board for headless Claude Code runs. Each task is a conversation: the agent posts its findings as markdown, asks you questions with options to pick, and picks up where it left off when you answer. Phase 1 is PR review; any skill can be a task type.

Three parts, one repo (pnpm workspace):

| Part | Where it runs | What it does |
| --- | --- | --- |
| `apps/backend` and `apps/frontend` | board.codeplant.de (k3s, behind Authelia) | The board: tasks, threads, questions, the buttons. Postgres is the only state. |
| `apps/cli` | each worker machine (laptop, workstation) | systemd units: `dispatch` claims tasks and starts `claude -p` workers, `intake` turns review requests into tasks, `listen` starts a dispatch tick the moment the board changes. `board` is the command the agent uses to report. |
| `packages/shared` | both | The backend contract and the question schema. No dependencies; the CLI runs it from source. |

The CLI talks to the board directly, over HTTPS with a machine token: the [backend contract](#backend-contract).

## Tasks

Five statuses: `backlog`, `todo`, `running`, `needs-me`, `done`. `backlog` is the first column: parked cards that no worker takes until you move them to Todo. Four priorities: `urgent`, `high`, `normal` (the default), `low`. Every column lists its tasks by priority, then in the order you dragged them into, and workers take Todo from the top, so an urgent task runs before anything else that waits. Dropping a card among tasks of another priority gives it their priority; the task page has a picker for it. A task is a **prompt**, written as you would type it into Claude Code: `/review-pr 17741`, `/grill the plan in docs/x.md`, or plain instructions. The worker runs it as written. The slash command it starts with, if any, is the task's skill: it picks the [lane](#lanes) and is shown as the task's label.

A run ends in `needs-me`: with a report, with a question, or, when it fails, times out or its worker disappears, with the reason and the end of the log. Nothing moves on until you press a button.

## Scheduling

```
board schedule /review-pr 17741
board schedule --priority high /review-pr cosuno/cosuno#17741 --auto
board schedule "Find out why the bidder export is slow and propose a fix"
board schedule --in 2h /review-pr 17741
board schedule --at 09:00 /grill the plan in docs/x.md
board delay Ab3dEf9x --in 1d
board schedule --every 2h --times 5 /sweep the stale branches
board schedule --cron "0 9 * * 1-5" /review-pr --auto
board schedules
```

`board schedule [--priority p] [--title t] [--hold | --backlog] [--in <dur> | --at <time>] [--every <dur> | --cron "<expr>"] [--times <n> | --until <time>] [--new] <prompt...>` makes a task of the prompt, bound to this machine and the directory you run it in, and prints its URL. The board's flags come first; everything from the first other word on is the prompt, flags included (`--auto` above goes to the skill). The title defaults to the prompt's first line; `--hold` lands it in `needs-me` instead of Todo, `--backlog` in `backlog` (the two cannot be combined). When the duplicate check offers to requeue an existing task, the same flags pick where it goes, and a delay is set on it; if that task is already in Todo, `--in` or `--at` delays it, and if it is running the start time is not applied (the line says so).

**Delays.** `--in <dur>` or `--at <time>` keeps the task in Todo until then: it sits last in the column with a "Starts in 4h" badge, and no worker takes it before. They exclude each other and cannot be combined with `--hold` or `--backlog` (a delay only exists in Todo); the confirmation line names the start time. `board delay <task> (--in <dur> | --at <time> | --now)` sets or moves the delay of a task in Todo, or with `--now` clears it so the task is due at once; the task page has a **Run now** button for the same. The New task form has the same under **When: Later**. A delay is cleared when the task leaves Todo, so a task that is moved back later is not delayed again.

- `<dur>` is a number and a unit, largest unit first: `m` minutes, `h` hours, `d` days, `w` weeks, alone or combined: `30m`, `2h`, `1d`, `1h30m`, `1w2d`. Zero, negative and unknown units are refused.
- `<time>` is an ISO date and time with an offset or `Z` (`2027-01-01T12:00:00Z`), without one for your local time (`2027-01-01T12:00`, `2027-01-01T12:00:00`), a date for local midnight (`2027-01-01`), or `HH:MM` for the next time of day (`09:30`: today if it is still ahead, else tomorrow). A time in the past is refused.

**Repeating schedules.** `--every <dur>` or `--cron "<expr>"` (not both) makes a schedule instead of one task: a rule that keeps producing delayed Todo cards. `--in` or `--at` is the first run; without one it starts now.

- `--every 2h` runs on a fixed grid from the first run: first run, then every 2 hours after it, whatever time the cards are started at. `--cron "0 9 * * 1-5"` is a 5-field expression (minute, hour, day of month, month, weekday), read in the time zone of the machine that made the schedule and stored with it, so `0 9 * * *` stays at 9:00 local across a change to summer time. Its first run is the first match at or after `--in`/`--at` (or now). A 6-field expression with seconds is refused, as is anything that does not parse.
- The end is `--times <n>`, the number of runs including the first (a positive whole number), or `--until <time>`, after which nothing starts (a run exactly at that time still does); without either it repeats forever. They exclude each other. `--times` and `--until` without a repeat, and a repeat with `--hold` or `--backlog`, are usage errors.
- A schedule has exactly one **pending occurrence**: an ordinary Todo card with a start time, the schedule's title and priority, pinned to the machine and directory it was made in (a schedule from the New task form is not pinned). The next card is made when the pending one leaves Todo: when a worker claims it, when you move it, or when you close it. So a worker that was off for a day finds one card, not a pile; the next run is the first one on the rule after the previous run's time that is not in the past, and the missed ones are skipped. Closing or moving the waiting card skips that run. A card that ran and comes back to Todo later (a reply, a re-run) makes no further card. There is no timer on the server.
- A schedule that has no run left, because `--times` is used up or the next run would lie after `--until`, ends: it stays in the list, dimmed, and creates nothing.
- The repeat skips the duplicate check, since a recurring prompt resembles its own earlier runs. The confirmation names the schedule id, its rule, the first run and the card's URL.
- `board schedules` lists them (id, rule, next run, runs left including the waiting one, paused or ended, title). `board schedules pause <id>` takes the waiting card off the board and stops the schedule; `resume <id>` makes the next card, at the first run on the rule from now. `board schedules rm <id>` deletes the schedule and its waiting card; cards that already ran stay with their history. Like `board schedule`, these three are refused inside a board run.

Before it creates the task, a Haiku call (a few seconds, under a cent) checks whether an open task already covers the same work. On a likely match it asks in the terminal: requeue that task (a fresh run), create a new one anyway, or abort. Without a terminal it creates the task with a note naming the likely duplicate. `--new` skips the check.

The board's **New task** form takes a prompt the same way; such a task runs in `defaultCwd` of whichever machine takes it. Its **When** menu offers Now, Later, Repeating, Backlog and Needs me. Repeating takes an interval (`2h`) or a cron expression (read in your browser's time zone, and the server's error is shown if it cannot read it), an optional first run and an optional number of runs, and opens the first waiting card.

The **Schedules** page of the web board lists the schedules: title and prompt, rule, next run, runs left (`forever` without an end), machine, a link to the waiting card, and pause or resume and delete. An ended schedule is dimmed and can only be deleted. A waiting card carries a **Repeat** badge, and its page says it is the next run of a schedule.

## Ask and resume

Claude Code offers no AskUserQuestion to a headless run (2.1.323, whatever `--tools` says). So the board's rules tell the agent: wherever you would ask with AskUserQuestion, also where a skill says to, write the same questions to a JSON file and run `board ask <task> --file <path>`, then end your turn. The questions land on the board (one to four, each with options, the recommended one marked), the task moves to `needs-me` with a **Question** badge, and Slack gets a message. So an interactive skill works on the board without changes to it. The run's hook would also turn a real AskUserQuestion call into a board question, should a later Claude Code offer the tool headless.

On the task page you pick options (number keys work), add text where none fits, and press **Answer & continue**. On a task without a question, write a reply and press **Send & continue**. Both put the task at the top of its priority in Todo with `next: resume`. The next dispatch tick on the machine that ran the session starts `claude -p --resume=<session>` with your reply on stdin, so the agent keeps its context; it resumes only a session that machine started for the task (see [Encryption](#encryption)). The other buttons:

| Button | Effect |
| --- | --- |
| Mark done | Done. |
| Re-run fresh | Back to Todo with a new session; the agent sees the thread, not the old context. |
| Comment without continuing | A note in the thread, nothing runs. Works while a task runs too. |
| Close / Reopen | Out of the workflow; workers ignore it, intake never makes a second task for its PR. |
| Start / Discard | On a task an agent proposed. Dragging it into Todo, or Move to Todo from Backlog, starts it too. Every way of starting shows the proposal's whole prompt, as plain text, and asks you to confirm before it is sealed as yours (a worker then runs it with your permissions). A move counts as a start only from another column into Todo: a proposal the board itself shows in Todo is never run, is not re-sealed by reordering it, and its panel says so. Send & continue and Re-run fresh wait until it is started. |
| Take back | On a running task whose agent has been quiet for 20 minutes (the text turns red after 10, but one long command is quiet that long): its worker is gone, say because the machine is off. The task goes to `needs-me` with a note; a worker that is still alive finds it no longer running and drops its result. |

An agent can propose follow-up work with `board add --title <t> --file <path> --parent <task> [--priority <p>]`; the file is the new task's prompt. Without `--priority` a proposal takes its parent's priority; it runs where the proposing agent worked, on that machine. A proposal lands in `needs-me` with a **Proposed** badge and runs only after you press **Start**, so a run that a PR's text turned against you cannot queue work by itself. **Starting is a sealed act.** A proposal's prompt is sealed for the creator `agent`, and nothing runs a task whose creator is still `agent`: the dispatcher skips it and the worker refuses it, whatever status the board shows. Pressing Start, or dragging the card into Todo, makes the browser seal the prompt it shows again for the creator `user`, and the board stores that prompt and takes the task to be yours from then on (`createdBy` becomes `user`, the Proposed badge goes). The title and directory stay as they were: their bindings (`task:<id>`) do not name a creator. A proposal's parent is only a link for the breadcrumb and the follow-up list; it is not part of any binding, starting does not touch it, and the board can attach a proposal to any parent without changing what runs. The server also keeps the order for an honest board: whatever status an agent names, its `add-task` lands in `needs-me`; the machine API cannot move a proposal out of `needs-me`, `claim-task` loses on one, and `ask` refuses one (answering a question would start it); a move into Todo without the prompt sealed again is a 400, and Send & continue, Re-run fresh and Reopen leave a proposal a proposal. A board that skips all of that gains nothing: it can serve a proposal as Todo, but the prompt only opens as an agent's, and a prompt it starts with the sealed value it already holds opens as nobody's. There is no CLI command that starts a proposal (`board move <task> todo` is refused for it, and an agent in a run cannot do what only you can).

Dragging a card moves it the way the matching button would, minus the reply. Into Todo or Done it drops the open question (the question note stays in the thread); into Todo a task with a session keeps its `next`, and a resume with nothing to answer starts a fresh run. Done tasks nobody touched for 14 days are closed, with a note in the thread; they stay readable under Closed. Intake's tasks are left open: intake treats a closed task as "never again", so closing one would block the PR's next review request.

## Two machines

Every worker machine runs its own timers and its own listener against the same board, under the name `machine` in its config.json (default: the host name). Every machine holds its own event stream, so a change reaches all of them at once and they race to claim; `claim-task` is atomic, so the losers move on, as they do with two timers.

- A claim is atomic on the server: of two machines claiming a task at once, one wins, and the other moves on to the next task.
- A machine skips a todo task it cannot serve, so the other one can take it: a task scheduled on the other machine (its directory is there), a resume whose session lives on the other machine, or an intake review of a repository it has no checkout of.
- A machine sweeps only its own running tasks: the worker unit lives where the task was claimed. When that machine is off, you can take the task back from the task page once its agent has been quiet for 20 minutes.
- Intake runs on both. The PR URL is the task's dedupe key (sent as its blind index), so both create the same task once.

Tasks only move while a machine with the right setup is on.

## Lanes

A machine splits its parallel runs into lanes by skill, configured in its config.json:

```json
"lanes": {
  "reviews": { "skills": ["review-pr"], "slots": 2 },
  "general": { "skills": ["*"], "slots": 3 }
}
```

- **Own work first.** A task belongs to the lane that names the skill its prompt starts with (`/review-pr` and `/pr-review:review-pr` both count as `review-pr`), else to the lane with `*`, which also takes prompts without a skill. A lane with a free slot takes the first Todo task of its own: resumes first (answered, replied to or paused), then by priority. A skill belongs to at most one lane, and at most one lane has `*`.
- **Borrowing.** A lane with nothing of its own borrows the first task any other lane would run, so idle slots do not wait. The run is marked borrowed.
- **Taking the slot back.** When a full lane has its own work waiting and runs borrowed work that has gone on for `pauseAfterMinutes` (default 5), the dispatcher asks the newest such run to pause, one per lane at a time. Lane bias beats priority: a borrowed urgent run gives way to its lane's own low task. An urgent task only has guaranteed room in its own lane.
- **Pausing is cooperative.** The dispatcher drops a pause flag. The agent's `PreToolUse` hook then refuses every tool call but `board comment`, telling the agent to post a one-line status and end its turn. When the run ends, the worker notes "Paused on <machine>: …" and puts the task back in Todo, ahead of new work, to resume in its session on the same machine. A run that has not stopped within five minutes of the request is stopped by force and paused all the same. The resumed run is told it was paused and checks its state before it goes on.

A lane may also name a `cwd`: where its tasks run when they have no directory of their own (see [Where a task runs](#where-a-task-runs)), say `"reviews": { "skills": ["review-pr"], "slots": 2, "cwd": "~/workspace/cosuno/cosuno" }`, so `/review-pr 17766` from the New task form runs in the checkout and gets its settings.

Without `lanes`, a machine runs one lane, `general`, with `*` and three slots.

## Liveness and limits

The hook also touches a heartbeat file on every tool call. The worker checks it every 15 seconds:

- no tool call for `inactivityMinutes` (default 15): the run is stopped as stuck and the task goes to `needs-me` with the end of the log. Claude Code caps a foreground Bash call at ten minutes, so a long command does not trip it.
- a run longer than `maxRunHours` (default 6): stopped, however busy. A guard against an agent looping on tool calls.

The worker passes the heartbeat on to the board every 15 seconds while the agent is active, with the lane. A running card counts the seconds since ("active 12s ago", then "active 1m 5s ago"), amber after 5 quiet minutes, red after 10, and its lane with a "borrowed" badge when it runs in another lane's slot.

The heartbeat, pause flag, lane and working directory of a run live in `$XDG_RUNTIME_DIR/agent-board/` (`AGENT_BOARD_RUN_DIR` overrides it), private to your user.

## Transcripts

Every run records what it did. The worker starts `claude -p` with `--output-format stream-json --verbose`, condenses each event (the agent's text, each tool call with its input, each tool result, subagent calls tagged with their Agent call, notes such as the model and directory, and the result with turns, time, cost and refused tool calls), writes a readable line per event to the local log, and sends the events to the board with every 15-second check and once more when the run ends. A batch the board refuses is sent again with the next. What waits for a board that is down is bounded by count (20,000 events) and by size (32 MB of JSON): past either, the oldest tool outputs are emptied first, then the oldest events dropped, and a note in the transcript says how many. The end of the run makes two bounded passes.

On the board, **Transcript** on a task page (or the terminal icon on a card) opens the runs, newest first, live while one runs. Tool calls are one line each; a click shows the input and loads the output. A tool result over 256 KB is cut with a note; the full one stays in the session file on the machine. Claude Code passes thinking on without its text, so a thinking block shows as a marker with its token estimate.

Transcripts can hold whatever the agent saw: file contents, `gh` output, now and then an environment value. The worker seals each event (and each tool output apart) before it sends it, so the server stores only ciphertext. They go 14 days after a task is closed, and 28 days after the last change of an open task in Done, which covers intake's tasks (the server checks hourly). A task of yours untouched in Done is closed after 14 days.

The board loads a run's events in pages of 2000 and afterwards only those after the last one it has, so long runs show in full and a live run costs one small request per poll.

## Where a task runs

A task is bound to a directory on the machine that ran it:

- A fresh run starts in the task's own directory: where it was scheduled from with `board schedule`, or where the proposing agent worked. A task without a directory of its own (an intake review, a task from the New task form) starts in the checkout of the PR its prompt names (`repos`), else in its lane's `cwd`, else in `defaultCwd`. This matters beyond the files: Claude Code loads the checkout's `.claude/settings*.json` only when it starts there, and that is where tokens and endpoints such as `CIRCLECI_TOKEN` or the replica endpoints usually live. The task's `workdir` is set to it.
- The hook records the agent's working directory on every tool call. When a run ends somewhere else, typically in a worktree the agent entered with `/worktree` (`EnterWorktree`), the worker stores that as the task's `workdir`.
- A resume (after an answer, a reply or a pause) starts `claude --resume` in the `workdir`, so the session continues in exactly the worktree it left. The resume is pinned to the same machine, where that directory exists. If the directory is gone, the task goes to `needs-me` with the path instead of running somewhere else.
- **Re-run fresh** forgets the session and the `workdir`; the next run starts in `defaultCwd` (an intake review: in the checkout).

Claude Code itself (2.1.323) also restores a session's worktree when it is resumed from the original directory; the `workdir` makes the board independent of that and shows it on the task page.

## Install

The `board` command and the worker (`dispatch`, `intake`, `worker`) are one program. A released build is a single binary per platform (Linux x64 and arm64, macOS arm64) and needs no Node; a worker machine needs Linux with systemd, `flock`, `systemd-run`, `gh` (logged in) and `claude` (logged in). On macOS only the `board` commands run, not the worker, and `board ask` and `board add` are not available (they read their file through `/proc`); `board comment` takes its text as arguments or `-` for stdin.

### From a release

```
gh release download --repo codeplant-de/agent-board --pattern install.sh -O - | sh
board init
board setup --enable
board doctor
```

`install.sh` needs `gh`, logged in (the repository is private). It downloads the newest `cli-v*` release for this platform, checks it against `SHA256SUMS` and installs it as `~/.local/bin/board` (`BOARD_INSTALL_DIR` chooses another directory). Set up encryption in the browser first (see [Encryption](#encryption)), and copy your data key from the **Settings** page. `board init` asks for the board's URL, the token (create one for this machine on the board's **Settings** page; it is not shown), the data key (not shown either) and the machine name (at a prompt paste one line: the bare value, or its own `AGENT_BOARD_TOKEN=…` or `AGENT_BOARD_DATA_KEY=…` line as the Settings page offers it; a file or a pipe given with `--token-file` or `--data-key-file` can hold both lines), and writes `~/.config/agent-board/web.json`, `env` (mode 600, token and data key; a file with any other mode is refused) and, if it is missing, `config.json` from `apps/cli/config.example.json`; edit `repos` there to this machine's checkouts. For a script: `board init --url https://board.codeplant.de --token-file <file> --data-key-file <file> --machine <name>`; a secret never goes on the command line, and a file can be `/dev/stdin` for one of them (a pipe). An `env` that has the token but no data key (a machine from before encryption) is completed without `--force`: `board init` asks for the missing value only. A file that exists is kept unless `--force`, which copies it to `<name>.bak-<timestamp>` first and keeps the secrets you do not give again. `board setup` writes the dispatch and intake services and timers and the listener service (`agent-board-listen.service`) into `~/.config/systemd/user` as copies and reloads systemd; `--enable` also enables and starts the timers and the listener, and `--print` only shows the units. The listener holds a stream to the board and runs a dispatch tick about a second after a task, an answer or a drag to Todo; the 2-minute timer stays as the fallback for what no event announces (a delayed task coming due, the stale sweep, taking back a borrowed slot, an event missed while the stream was down). Its log is `journalctl --user -u agent-board-listen`. `board doctor` checks the whole machine: Node (checkout only), config, token, server and contract version, the worker tools and the units.

The credentials file `env` holds two lines, the token and the data key: `AGENT_BOARD_TOKEN=abm_...` and `AGENT_BOARD_DATA_KEY=abk1_...`. The data key is the same on every machine and never leaves your machines and browser. The CLI refuses to start without it, with a different key than the board's, or before the board has a key; `board doctor` checks all three.

The checksum catches a broken or partial download. It is not a signature: anyone who can write releases of this repository can replace the binary and `SHA256SUMS` together, so the trust is in who has write access to the repository.

The units run the installed binary under `flock`: `<board> internal dispatch|intake`. Run `board setup` again after moving the binary. A board-only machine needs just `board init`.

### From a checkout (development)

Needs Node 24+, pnpm, and for a worker the tools above. `pnpm install` in the repo (the CLI depends on `commander` and `@clack/prompts`, and imports `@agent-board/shared` through the workspace link, so every machine needs this install, again after each pull). Then `apps/cli/install.sh`: it links `board` into `~/.local/bin` and `apps/cli/bin/.node` to a Node 24+ binary (`NODE=` chooses one; it is a real binary, not a mise shim, which does not resolve a version outside a project directory), and runs `board setup`. Continue with `board init` and `board doctor` as above, then enable the timers with `board setup --enable` (or run `apps/cli/install.sh --enable` instead of the plain `install.sh`). The units then run `<node> <checkout>/apps/cli/src/main.mts internal dispatch|intake`, with the Node that ran `board setup`; run `install.sh` or `board setup` again after moving the checkout or upgrading Node (`board doctor` flags a unit whose Node or checkout has gone).

`apps/cli/build.sh` compiles the binaries (needs Bun, pinned in `mise.toml`) into `apps/cli/dist` with a `SHA256SUMS`; `pnpm --filter @agent-board/cli test:binary` builds one for this host and runs it the way a worker machine would. A release is a tag `cli-v<version>` matching `apps/cli/package.json`; `.github/workflows/release-cli.yml` builds, tests and publishes it.

User timers and the listener only run while you are logged in. For runs after logout: `loginctl enable-linger $USER`. `board completion bash|zsh|fish` prints a shell completion script, see [Commands](#commands).

### Upgrading

**Machine names.** A name is 1 to 64 characters of letters, digits, `.`, `-` and `_`, starting with a letter or digit (the CLI states this when it refuses a name). The 64 is what the CLIs before accepted, and the character set, which keeps a name from being a sentence, is what protects the fixed event text and the agent's log lines; a shorter cap would add nothing but break names that worked. A machine token made earlier through the Settings page could carry any name of 1 to 64 characters. Such a token keeps working for what the machine API allows, and the Settings page shows its name as `(invalid)` (never as text) and still offers **Revoke**, which sends the raw name; to use the machine again, issue it a token under a name of the shape and set `machine` to it in its config.json.

The CLI checks the server's contract version once per process and refuses to run when it differs from its own, in either direction, so a contract bump needs the server and every machine's CLI updated together. A machine left on the old CLI fails each dispatch and intake run with a version error until it is updated. So, in this order:

**Contract 6 (encryption) moves data, so it has its own sequence: follow [Cutover to encryption](#cutover-to-encryption) from its first step, in its order.** It stops the timers and takes the dump before anything is deployed, and it holds the CLI release, the keys, the re-encryption and the restart. The list below is the general order for a contract bump that needs no such cutover:

1. Stop the dispatch and intake timers and the listener on every worker machine: `systemctl --user stop agent-board-dispatch.timer agent-board-intake.timer agent-board-listen.service`.
2. Take a dump of the database, your way back if a migration has to be undone.
3. Deploy or restart the server; migrations run on start.
4. Release the CLI: once the change is on `main`, tag the commit `cli-v<version>` (the version in `apps/cli/package.json`; `cli-v0.3.0` is the contract-5 build, `0.4.0` is contract 6, `0.5.0` is contract 7) and push the tag. The release workflow builds and publishes the binaries, so that `board self-update` has something to fetch before any machine is switched. `board self-update --check` on a machine shows it.
5. On each machine: update the CLI: `board self-update` for a release binary (it needs `gh`; `--check` only reports), or for a checkout `git pull`, `pnpm install` and `apps/cli/install.sh`. A checkout that only pulls cannot resolve new dependencies, and then `board`, dispatch, intake and every run's hook fail. Then `board setup` once if the units were written by an older version, and `board doctor`.
6. In an existing `config.json`, narrow `Bash(board *)` in `intake.allowedTools` to the forms in `config.example.json`, and add `Bash(board internal *)` to `intake.disallowedTools`. The old `backend` key is ignored; remove it if you like.
7. Start the timers and the listener again: `systemctl --user start agent-board-dispatch.timer agent-board-intake.timer agent-board-listen.service`.

The listener checks the contract each time it connects. On a mismatch it logs which side is older and exits, and systemd restarts it every 10 seconds until the CLI matches, so a machine updated late needs no hand. After updating a checkout, `systemctl --user restart agent-board-listen` loads the new code at once; otherwise it does at its next reconnect or mismatch. A release binary replaced by `board self-update` is the same. Contract 7 is a plain bump: it adds the event stream and moves no data. It is CLI version 0.5.0 (`cli-v0.5.0`).

## Cutover to encryption

For the one user who owns every row from before encryption, once. The operator is that user. It takes **two releases**, in this order:

1. **The first release** (this branch) has the migrations up to 0013, the browser and CLI that encrypt, and the re-encryption script. It has no constraint on the sealed columns: it starts on a database that still holds plain text, which is what lets the backend run while you set up your key in the browser (step 4), the one thing the script needs.
2. **The second release**, shipped later, adds migration 0014 and nothing else: check constraints that make the database refuse plain text in every sealed column (`apps/backend/src/db/sealedColumns.ts` lists them). The migration fails, changing nothing, while any plain text remains, so it must not roll out before step 11 of the first release is done and its result checked. See [The second release](#the-second-release).

**What "trusted at cutover" covers.** The script seals whatever plain text the owner's rows hold at the moment it commits, and picks each binding (the creator, the schedule, the task a note belongs to, the author and kind of a note) from clear columns. So the trust covers every write up to that moment: not only what the board stored before the first release, but everything written while the first release ran over the legacy rows, which have no constraint yet and which the application role can write for any owner by setting `app.owner` itself, and anything the operator changed in the database. Whoever could write then can make the script seal a prompt as the user's or as intake's, or a note as another author's. That is acceptable here only because the operator and the single legacy owner are the same person, who also watches the cutover: the dry run prints every task (id, creator, status, `created_at`) and the rows per table, to compare with the dump of step 2, so nothing that was not there before the cutover (or any change of creator) goes unnoticed. For a board of other people this script is not the way to migrate. From the commit on, a value a client did not seal for its purpose is not trusted by any client.

Every step says what to do if it fails; steps 6 to 8 either complete or change nothing.

**Needs:** `kubectl` for the `agent-board` namespace, a checkout at the first release's commit with `pnpm install`, the backend's env secret with `DATABASE_URL`, `APP_DATABASE_URL` (`board_app`) and `BACKFILL_OWNER` (your lower-case username: the migration that adds owners stops without it), and a password manager for the recovery key.

0. **Rehearse** on a restored dump. `pg_restore` the newest `agent-board.dump` into a scratch database, start `pnpm dev:backend` on it (`DATABASE_URL`, `APP_DATABASE_URL`, `BACKFILL_OWNER`, `DEV_AUTH_USER=<you>`), set up encryption in the browser, then run steps 6 to 10 against it. To rehearse the second release as well, apply its patch and run its migration (`pnpm db:migrate`) against the result. The script does about 6,000 transcript events per second: 300,000 events took 50 seconds. Drop the scratch database.
1. **Stop the timers** on every worker machine, and wait for the running tasks: `systemctl --user disable --now agent-board-dispatch.timer agent-board-intake.timer`, then `systemctl --user list-units 'agent-board-*'` shows no task. *Safe to repeat.*
2. **Take a dump**, your way back: `kubectl -n agent-board exec postgres-0 -c postgres -- sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > agent-board-before.dump`. It holds plain text: step 12 deletes it.
3. **Deploy the first release** (merge to main, Flux), and tag the CLI release: `cli-v<version>` on that commit (the version in `apps/cli/package.json`), so that `board self-update` has the contract-6 binary to fetch in step 5. The migrations run on start, in one transaction. *If the backend does not start:* read `kubectl -n agent-board logs deploy/backend`; the usual cause is a missing `BACKFILL_OWNER`; nothing was changed, fix the secret and let it restart. *Once it runs, the old image no longer fits the schema:* the way back is restoring the dump.
4. **Set up encryption in the browser:** sign in, choose a passphrase, store the recovery key in the password manager, then copy the data key from **Settings**. *If it says encryption is already set up, a key exists: use its passphrase or recovery key.*
5. **Put the data key on each machine:** update the CLI first (`board self-update` for a release binary, or `git pull`, `pnpm install` and `apps/cli/install.sh` for a checkout), narrow the tools intake may use (in `~/.config/agent-board/config.json`: `Bash(board *)` in `intake.allowedTools` to the forms in `config.example.json`, and `Bash(board internal *)` added to `intake.disallowedTools`), then run `board init`: it sees the `env` that has a token and no key and asks for the key only (paste the `AGENT_BOARD_DATA_KEY=…` line from Settings as it is; the file stays mode 600, with a backup of the old one). Leave the timers off. Check with `board doctor` (the key must match the board's) and `board tasks`: until step 8 every task reads `(cannot decrypt …)`.
6. **Stop the writers:** `kubectl -n agent-board scale deploy/backend --replicas=0` (if Flux scales it back, suspend the apps Kustomization first). The script also takes a lock and stops with a clear message when anything is writing.
7. **Dry run.** Keep the port-forward's process id, and stop it at the end by that id.

   ```
   kubectl -n agent-board port-forward svc/postgres 54332:5432 &
   export DATABASE_URL="postgresql://board:$(kubectl -n agent-board get secret agent-board-env -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)@localhost:54332/board"
   pnpm --filter @agent-board/backend reencrypt --owner <you> --key-file ~/.config/agent-board/env --dry-run
   ```

   It reads the key from the file (mode 600 or 400) or from `AGENT_BOARD_DATA_KEY`, never from an argument, and never prints it. It does everything in a transaction, checks the result and rolls back. Read the table: `converted` is what it seals, `left plain on purpose` the events the server wrote itself (`Closed.`, `Moved from … to ….`; any other text, including older wordings, is sealed as the system's), and every `WARNING` line. Before this change a started proposal stayed `created by agent` with `proposed = false`, but so did a discarded proposal that was reopened (reopening cleared the flag too), so the flag alone does not say it was started. The script treats a proposal as started only with evidence: a session id, a machine that claimed it, a run timestamp, a transcript run, the status `todo` or `running` (only a start, a reply, an answer or a re-run puts a proposal there), `next` being `resume`, or a note of yours that answered it or the note `Moved from … to todo.`. With evidence it seals the prompt for the creator `user` and makes you its creator; without, it keeps the agent as creator and sets `proposed = true`, so it waits until you start it. Both the dry run and the real run print every such task (id, creator before, status, `created_at`, the outcome and the evidence): read that list, and start again any proposal you did start that was kept (a started proposal with no trace at all is one you moved back before anything ran). The dry run also prints every task of the owner (id, creator, status, `created_at`) and the rows per table, to compare with `agent-board-before.dump`. *If it stops:* "another key" means the data key is not the one of Settings; "an envelope that does not open" names a row that holds a value of another key or damage; "being written to" means step 6 or 1 was not finished; "rows of another user still hold plain text" means the board is not a one-owner board, and the script is not for it; "values that the clients refuse" lists rows (an id or a name a client rejects) to fix in SQL first; "Intake ran after the first release was deployed" names two tasks for one pull request (a legacy one, whose plain URL would collide with the new task's hashed key, and the one intake made when it ran between the deploy and the script): delete the newer one if nothing on it is worth keeping, or clear the older one's `dedupe_key`, as the message says, and run again. Nothing was changed in any of these.
8. **Run it for real:** the same command without `--dry-run`. One transaction: *if it fails, nothing changed; fix the cause and run it again.* A second run changes nothing, so a doubt about whether it finished is answered by running it.
9. **`VACUUM FULL`** the rewritten tables, so the old plain-text row versions leave the files (an update leaves them behind until the table is rewritten): `psql "$DATABASE_URL" -c 'VACUUM FULL task, schedule, note, transcript_run, transcript_event'`. It needs free disk about the size of the biggest table and locks them, so the backend stays off. In the rehearsal `transcript_event` was 116 MB, 919 MB after the script and 438 MB after. *Safe to repeat.*
10. **Check that nothing plain is left, while the writers are still off:** the same dry-run command (step 7's port-forward and `DATABASE_URL`) reports `converted` as 0 everywhere, since a second run changes nothing. The real run already checks, in its own transaction and before it commits, that no plain text remains in a sealed column, so this shows the second run is idle rather than finding anything new. It takes a lock on the board's tables for its whole pass, and stops with "being written to" when a backend, a worker or a timer is writing: that is why it comes before the next step, not after.
11. **Start again:** `kubectl -n agent-board scale deploy/backend --replicas=1`, open the board, unlock, open a task and a transcript, run `board tasks` on a machine, then `systemctl --user enable --now agent-board-dispatch.timer agent-board-intake.timer`.
12. **Prune what holds plain text:** `agent-board-before.dump`, the dumps in `/var/backups/agent-board`, and the restic snapshots made before step 8 (`restic snapshots`, then `restic forget --prune <ids>`). Do this only after step 11 works, and the second release is the better moment: until then they are your way back. Dumps and snapshots from after step 8 hold ciphertext only. `BACKFILL_OWNER` may then leave the env secret.

`VACUUM FULL` rewrites the table files but does not scrub the disk blocks it frees or the write-ahead log, so the old plain text can still sit in freed space and in replicas until they are overwritten.

### The second release

Ships after step 11 of the first, as its own change: migration 0014 (`0014_sealed_content_constraints.sql`), its snapshot and journal entry, the check constraints in `apps/backend/src/db/schema.ts` and their test. It first checks every sealed column and, when plain text remains, stops with `Plain text is still stored in sealed columns: <table.column (rows)>. Run the re-encryption script first`, changing nothing (the migrations run in one transaction); then it adds the constraints and validates them.

1. Confirm step 11 of the first release is done and the check of step 10 converted nothing.
2. Deploy the second release. *If its backend does not start* with the message above, the board is down meanwhile (the deployment recreates): pin the previous image tag to bring it back (the migration changed nothing), run steps 6 to 10 of the first release again, and deploy the second release again.
3. Once it runs, a client that forgets to seal a field gets a 400 from the server's own check, and one that bypassed it would be refused by the database.


## Config

`~/.config/agent-board/config.json` (`AGENT_BOARD_CONFIG_DIR` changes the directory):

| Key | Meaning |
| --- | --- |
| `machine` | This machine's name on the board. Default: the host name up to the first dot. Must match the name of its token. |
| `lanes` | Lane name to `{ "skills": [...], "slots": n }`, see [Lanes](#lanes). Default: `general` with `*` and 3 slots. |
| `defaultCwd` | Where a task without a directory of its own runs. Default `~`. |
| `pauseAfterMinutes` | A borrowed run is paused for its lane's own work only after this long. Default 5. |
| `inactivityMinutes` | A run with no tool call for this long is stopped. Default 15. |
| `maxRunHours` | A run is stopped after this long, however busy. Default 6. |
| `slackWebhookFile` | One-line file with the Slack incoming webhook URL, mode 600. |
| `intake` | How intake's reviews run: `prompt` (default `/review-pr {url} --auto`), `priority` (default `normal`), the narrow `allowedTools` and `disallowedTools` they run with, `env`: variables the worker copies from the checkout's `.claude/settings.json` and `settings.local.json` into the run, and `mcpServers`: servers of the checkout's `.mcp.json` it passes with `--mcp-config` (such as `shortcut`, which then uses the login Claude Code already has for it), since intake loads only your user settings. See [What a worker may do](#what-a-worker-may-do). |
| `repos` | `owner/name` to local checkout. Intake ignores a PR in another repo, and dispatch leaves its task to a machine that has the checkout. |

`web.json` next to it holds the board's `url`; plain `http` is refused except for localhost. Every link to a task that the CLI prints or sends to Slack is `<url>/t/<id>`, built here: the board's own answers carry no link. The token comes from `env`. The CLI reads them on its first call to the board, so a command that fails on a usage error needs neither.

Logs: `~/.local/state/agent-board/logs/<task>.log`, one per task, emptied when a worker starts. The worker's own fatal errors are appended to it.

## The board server

`apps/backend`: Fastify, tRPC for the UI, Drizzle on Postgres; migrations run on start. `apps/frontend`: React, Mantine and TanStack Query, served by Caddy, which proxies `/trpc`, `/api` and `/healthz` to the backend. The backend's answers share the app's origin, so Caddy passes on none of their headers (`header_down -*`: an allow-list of nothing, so `Clear-Site-Data`, `Set-Cookie`, `Refresh`, `Link`, `Location`, `Service-Worker-Allowed`, `Strict-Transport-Security`, `Access-Control-*`, `Content-Encoding` and any header nobody thought of are dropped, and only the status and the body get through) and writes its own (`Content-Type: application/json`, `Cache-Control: no-store`, `Content-Security-Policy: sandbox; default-src 'none'`, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`, `Cross-Origin-Resource-Policy: same-origin`). The app's own CSP has `worker-src 'none'`, so no service worker can be registered, and a script served from a backend path is JSON to a browser anyway: a page the backend made up under `/api` or `/trpc` is not a page to a browser and cannot run script with the app's access to the keys in IndexedDB. The app itself is served with `Cross-Origin-Opener-Policy: same-origin`. Images: `agent-board-backend` and `agent-board-web` on GHCR, built by `.github/workflows/ci.yml` on a push to main, only after its typecheck, lint and test job passed (a manual run builds them too), and rolled out by Flux image automation.

Environment of the backend:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres, as a superuser or as the schema owner with CREATEROLE. Used only at start to create the app role and run migrations, then closed. |
| `APP_DATABASE_URL` | The same database as `board_app`, the unprivileged role that serves every request (no superuser, no BYPASSRLS). It must be `board_app`; the backend creates it with this URL's password, or resets the password, on start, and refuses to start if the role is privileged. |
| `ALLOWED_GROUPS` | Authelia groups that may use the UI, comma-separated. Default `admins`. |
| `DEV_AUTH_USER` | Local development only: act as this user without Authelia. The backend refuses to start with it in production. |
| `BACKFILL_OWNER` | Only for the first start on a database that already has tasks, from before boards were separated: the username that owns them. The migration stops with an error naming this variable when rows exist and it is unset; it is not needed on a fresh database and ignored afterwards. |
| `PORT` | Default 4000. |

Boards are separated per user: every row belongs to the signed-in user (`Remote-User`, lower-cased), and requests run as the unprivileged `board_app` role with row-level security, so a query only sees its owner's rows even if it forgets a `WHERE`. A machine token belongs to the user who made it on the Settings page, and the machine API works on that user's board. Two users may use the same machine name or dedupe key.

Two ways in:

- **The UI** (`/trpc`): Traefik runs Authelia's forward-auth and strips client-sent `Remote-*` headers before it; the backend takes the user from `Remote-User` and requires one of `ALLOWED_GROUPS` in `Remote-Groups`.
- **The machine API** (`POST /api/machine/<subcommand>`): its own Traefik route skips Authelia, matched only for that path with an `Authorization: Bearer` header. The backend looks the token up by its sha256 (tokens are shown once, on the Settings page) and refuses a revoked one. A token claims tasks only under its own machine name.

The cluster side (namespace, Postgres, Deployments, IngressRoutes, Authelia rule, image policies, DNS, nightly `pg_dump` into the restic backup) is `infra/cloud-infra/add-agent-board.patch`, written against codeplant-de/cloud-infra: `git apply` it there, fill in and encrypt `cluster/apps/agent-board/env.sops.yaml` and the new `ghcr-pull` entry, and apply the DNS with tofu. The images come from `codeplant-de/agent-board` on GitHub (`ghcr.io/codeplant-de/agent-board-*`).

## Encryption

Board content is end to end encrypted: the server stores and returns ciphertext it cannot read, and the clients (the CLI, the browser) seal what they send and open what they receive, with a data key of the user's own. The operator of the server and database can see ids, statuses, priorities, positions, machine and lane names, session ids, timestamps, schedule rules, usernames, field lengths, activity timing and which sealed values are equal (blind indexes of the PR URL and of the PR head: the same PR or head gives the same value, but neither can be searched for), but not what a task, note or transcript says. The PR head sha is no longer stored: only intake compares heads, so the board keeps `abh1.` plus an HMAC of it, and the sha cannot be used to find the PR.

The goal is stronger than secrecy: **a worker, and the browser, only acts on, or shows as trusted, text that the user's own clients sealed for exactly that purpose.** The operator can read, swap, replay and forge anything in the database and in API replies, but holds no key, so every sealed value is bound, through the additional data of its envelope (AES-256-GCM over the user, the field and a context), to the row and the role it was sealed for. One definition of the rules, `packages/shared/src/sealing.mts`, serves the CLI and the browser; its contexts are:

| Field | Context | Written by |
| --- | --- | --- |
| `title` | `<origin>` | the client that makes the task or schedule |
| `input` | `<origin>:<creator>` | the same client; `<creator>` is who made the task, which that client states itself |
| `workdir` | `<origin>`; for an occurrence also `task:<id>:schedule:<scheduleId>` | the same client; the worker for the occurrence's later rewrite |
| `note.body`, `note.preview` | `note:<taskId>:<author>:<kind>` | the client of that author |
| `note.questions` | `note:<taskId>:agent:question` | the agent's CLI |
| `note.answers` | `note:<taskId>:user:answer` | the user's browser |
| `tr.data`, `tr.output` | `<taskId>:<runId>:<seq>` | the worker |

`<origin>` is `task:<id>` for a task, and `schedule:<id>` for a schedule and for a task that is an occurrence of one (the server copies the schedule's ciphertext into each occurrence, so the occurrence opens against its schedule's id). `<creator>` is `intake`, `user` or `agent`; an occurrence's is `user`. Clients choose the ids of the tasks and schedules they make (12 random characters, a collision is a 409 whoever holds the id), because the fields are sealed against them. A value that does not open under exactly its binding is **unreadable**; nothing falls back to a looser reading.

What that stops:

- **Replay across rows.** A prompt, title or directory sealed for one task or schedule does not open on another, and a prompt of one row with the directory of another is unreadable. The server cannot run a replaced prompt, another task's prompt, or prompt A in directory B.
- **Occurrences.** Naming a schedule on a task opens only what the user sealed for that schedule: its own prompt in its own directory (or the directory the worker later rewrote for that occurrence, sealed with the schedule's id too, so a task cannot lend its directory to a schedule's prompt). `task.schedule_id` is a plain reference, not a foreign key, and stays when the schedule is deleted, so old occurrences keep opening; a task that loses it, or gets another, is unreadable.
- **Permission mode.** `createdBy` is clear and alone chooses between intake's restricted `dontAsk` allow-list and `--permission-mode auto`, so the creator is part of the `input` context: a prompt sealed as intake's does not open on a task the server relabelled as the user's, and the other way round. Intake seals as `intake` (`patch.seal.createdBy` for a requeue), never taking the creator from the board. The creator `agent` is never run: starting an agent's proposal seals its prompt again as `user` (see [Ask and resume](#ask-and-resume)).
- **Relabelled notes.** A note is bound to its author and kind: an agent note (which can quote an untrusted PR or a log tail) cannot be served back as "the user replied", nor a system note as an agent's. Only the pairs a client writes exist (agent comment or question, system event, user comment or answer).
- **Forged server events.** The server's own events are the only plain-text bodies, and a client accepts a plain body only when it is one of the fixed texts of `packages/shared/src/events.mts`: `Marked done.`, `Queued for a fresh run.`, `Closed.`, `Reopened.`, `Closed after <n> days in Done.`, `Moved from <status> to <status>.`, `Priority <priority> → <priority>.`, `Start time cleared.`, `Start time set to <ISO time>.`, `Taken back from <machine or "its worker">: no sign of life for 20 minutes.` The server writes them with the same module. They are shown as `server` events, never as `system` ones.
- **Re-attached answers.** The browser seals the questions it showed together with the answers in one envelope (`{"questions": [...], "answers": [...]}`), checked against each other. What the agent is told comes from that envelope alone; `questionNoteId` is only the server's pairing for display, and the browser shows an answer with a question only when the questions inside it are the question's own. The questions in the envelope are the ones the panel froze when it mounted for that open question, passed from the panel into the answer: the browser does not fetch the thread again when you press the button, and the panel does not follow the polls. A question note is immutable, so when the board later serves other questions under the same note id, the panel does not swap them in: it replaces the form with a notice that the question changed, drops your picks, sends nothing, and shows the changed questions (with fresh picks) only when you ask for them. Notes of one id are one note: when a thread holds the same note id twice, every note with that id is shown as unreadable.
- **Flags from the server.** A session id is a UUID or nothing, and the worker resumes only the session this machine started for the task's newest fresh run (the record is `<state dir>/sessions/<task>`, one id): any other id, the board's or an agent's, or one that Re-run fresh abandoned on this machine, blocks the run with a message pointing to Re-run fresh, because starting fresh would run a prompt again that may already have done its work. The record is per machine, so "a session a fresh run abandoned is never resumed" holds only on the machine that ran that fresh run: the board can still send an older session to another machine that recorded it (a resume is pinned to the machine in `machine`, which the board chooses), and that machine resumes it, with the reply it is handed. A narrowing that needs no trust in clear fields would be for a worker to drop its record when the sealed start notes the workers write (`agent-board: started <time> (<skill>, <machine>, …)`) show a newer run on another machine; it is not built, because the board can withhold or replay notes, so it would only help when the board cooperates. The id travels as `--resume=<uuid>`, one argument. The prompt itself (a sealed prompt or a reply, which can start with `-` or even look like `--mcp-config=…`) reaches `claude` on stdin, never as an argument, so it cannot be read as an option. Every other clear value that reaches an argument, a path, a unit name, an environment variable or a shell is checked to a tight shape when it is parsed: ids, machine and lane names (at most 64 characters), a schedule's cron expression (five fields of digits, cron symbols and month and day abbreviations) and time zone (one the runtime knows), note ids, the key id (16 hex characters), the user name, and the sealed directory (absolute, no control characters). A task has no `url` on the wire: see the next point.

- **Links and other server text that reaches the agent or Slack.** The CLI builds every task link itself, from the `url` in its own `web.json` and the task id, and uses no link from the board: the board sends none. Every other clear string the board sends is one of the following, and nothing else in a run's or a notification's text comes from it:

  | Clear value | Where it reaches the agent or Slack | What it is held to |
  | --- | --- | --- |
  | task and schedule ids, note and run ids | argv, unit names, `board tasks`, `board show` ids, the run's rules | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (not `dispatch` or `intake`) |
  | status, priority, `next`, creator, author, kind | `board tasks`, `board show` headers | members of a fixed list |
  | machine and lane names | dispatch's log (`pinned to <name>`), `board tasks` | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` |
  | session id | `--resume=<id>`, the message of a blocked run | a UUID this machine recorded for the task |
  | times (`notBefore`, `createdAt`, `nextRunAt`, ...) | `board tasks`, `board show`, `board schedules` | parsed to a date, printed by the CLI |
  | a schedule's cron expression and time zone | `board schedules`, the confirmation of `board schedule` | five fields from a fixed alphabet; a zone name the runtime knows |
  | key id | the message when a machine holds another key | 16 lower-case hex characters |
  | a server event's text | `board show` | one of the fixed texts, printed under `from the board server, not board content` |
  | the reason of a refusal, and what a parser quotes of a refused value | the error of a `board` command, the hook's answer to the agent | JSON-quoted, one line, at most 200 (refusal) or 40 (parser) characters, marked as the server's |

  Titles, prompts, directories and notes are the user's own sealed text and are not in this list. Slack gets the sealed title, the CLI's own link, and text the CLI wrote.
- **A key the board says is gone.** The browser keeps the keys it holds when the board reports no key, another key id or another user, and shows a blocking warning instead of the setup screen: a reset the user did not make looks the same, and would walk them into a second data key while the machines keep the first. The setup screen has no such protection when this browser holds no key at all (after Lock, in a private window, in a new browser) and the board reports none: it says that if the board was already in use, setting up again creates a new key that the worker machines do not hold and that cannot read anything stored under the old one, and it requires ticking a confirmation that this is a first-time setup. The way out of the warning is deliberate (typing a word); the Settings page shows and re-wraps a key only when it is the one the browser is using, whatever the board reports. A passphrase is trimmed and NFKC-normalised in one place before it is checked and hashed, so setup, unlock and change treat it alike. Everything the browser shows from the board in the clear (machine and lane names, who wrote a note, a run's machine, a schedule's rule, its run count and interval, a run's event count and a result's output size, which must be whole numbers; the name the board reports for you in the key warning, which is shown only when it looks like a login name) goes through the same shape checks as the CLI's wire parsers; a value that fails shows as a neutral placeholder, and the task page says so. The board's own events are shown as `Board`, apart from the `system` notes of your machines.

The server refuses a sealed field that is not an envelope (400) or that is longer than its limit (`SEALED_LIMITS`), and checks nothing about what is inside. So all content validation (a non-empty title, an absolute `workdir`, the shape of questions and answers, whether an answer fits its question) happens in the client, before sealing and after opening; the clients refuse too long a value themselves, naming the limit (`board comment --file` and `board add --file` included). A task's `dedupeKey` is the blind index (`abh1.…`, an HMAC) of the PR URL and `head` the blind index of `head:<sha>`, so the server can keep the one unique per board and nothing else. Labels are not stored: `taskLabels` in `packages/shared` derives them from the opened prompt and the creator. Existing rows stay plain text until the one-off re-encryption (`apps/backend/src/scripts/reencrypt.ts`, see [Cutover to encryption](#cutover-to-encryption)), which seals each field under the contexts above; the server hands them back untouched, and the CLI treats them as unreadable. A later release adds migration 0014, which makes the database refuse plain text in every sealed column (see [Cutover to encryption](#cutover-to-encryption)); it is not in this one.

**Previews.** A client that writes a note with text also sends `preview`: the first 300 characters of the text, sealed apart, for the board cards, which list every task's newest note without opening threads. A note without text (a question note, an answer without a message) has none. The board card shows a server event's own text when it is one of the fixed ones.

**Unreadable values.** The CLI never crashes a listing on a value it cannot open (legacy plain text, another key, another row, damage) and never treats one as a prompt. A task or schedule gets `unreadable`: the names of the fields that failed (`title`, `input`, `workdir`; a workdir that opens to a relative path counts). An unreadable title shows as a placeholder, an unreadable input is empty, an unreadable workdir is `null`. Dispatch skips a task whose input or workdir is unreadable and the worker refuses to run it, reporting why on the task; an unreadable title alone does not stop a run. A note that cannot be opened (or whose questions or answers do not parse) is `unreadable` with no text. A run is refused when it would hand the agent such a note of the user's: the reply a resume carries, or what a fresh run is told the user wrote since the previous run started. Older ones do not matter, so Re-run fresh (which starts after the refused attempt) does get past it. `board show` and `board tasks` print `(cannot decrypt …)` instead of text. The data key is read from `AGENT_BOARD_DATA_KEY` and is never printed or put into an error.

**What the server can still do.** The server relays what the user does, and the user's actions are not signed. A server that is hostile (or a stolen database login) can therefore decide **when** a task starts, resumes, re-runs, is paused or closed, **on which of the user's machines** (any machine that holds a token; the server picks the machine a task runs on) and **in which lane**, change a task's priority or position, and withhold, delay or reorder anything, notes and answers included. What it cannot do is make a worker run text the user's clients did not seal for that task, or run a task with the permissions of another creator, or put its own words in a note or an agent's prompt. It sees everything in the list at the top of this section. What an answer, a prompt or a note says, and which PR a task is about, it does not. Inherent to a server that stores ciphertext and cannot sign what the user did:

- Ciphertext never expires. The server can run a closed or done task again, and a deleted or paused schedule, as often as it likes: the prompt still opens, and the run is judged as the user's.
- Within one task it can replay an older value of a field (an earlier prompt or directory of that task) and reorder, duplicate or withhold notes, including serving an older reply after a newer question. A note's id, author, kind and task are bound; its place in the thread is not.
- It can insert any number of the fixed event texts; `Taken back from <machine>` carries a machine name, at most 64 characters of `[A-Za-z0-9_.-]`.
- A passphrase change leaves the old wrapped copy of the key with the server, and there is no rotation of the data key: a passphrase or a key that has leaked stays leaked, and a recovery key that was kept still opens the board.
- Every worker machine keeps the raw data key in `~/.config/agent-board/env`, readable by any process of that user, an agent in `auto` mode included: an agent that reads it can seal what it likes, as any creator.
- An unlocked browser stays unlocked until Lock, per tab, and its derived keys stay in IndexedDB until then.
- It can drop a task's directory (`workdir: null`), which makes the task run in the lane's or the default directory of that machine instead of the one the user chose.

**Error text from the server is not board content.** A `board` command, and the hook that tells an agent a question could not be put on the board, report a server refusal as `error from the board server (HTTP <status>), quoted and not part of the board: "<text>"`: the server's words, JSON-quoted, one line, at most 200 characters. The agent sees them as an error, never as a note, a prompt or an instruction, and a client never shows server text as board content: what a parser quotes of a value it refuses is quoted and cut at 40 characters too.

## Backend contract

The spec between the CLI and the board, contract version 7. The CLI calls the board's machine API from its own process (`apps/cli/src/backend.mts` over HTTP, `apps/cli/src/sealing.mts` for the encryption); `apps/backend/src/machine-api.ts` serves it. Nothing else implements it. Everything below describes the wire, where sealed fields hold envelopes; the CLI's own `Backend` interface (`packages/shared/src/contract.mts`) is the plaintext view of it.

`POST <url>/api/machine/<command>` with `Authorization: Bearer <machine token>` and a JSON body `{"id"?, "all"?, "machine"?, "author"?, "body"?}`: `id` is the task, `body` is the command's payload (JSON, with the sealed values). The answer is `{"result": ...}` with status 200, or `{"error": "one line"}` with a non-200 status. The token names the machine; it never appears in an error message. A call times out after 45 seconds.

### Events

`GET <url>/api/machine/events` with the same bearer token is a stream of server-sent events (`content-type: text/event-stream`, `cache-control: no-cache`, `x-accel-buffering: no`). A missing, unknown or revoked token is a 401 JSON error before any stream starts. It says "look at the board again" and carries no data; the CLI then reads with `list-tasks` as always.

- On connect the server sends the comment `: connected`, and every 25 seconds `: ping`. At each ping it checks the token again and ends the stream when it was revoked. The CLI treats 60 seconds without a byte as a dead connection.
- `event: tasks` with an empty `data:` follows a committed change to a task or a schedule: any write command except the ones below, and any change to a task or schedule from the UI. A failed or rolled back call sends nothing.
- `heartbeat` and `transcript` send nothing (every running task sends them every 15 seconds, and they change no dispatch decision), nor do the reads (`version`, `list-tasks`, `get-task`, `read-notes`, `list-schedules`) or the UI's changes to machines and keys. Nothing is sent when the hourly cleanup closes old Done tasks or deletes old transcripts; the timer covers those.
- Changes of one owner are held back 500 ms and sent as one event, so a burst gives one. An event reaches only the streams of tokens that belong to the same owner.
- The signal lives in the backend process, which is enough for one replica. A stream that was down misses events; the CLI runs one tick after every connect.

### Rules

- Every command is atomic under concurrent calls: the dispatcher and intake of several machines, workers and people call at the same time.
- A write is visible to the next read.
- The server refuses an unsafe id or machine name with 400 and writes nothing; the CLI refuses it before it sends anything.
- `claim-task` answers 409 when the task is not free for this machine ("lost"). The CLI treats that as an answer and moves on to the next task; every other non-200 answer is a failure.
- The CLI sends `version` once per process, before its first other call, and stops when the server's `contract` differs from its own (7), saying which side is older. It then derives its keys for the `owner` the server names, and stops when the board has no data key yet (`keyId: null`: set up encryption in the browser first) or its key's id differs from `keyId`.
- A sealed value comes back verbatim. The core parses `agent-board: started <iso>` notes (the start marker) and the first line of a review task's `input` (the PR URL) after opening them; the PR head is the `head` field, a blind index.
- A task an agent proposed (`createdBy: agent`) is the user's to start: the server refuses `update-task` with a new status and loses `claim-task` for it, whoever asks. The user starts it in the browser, which moves it into Todo with its prompt sealed again for the creator `user`; the board then stores that prompt and sets `createdBy` to `user`. The core never runs a task whose `createdBy` is `agent`.
- The board sends no link to a task. The CLI builds links itself from the `url` of its `web.json`.
- The core never writes to a task that is `closed`. A worker that finds its task closed after the run, or running again with another `runStartedAt` than it started with (taken back and run on another machine), drops its result. Any other outcome is judged on the task's `status` after the run: anything but `running` counts as reported (the agent reported, you answered while it was still ending its turn, or the task was taken back). A todo task whose worker unit is still active is not started again until the unit is gone.

### Task

```json
{
  "id": "Ab3dEf9x",
  "title": "abe1.…",
  "input": "abe1.…",
  "status": "needs-me",
  "createdBy": "intake",
  "priority": "normal",
  "closed": false,
  "machine": "laptop",
  "sessionId": "591d2ec1-d4ab-4e26-ac04-ed303f8fa44a",
  "workdir": "abe1.…",
  "next": "fresh",
  "head": "abh1.…",
  "openQuestion": true,
  "lane": null,
  "borrowed": false,
  "lastActiveAt": null,
  "runStartedAt": null,
  "paused": false,
  "notBefore": null,
  "scheduleId": null
}
```

All twenty fields are required. The CLI's plaintext `Task` adds `labels` and `unreadable`.

| Field | Meaning |
| --- | --- |
| `id` | Opaque string, stable for the life of the task, chosen by the client that makes it (12 random characters), because the sealed fields are bound to it. It ends up in a systemd unit name, a log file name and argv, so the core refuses any id that does not match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, and the ids `dispatch` and `intake`. |
| `title` | Sealed, for the task (an occurrence: for its schedule). One line, shown in lists and Slack. |
| `input` | Sealed, for the task and its creator (an occurrence: for its schedule and `user`). What to work on. |
| `createdBy` | `intake`, `user` or `agent`. Intake's tasks run with intake's narrow permissions and in the PR's checkout. Part of the context of `input`, so a changed value makes the task unreadable. `agent` is a proposal the user has not started: no worker runs it, and starting it changes it to `user` with the prompt sealed again. |
| `status` | One of `backlog`, `todo`, `running`, `needs-me`, `done`. |
| `priority` | One of `urgent`, `high`, `normal`, `low`. |
| `closed` | `true` for a task out of the workflow. Closed tasks are only listed with `all`; the core never starts, requeues or writes to one. |
| `machine` | The machine that claimed it last, or `null`. A resume runs only there. |
| `sessionId` | The Claude session of the last skill run, or `null`. A UUID (anything else is refused by the parser: it goes into `--resume=<id>`), and a worker resumes only one it started itself for the task. |
| `workdir` | Sealed, or `null`: an absolute path without control characters. The directory that session was in when it last stopped, on `machine`, or `null`. A resume starts there (see [Where a task runs](#where-a-task-runs)). |
| `next` | `fresh` or `resume`: what the next run does. |
| `head` | The blind index (`abh1.…`) of `head:<sha>` for the PR head sha an intake review was made for, or `null`. Intake compares it with the blind index of the PR's head (`Backend.indexHead`) to see that it moved; the sha itself is never stored. |
| `openQuestion` | The agent's last question has no answer yet. |
| `lane` | While running: the lane that runs it, from the last heartbeat; otherwise `null`. A machine-name-shaped value. |
| `borrowed` | While running: the lane borrowed it; otherwise `false`. |
| `lastActiveAt` | While running: the last heartbeat, ISO 8601; otherwise `null`. |
| `runStartedAt` | While running: when the worker claimed it, ISO 8601; otherwise `null`. |
| `paused` | The last run gave up its slot (`pause`) and the task has not run since. Unlike the board's "Paused" badge, which shows it only in Todo, it stays `true` through the claim, so the worker that resumes the task can tell the agent; the worker's first `update-task` of the run clears it, as does the task leaving Running another way. |
| `notBefore` | Todo only: no machine may claim the task before this time, ISO 8601; otherwise `null`. The server clears it whenever the task leaves Todo, the claim included. |
| `scheduleId` | The schedule the task is an occurrence of, or `null`. Set by the server when a schedule makes the task; no draft or patch can set it. It stays when the schedule is removed, because the occurrence's sealed fields are bound to it. |

Pickup order is the order of the array that `list-tasks` returns: within a status, the first task is the top. In Todo the store lists resumes (`next: resume`) first, then by `priority`, then by manual order; the lanes pick from that order. Waiting tasks (`notBefore` in the future) come last in Todo, by `notBefore`; once due they sort like any other. The dispatcher does not try to claim a waiting task.

### Schedule

```json
{
  "id": "Sc3dEf9x",
  "title": "abe1.…",
  "input": "abe1.…",
  "priority": "normal",
  "machine": "laptop",
  "workdir": "abe1.…",
  "everyMs": 7200000,
  "cron": null,
  "timezone": null,
  "anchorAt": "2027-01-01T08:00:00.000Z",
  "nextRunAt": "2027-01-01T10:00:00.000Z",
  "remaining": 3,
  "until": null,
  "paused": false,
  "ended": false,
  "occurrenceTaskId": "Ab3dEf9x",
  "createdAt": "2026-11-14T10:00:00.000Z"
}
```

All seventeen fields are required (`title`, `input` and `workdir` sealed for the schedule; `id` is chosen by the client). Exactly one of `everyMs` (an interval in ms, at least one minute, on the grid `anchorAt + k * everyMs`) and `cron` (5 fields, read in the IANA zone `timezone`, which a cron rule needs) is set. `anchorAt` is the first run of an interval, or the time a cron rule matches from. `nextRunAt` is the start time of the pending occurrence (read from its task, so a changed delay shows), `occurrenceTaskId` its task; both are `null` while the schedule is paused with nothing waiting, and once it has ended. `nextRunAt` is also `null` while `occurrenceTaskId` is set when the pending task has no start time any more (it was told to run now): it is due now. `remaining` is the number of occurrences still to be made after the pending one (`null`: forever), `until` the last time an occurrence may start. `machine` and `workdir` pin the occurrences, or are both `null`.

A schedule always has at most one pending occurrence, a task in Todo with `scheduleId` set and `notBefore` at `nextRunAt` (until someone changes it); its `createdBy` is `user`, and its `title`, `input` and `workdir` are the schedule's ciphertext, copied unchanged and opened against the schedule's id (the worker may later replace the directory with one sealed for the occurrence and its schedule; see [Encryption](#encryption)). When that task leaves Todo (a claim, `update-task`, a move, a close), in the same transaction the server makes the next one: the first match of the rule after the previous occurrence's time that is not in the past, so missed runs are skipped. With nothing left (`remaining` used up, or the next match after `until`) the schedule ends (`ended: true`) and makes no more. A task that was an occurrence and returns to Todo later does not trigger another; only the pending one does.

### Note

```json
{ "id": "n1", "body": "abe1.…", "preview": "abe1.…", "createdAt": "2026-11-13T10:00:00Z", "author": "agent", "kind": "comment" }
```

`author` is `agent`, `user`, `system` or `server`; `kind` is `comment`, `question`, `answer` or `event`. `body` is sealed for its task, author and kind, except on an `author: "server"` note, whose body is plain text and one of the fixed event texts (see [Encryption](#encryption)); `preview` is a sealed preview or `null`. A question note adds `questions` and an answer note `answers` (both sealed JSON: the list `ask` took, and `{"questions": [...], "answers": [...]}` with one `{"selected": [labels], "other"?: text}` per question) and `questionNoteId`, which only informs. The CLI's plaintext `Note` has `text` instead of `body`, keeps a server event as `author: "server"`, gives an answer note the `questions` from its own envelope, and adds `unreadable`. A resume prompt is built from the `user` notes after the last `agent` note.

### Commands

| Command | Request | `result` |
| --- | --- | --- |
| `version` | - | `{"contract": 7, "owner": "<username>", "keyId": "<16 hex>" or null}` (the user whose board the token works on, which the keys are derived for, and the fingerprint of that user's data key; null before they set up encryption) |
| `list-tasks` | `all?` | `[Task, ...]` in priority order |
| `get-task` | `id` | `Task` |
| `add-task` | `body`: `{"id", "title", "input", "status"?, "priority"?, "dedupeKey"?, "parentId"?, "createdBy"?, "machine"?, "workdir"?, "head"?, "notBefore"?}` | `{"task": Task, "created": bool}` |
| `update-task` | `id`, `body`: `{"status"?, "priority"?, "input"?, "sessionId"?, "workdir"?, "next"?, "head"?, "notBefore"?, "expect"?}` | the updated `Task`, or status 409 |
| `claim-task` | `id`, `machine` | the claimed `Task`, or status 409 |
| `add-note` | `id`, `author?` (`agent` or `system`), `body`: `{"body", "preview"?}` | `null` |
| `ask` | `id`, `body`: `{"body", "questions"}` (a sealed empty body, sealed questions JSON) | `null` |
| `heartbeat` | `id`, `body`: `{"lane": string, "borrowed": bool}` | `null` |
| `pause` | `id`, `body`: `{"body", "preview"?}` | the updated `Task` |
| `fail` | `id`, `body`: `{"body", "preview"?}` | `{"applied": bool, "task": Task}` |
| `transcript` | `id`, `body`: `{"runId", "startedAt", "sessionId", "resumed", "events": [...]}`, each event `{"seq", "at", "kind", "parent", "data", "output"?, "outputSize"?}` | `null` |
| `read-notes` | `id` | `[Note, ...]`, oldest first |
| `add-schedule` | `body`: `{"id", "title", "input", "everyMs"? \| "cron"? + "timezone", "priority"?, "machine"?, "workdir"?, "startAt"?, "times"?, "until"?}` | `{"schedule": Schedule, "task": Task}` (the pending occurrence) |
| `list-schedules` | - | `[Schedule, ...]`: running ones first, then paused, then ended |
| `update-schedule` | `id`, `body`: `{"paused": bool}` | the updated `Schedule` |
| `remove-schedule` | `id` | `null` |

- `version`: see the rules above.
- `add-task`: `id` is the client's (the safe shape above; a taken id is 409, whoever holds it, with the same message), `title` and `input` are sealed (an empty input is sealed too), `workdir` sealed, `dedupeKey` the blind index of the key (`abh1.…`, else 400), `status` defaults to `todo`, `priority` to the parent's with a `parentId` and to `normal` without, `createdBy` (`intake`, `user`, `agent`) to `user`. `machine` and `workdir` come together and pin the task there. The new task goes to the bottom of its status. A plain-text `title`, `input` or `workdir` is refused with 400. With a `dedupeKey` that a task already has, nothing is created: the answer is that task with `created: false`. `createdBy: agent` makes the task a proposal: it lands in `needs-me` whatever `status` the draft names. `head` is the blind index of the sha (`abh1.…`, else 400). `notBefore` (ISO 8601) is accepted only with status `todo` (else 400).
- `update-task`: at least one key; unknown keys are a failure. `input` and `workdir` are sealed. A status or priority change puts the task at the bottom of its new place. A status change of a proposal is refused with 403. Leaving `needs-me` for `todo` or `done` clears `openQuestion`. `head` is a blind index, or `null` to clear it. `sessionId` is a UUID or `null`. `expect` is a status and not a change: when the task's status differs under the update's lock, nothing is written and the answer is 409 (intake uses it, so a close or requeue planned from an earlier listing cannot hit a task a dispatcher claimed since). It does not count as a key. `notBefore` is an ISO 8601 time, or `null` to clear it; a time is refused with 409 unless the task ends up in `todo`.
- `claim-task`: `todo` to `running` for the machine, at the bottom of running, in one atomic step. Lost when the task is not in `todo` (a `backlog` task is never claimed), or when it is a resume (`next: resume` with a session) pinned to another machine. A token claims for its own machine only. Lost for a proposal (and for any task whose `createdBy` is `agent`). Sets `runStartedAt`; `paused` stays as it is. Lost while `notBefore` is in the future.
- `add-schedule`: `id` is the client's, as for `add-task` (409 when taken). Exactly one of `everyMs` and `cron`; `cron` needs its `timezone`, and `timezone` goes only with `cron`. `title`, `input` and `workdir` are sealed. `machine` and `workdir` come together. `startAt` (ISO 8601; default now) is the first run of an interval and the earliest match of a cron rule. `times` (a positive integer, the number of occurrences in all) and `until` (ISO 8601) exclude each other; neither means forever. The answer is 400 for a cron expression the server cannot read (6-field patterns included), an unknown time zone, an interval under a minute, or a rule with no run before `until`, and nothing is written. The schedule and its first card are made in one transaction.
- `update-schedule`: `paused: true` takes the pending occurrence off the board when it never ran (still in Todo, no session, no run) and gives its run back to `remaining`; `paused: false` makes the next occurrence at the first match from now. 409 for an ended schedule. Pausing a paused schedule, or resuming a running one, changes nothing.
- `remove-schedule`: deletes the schedule and a pending occurrence that never ran; tasks that ran stay, keeping their `scheduleId`. 404 for an unknown schedule.
- `add-note`: author `agent` makes a `comment`, `system` an `event`; both bodies are sealed (else 400), and the CLI refuses an empty text before sealing. `preview` is the sealed start of the text, or absent.
- `heartbeat`: sets `lastActiveAt` to now with the lane, on a running task only; on any other it changes nothing.
- `transcript`: appends a run's condensed events (see `packages/shared/src/transcript.mts`; at most 5000 per call, each with an integer `seq` from 0 and a parseable `at`, or the call fails with 400). `data` is the sealed JSON of the event without its output. A `tool_result` also carries the sealed `output` and `outputSize`, its length in characters counted by the client (the server cannot read it; it is bounded, nothing more); any other event carries neither. an event already stored (same run and `seq`) stays as it is, so a retried batch is harmless.
- `pause`: a running task only. Adds the sealed note as a `system` event, then moves the task to Todo with `next: resume` (`fresh` without a session), at the top, and sets `paused`.
- `fail`: in one step, if the task is still `running` and not closed, adds the sealed note as a `system` event and moves the task to `needs-me`, and answers `applied: true`; otherwise it changes nothing and answers `applied: false` with the task as it is.
- `ask`: adds a question note with the sealed questions, and moves the task to `needs-me` with `openQuestion: true`. Refused with 403 for a proposal. The CLI validates the questions before sealing (1 to 4; a header of at most 16 characters; 2 to 4 options with different labels, at most one `recommended`); the server cannot.

## What a worker may do

There is no sandbox. A worker runs `claude` as you, with your home directory, your SSH agent and your `gh` login. How much it may do depends on who made the task:

- **Tasks you made** (`board schedule`, the New task form, and agent proposals once you start them) run as if you ran the prompt in your terminal: all your settings (user, project, local) and `--permission-mode auto`, Claude Code's classifier mode that lets safe actions through and refuses risky ones. Headless, a refusal cannot become a prompt; it shows in the log and usually in the agent's report.
- **Intake's reviews** run unattended on PR text nobody chose to read, so they get less: `--permission-mode dontAsk` with only `intake.allowedTools` allowed and `intake.disallowedTools` denied on top, and `--setting-sources user`, which keeps a checkout's own `.claude/settings*.json` (its allow rules and tokens) out of the run. The shipped list allows reading, `gh` reads, the pr-review scripts, `board comment`, `ask`, `add`, `show` and `move <task> needs-me` (it cannot `board schedule` or start work), CircleCI through the engineering plugin's `cci.sh`, a few Shortcut reads and `bin/replica-psql` (the production and staging read replicas); it cannot push, merge or approve. `intake.env` hands it `CIRCLECI_TOKEN`, `SHORTCUT_API_TOKEN` and the replica endpoints from the checkout's settings, and nothing else from there. A review that a PR's text turns against you can read production data through the replica, and could put it into the pending draft (which you see before submitting) or onto the board.

Every run gets `AGENT_BOARD_TASK=<id>` in its environment, and `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, so print mode waits for background subagents instead of stopping them 10 minutes after the last turn. The board's rules also tell the agent not to end its turn while background work runs. And `board schedule` and the changes of `board schedules` refuse to run while it is set: an agent proposes follow-up work with `board add`, which waits in Needs me until you start it. A config that allows `Bash(board *)` covers `board schedule` and `board move <task> todo`; narrow it to the rules in `config.example.json` (`board comment *`, `board ask *`, `board add *`, `board show *`, `board move * needs-me`), and deny `Bash(board schedule *)`, `Bash(board schedules *)` and `Bash(board internal *)`.

Permission rules match the text of a call: they keep an agent on its task, but they are not a security boundary. A PR or story whose text turns the agent against you reaches whatever the run allows and whatever those commands can reach. A dedicated OS user for the workers, with its own checkouts and a narrowly scoped GitHub token, would make that a boundary again; it is not set up yet.

## How a task runs

A fresh run is

```
claude -p "<prompt>" --session-id=<new uuid> --append-system-prompt "<the board's rules>" --settings '<hook>' <permissions>
```

in the task's directory (see [Where a task runs](#where-a-task-runs)). The prompt is the task's `input`, as written. The appended rules tell the agent its task id, to report with `board comment`, to ask with `board ask` instead of AskUserQuestion, to finish with `board move <task> needs-me`, and how to propose follow-ups. The hook is the [heartbeat, pause and question hook](#liveness-and-limits). A resumed run is `claude -p "<your reply>" --resume=<session>` with the same flags (see [Ask and resume](#ask-and-resume)).

In intake's rules, `Bash(` rules expand `~/` to your home directory and `{<plugin>}` (such as `{pr-review}` or `{engineering}`) to the root Claude Code gives `<plugin>@ccc` as `${CLAUDE_PLUGIN_ROOT}`, resolved when the worker starts: for a marketplace added as a directory (`~/.claude/plugins/known_marketplaces.json`) that is the plugin's `source` in the marketplace's `.claude-plugin/marketplace.json` (Claude Code loads it from the checkout, not from the cache copy), otherwise the `installPath` in `~/.claude/plugins/installed_plugins.json`. A rule must not start with `*` before a script path: a leading `*` matches any command that merely contains the path. If the plugin path cannot be resolved the task goes to `needs-me` with the reason. `Read(...)` rules are passed on unchanged (they take `~/` themselves). Old `backend`, `labels`, `intakeLabel` and `sandbox` entries in a config are ignored.

A missing allowed tool in an intake review shows up as a failed run: the log says what was denied. Add it to `intake.allowedTools`.

## Commands

`<task>` is a task id; outside a run it can also be a link to the task on the board or the start of an id (3 to 7 or 9 to 11 characters, unique; an id is 12 characters, or 8 for older tasks, and those lengths are whole ids). A link counts only when it is `<web.json url>/t/<id>`, the form the CLI prints. `--json` prints tasks, threads and schedules as JSON for scripts. `--dry-run` reads everything and prints every write as `DRY ...` instead of doing it. A usage error exits 2, any other failure 1. `dispatch` and `intake` are `board internal dispatch|intake`, started by the timers; the wrappers `apps/cli/bin/dispatch` and `apps/cli/bin/intake` of a checkout take their own lock (`$XDG_RUNTIME_DIR/agent-board-{dispatch,intake}.lock`, the one the units use), so a run by hand cannot overlap a timer run. When the lock is held they exit 75 without output.

A file given with `--file` (`comment`, `ask`, `add`) is read only from a regular file in `/tmp`, without following a link, and only on Linux.

The reference below is generated from the program (`pnpm --filter @agent-board/cli docs`), as `board help <command>` shows it.

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
  comment <task> [text...]  add a note to a task
  move <task> <status...>   move a task to the bottom of a status
  notify <task> <text...>   Slack message with the task link
  ask <task>                ask the user 1-4 questions
  add                       propose a follow-up task

Scheduling:
  schedule <prompt...>      a task from a prompt, run here on this machine
  schedules [action...]     list, pause, resume or delete repeating schedules
  delay <task>              delay a task in Todo, or make it due at once

Setup:
  init                      write web.json, env and config.json for this machine
  doctor                    check this machine: config, token, server, worker
                            tools and units
  setup                     install the dispatch and intake timers and the
                            listener as systemd user units
  self-update               replace this binary with the newest release
  completion <shell>        print a shell completion script
  help [command]            show the help of a command

Run "board help <command>" for the details and examples of one command.
```

### Tasks

#### board tasks

```
Usage: board tasks [options]

List the open tasks per status, with their id, priority and title, and when a
delayed task starts. --all adds the closed ones, --status shows one status.

Options:
  --all              closed tasks too
  --status <status>  only this status (backlog, todo, running, needs-me, done;
                     "Needs me" works too)
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

#### board show

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

#### board comment

```
Usage: board comment [options] <task> <text...|-|--file <path>>

Add a note to the task's thread. The text is every word after the task, quoted
or not, and is never read as a flag.

`-` reads the text from stdin; `--file <path>` right after the task reads it
from a regular file in /tmp, for long text.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id
  text        the note

Options:
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board comment Ab3dEf9x "step 3 done"
  board comment Ab3dEf9x tests pass, one flaky
  board comment Ab3dEf9x --file /tmp/review.md
  echo "from a script" | board comment Ab3dEf9x -
  board comment Ab3 looks good
```

#### board move

```
Usage: board move [options] <task> <status...>

Move a task to the bottom of a status: backlog, todo, running, needs-me, done.
"Backlog", "Todo", "Running", "Needs me" and "Done" work too.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id
  status      the status to move it to

Options:
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board move Ab3dEf9x needs-me
  board move Ab3dEf9x Needs me
  board move Ab3 todo
```

#### board notify

```
Usage: board notify [options] <task> <text...>

Send a Slack message with the task link. The text is every word after the task;
`-` reads it from stdin.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id
  text        the message

Options:
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board notify Ab3dEf9x "needs your decision"
```

#### board ask

```
Usage: board ask [options] <task>

Ask the user 1-4 questions and move the task to needs-me; Slack is told. The
user answers on the board and the run is resumed with the answers.

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

#### board add

```
Usage: board add [options]

Propose a follow-up task; the file is its prompt. It waits in needs-me until the
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

### Scheduling

#### board schedule

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

With --json, print {"id", "url"} of the task on stdout; everything else goes to
stderr. Not available inside a board run: there, propose follow-up work with
`board add`.

Arguments:
  prompt                 what the task should do

Options:
  --priority <priority>  urgent, high, normal, low (default normal)
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
  --new                  skip the duplicate check
  --dry-run              read everything, print every write instead of doing it
  --json                 print JSON on stdout instead of text
  -h, --help             display help for command

Examples:
  board schedule /review-pr 17741
  board schedule --priority high /review-pr cosuno/cosuno#17741 --auto
  board schedule "Find out why the bidder export is slow and propose a fix"
  board schedule --in 2h /review-pr 17741
  board schedule --at 09:00 /grill the plan in docs/x.md
  board schedule --every 2h --times 5 /sweep the stale branches
  board schedule --cron "0 9 * * 1-5" /review-pr --auto
  board schedule --hold -- --weird prompt
  board schedule --json /review-pr 17741
```

#### board schedules

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

#### board delay

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

### Setup

#### board init

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

#### board doctor

```
Usage: board doctor [options]

Check this machine, read-only, one line per check: ✓ passes, ✗ fails (with a
fix), ! is a warning. Exit 1 if any check fails; warnings alone exit 0. The
token is never printed.

Checks: Node 24+ (checkout only), the config directory, web.json, env (mode 600
or 400, token, data key), the board (reachable, token accepted, contract
version, and whether it has a data key and this machine holds the same one),
config.json, and for a worker machine claude, gh, flock, systemd-run, systemctl
and the installed units with their timers and the listener. The worker checks
only warn on a machine with no unit installed.

Options:
  --json      print JSON on stdout instead of text
  -h, --help  display help for command

Examples:
  board doctor
  board doctor --json
```

#### board setup

```
Usage: board setup [options]

Install this machine as a worker: write the dispatch and intake services and
timers and the listener service into ~/.config/systemd/user (or
$XDG_CONFIG_HOME/systemd/user) as copies, run `systemctl --user daemon-reload`
and print the line that enables them. The listener holds a stream to the board
and starts a dispatch tick within a second of a change; the timers stay as the
fallback. Run it again after moving the binary or the checkout, or upgrading
Node. It needs Linux with systemd and flock.

The services run this CLI the way `board setup` was started: the binary, or the
checkout with its Node. --print shows the units and changes nothing; --enable
also enables and starts the timers and the listener. When an installed unit
differs from what it writes, the differing lines are shown. It refuses unless
--force when this checkout is not the one the installed ~/.local/bin/board runs
from (a worktree, a scratch copy), or when a binary runs from the temp
directory, so it cannot take over the live timers. Not available inside a board
run.

Options:
  --enable    also enable and start the timers and the listener
  --force     install although this checkout is not the installed one, or the
              binary runs from the temp directory
  --print     print the units and change nothing
  -h, --help  display help for command

Examples:
  board setup
  board setup --print
  board setup --enable
```

#### board self-update

```
Usage: board self-update [options]

Download the newest cli-v* release of codeplant-de/agent-board with `gh`, check
it against SHA256SUMS and replace this binary with it. Running workers keep the
old file until they end. --check only reports whether a newer release exists.

It needs `gh`, logged in. A checkout is updated with `git pull` and `pnpm
install` instead, and says so. Not available inside a board run.

Options:
  --check     only report whether a newer release exists
  -h, --help  display help for command

Examples:
  board self-update --check
  board self-update
```

#### board completion

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

<!-- commands:end -->

## How it decides

Dispatcher, per tick:

1. For each task in `running` claimed by this machine, ask `systemctl --user is-active agent-board-<task>`. A task whose unit is gone moves to `needs-me` with the log tail, timed from the unit's own start (else the task's `runStartedAt`). So does one whose worker failed to enforce the [limits](#liveness-and-limits) for five minutes past them; its unit is stopped. If `systemctl` gives no known state, or the backend fails, the tick stops before starting anything and exits non-zero.
2. A task this machine cannot serve is skipped (see [Two machines](#two-machines)). The rest are planned into [lanes](#lanes): own work first, then borrowing. Each start is claimed, its lane written to the run directory, then `systemd-run --user --collect --unit agent-board-<task>` starts the worker and a start note names the machine, lane and PID. A lost claim hands its slot to the next task; the first failed start ends the tick's starting.
3. Lanes whose own work still waits ask one borrowed run each to pause.

Worker, per task: a task with `next: resume`, a session, and a user reply or a pause since the agent last spoke resumes that session with the reply (and "you were paused") as the prompt, but only a session this machine started for the task; for any other the run is refused with the reason. Anything else starts a new session, whose id is recorded on this machine and stored on the task once the run is about to start (and cleared again if the process cannot be spawned). A run is also refused when it would hand the agent a note of yours that cannot be decrypted. A fresh run's prompt is the task's prompt; when the thread already holds notes by you or the agent, it is followed by what you wrote since the previous run started and a line telling the agent to read the thread with `board show <task>`. Either way `next` goes back to `fresh`.

Intake, per run: search the repos in `repos` for open, non-draft PRs that request your review, then create one task per PR URL (the dedupe key), checked against every task, closed ones included. One `gh api graphql` call per page covers all repos. A PR without an author (a deleted account) is listed as `ghost`. A PR whose data cannot be read is logged as `WARN skipped <url>` and its task is left alone; a result without a URL fails the run. A failed GitHub search or backend listing changes nothing and exits non-zero.

- A PR whose head moved and whose last commit is at least ten minutes old sends its task from `needs-me` or `done` back to `todo` (a task parked in `backlog` stays there) with `next: fresh`. A failed task stays in `needs-me` until the head moves.
- A task still waiting in Todo for a PR that no longer appears (merged, closed, draft, or no longer asking for your review) is moved to `done` with a note, and its `head` is cleared in the same update.
- A PR that is listed again with the same head brings such a task back: a settled PR whose intake task is `done` without a head is queued again the same way. A task you marked done keeps its head and stays done.

## Development

```
docker compose up -d postgres        local Postgres on :54331 (board_dev, board_test)
cp apps/backend/.env.example apps/backend/.env
pnpm dev:backend                     :4000, as DEV_AUTH_USER
pnpm dev:frontend                    :5173, proxies /trpc and /api
pnpm typecheck && pnpm lint && pnpm test
pnpm format                          Prettier over the repo (`pnpm format:check` in CI)
pnpm db:generate --name <change>     after editing apps/backend/src/db/schema.ts
```

To point a worker at the local board: a token and the data key from http://localhost:5173/settings, `web.json` with `"url": "http://localhost:4000"`, and `AGENT_BOARD_CONFIG_DIR` / `AGENT_BOARD_STATE_DIR` at scratch directories so the real config and logs stay untouched.

CLI decision logic is in `apps/cli/src/decide.mts`, `planIntake` and the `run*` functions, which take a backend, GitHub and system interface as arguments; tests inject fakes (`apps/cli/test/helpers.mts`). Backend tests are integration tests against `board_test` (reset on every run), through `app.inject` for the machine API and tRPC callers for the UI. Three test skills in `apps/cli/test/skills` run real headless checks; link one into `~/.claude/skills` and schedule it with `board schedule /<name>`. `board-selftest-ask` asks one question through AskUserQuestion and reports the answer after you answer on the board. `board-selftest-slow` works through eight 15-second steps: with two lanes of one slot each (one owning it), schedule two so one lane borrows, then schedule own work for that lane, and the next tick after `pauseAfterMinutes` pauses the borrowed run, which later resumes in its session. `board-selftest-worktree` enters a worktree first, so a pause and resume show that the session continues in it.
