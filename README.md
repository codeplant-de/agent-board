# agent-board

A board for headless Claude Code runs. Each task is a conversation: the agent posts its findings as markdown, asks you questions with options to pick, and picks up where it left off when you answer. Phase 1 is PR review; any skill can be a task type.

Three parts, one repo (pnpm workspace):

| Part | Where it runs | What it does |
| --- | --- | --- |
| `apps/backend` and `apps/frontend` | board.codeplant.de (k3s, behind Authelia) | The board: tasks, threads, questions, the buttons. Postgres is the only state. |
| `apps/cli` | each worker machine (laptop, workstation) | systemd timers: `dispatch` claims tasks and starts `claude -p` workers, `intake` turns review requests into tasks. `board` is the command the agent uses to report. |
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

On the task page you pick options (number keys work), add text where none fits, and press **Answer & continue**. On a task without a question, write a reply and press **Send & continue**. Both put the task at the top of its priority in Todo with `next: resume`. The next dispatch tick on the machine that ran the session starts `claude -p "<your reply>" --resume <session>`, so the agent keeps its context. The other buttons:

| Button | Effect |
| --- | --- |
| Mark done | Done. |
| Re-run fresh | Back to Todo with a new session; the agent sees the thread, not the old context. |
| Comment without continuing | A note in the thread, nothing runs. Works while a task runs too. |
| Close / Reopen | Out of the workflow; workers ignore it, intake never makes a second task for its PR. |
| Start / Discard | On a task an agent proposed. Dragging it into Todo starts it too. |
| Take back | On a running task whose agent has been quiet for 20 minutes (the text turns red after 10, but one long command is quiet that long): its worker is gone, say because the machine is off. The task goes to `needs-me` with a note; a worker that is still alive finds it no longer running and drops its result. |

An agent can propose follow-up work with `board add --title <t> --file <path> --parent <task> [--priority <p>]`; the file is the new task's prompt. Without `--priority` a proposal takes its parent's priority; it runs where the proposing agent worked, on that machine. A proposal lands in `needs-me` with a **Proposed** badge and runs only after you press **Start**, so a run that a PR's text turned against you cannot queue work by itself. The server holds that line: whatever status an agent names, its `add-task` lands in `needs-me`; the machine API cannot move a proposal out of `needs-me`, `claim-task` loses on one, and `ask` refuses one (answering a question would start it). Only a signed-in user starts it.

Dragging a card moves it the way the matching button would, minus the reply. Into Todo or Done it drops the open question (the question note stays in the thread); into Todo a task with a session keeps its `next`, and a resume with nothing to answer starts a fresh run. Done tasks nobody touched for 14 days are closed, with a note in the thread; they stay readable under Closed. Intake's tasks are left open: intake treats a closed task as "never again", so closing one would block the PR's next review request.

## Two machines

Every worker machine runs its own timers against the same board, under the name `machine` in its config.json (default: the host name).

- A claim is atomic on the server: of two machines claiming a task at once, one wins, and the other moves on to the next task.
- A machine skips a todo task it cannot serve, so the other one can take it: a task scheduled on the other machine (its directory is there), a resume whose session lives on the other machine, or an intake review of a repository it has no checkout of.
- A machine sweeps only its own running tasks: the worker unit lives where the task was claimed. When that machine is off, you can take the task back from the task page once its agent has been quiet for 20 minutes.
- Intake runs on both. The PR URL is the task's dedupe key, so both create the same task once.

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

Every run records what it did. The worker starts `claude -p` with `--output-format stream-json --verbose`, condenses each event (the agent's text, each tool call with its input, each tool result, subagent calls tagged with their Agent call, notes such as the model and directory, and the result with turns, time, cost and refused tool calls), writes a readable line per event to the local log, and sends the events to the board with every 15-second check and once more when the run ends. A batch the board refuses is sent again with the next.

On the board, **Transcript** on a task page (or the terminal icon on a card) opens the runs, newest first, live while one runs. Tool calls are one line each; a click shows the input and loads the output. A tool result over 256 KB is cut with a note; the full one stays in the session file on the machine. Claude Code passes thinking on without its text, so a thinking block shows as a marker with its token estimate.

Transcripts can hold whatever the agent saw: file contents, `gh` output, now and then an environment value. They go 14 days after a task is closed, and 28 days after the last change of an open task in Done, which covers intake's tasks (the server checks hourly). A task of yours untouched in Done is closed after 14 days.

The board loads a run's events in pages of 2000 and afterwards only those after the last one it has, so long runs show in full and a live run costs one small request per poll.

## Where a task runs

A task is bound to a directory on the machine that ran it:

- A fresh run starts in the task's own directory: where it was scheduled from with `board schedule`, or where the proposing agent worked. A task without a directory of its own (an intake review, a task from the New task form) starts in the checkout of the PR its prompt names (`repos`), else in its lane's `cwd`, else in `defaultCwd`. This matters beyond the files: Claude Code loads the checkout's `.claude/settings*.json` only when it starts there, and that is where tokens and endpoints such as `CIRCLECI_TOKEN` or the replica endpoints usually live. The task's `workdir` is set to it.
- The hook records the agent's working directory on every tool call. When a run ends somewhere else, typically in a worktree the agent entered with `/worktree` (`EnterWorktree`), the worker stores that as the task's `workdir`.
- A resume (after an answer, a reply or a pause) starts `claude --resume` in the `workdir`, so the session continues in exactly the worktree it left. The resume is pinned to the same machine, where that directory exists. If the directory is gone, the task goes to `needs-me` with the path instead of running somewhere else.
- **Re-run fresh** forgets the session and the `workdir`; the next run starts in `defaultCwd` (an intake review: in the checkout).

Claude Code itself (2.1.323) also restores a session's worktree when it is resumed from the original directory; the `workdir` makes the board independent of that and shows it on the task page.

## Install a worker machine

Needs Node 24+, pnpm, `flock`, `systemd-run`, `gh` (logged in) and `claude` (logged in).

1. `pnpm install` in the repo. The CLI has no runtime dependencies, but it imports `@agent-board/shared` through the workspace link.
2. On the board's **Settings** page, create a token for this machine. Put it in `~/.config/agent-board/env`, mode 600 (a file with any other mode is refused):

   ```
   AGENT_BOARD_TOKEN=abm_...
   ```

3. Write `~/.config/agent-board/web.json`: `{ "url": "https://board.codeplant.de" }`.
4. Copy `apps/cli/config.example.json` to `~/.config/agent-board/config.json`. Set `machine` to the name you gave the token and `repos` to this machine's checkouts.
5. `apps/cli/install.sh` copies the units into `~/.config/systemd/user`, symlinks `board` into `~/.local/bin`, links `apps/cli/bin/.node` to a Node 24+ binary and reloads systemd. It installs no skill. Run it again after changing a unit file or moving the repo. It enables and starts nothing.
6. Enable when ready:

   ```
   systemctl --user enable --now agent-board-dispatch.timer
   systemctl --user enable --now agent-board-intake.timer
   ```

The units expect the repo at `~/workspace/agent-board`; edit `ExecStart` if it lives elsewhere. `bin/.node` is a real binary, not a mise shim, because a shim does not resolve a version outside a project directory; set `NODE=` to choose one. Run `install.sh` again after a Node upgrade.

User timers only run while you are logged in. For runs after logout: `loginctl enable-linger $USER`.

### Upgrading

The CLI checks the server's contract version once per process and refuses to run when it differs from its own, in either direction, so a contract bump needs the server and every machine's CLI updated together. A machine left on the old CLI fails each dispatch and intake run with a version error until it is updated. So, in this order:

1. Stop the dispatch and intake timers on every worker machine.
2. Deploy or restart the server; migrations run on start.
3. On each machine: pull the repo and run `apps/cli/install.sh`.
4. In an existing `config.json`, narrow `Bash(board *)` in `intake.allowedTools` to the forms in `config.example.json`. The old `backend` key is ignored; remove it if you like.
5. Start the timers again.

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

`web.json` next to it holds the board's `url`; plain `http` is refused except for localhost. The token comes from `env`. The CLI reads them on its first call to the board, so a command that fails on a usage error needs neither.

Logs: `~/.local/state/agent-board/logs/<task>.log`, one per task, emptied when a worker starts. The worker's own fatal errors are appended to it.

## The board server

`apps/backend`: Fastify, tRPC for the UI, Drizzle on Postgres; migrations run on start. `apps/frontend`: React, Mantine and TanStack Query, served by Caddy, which proxies `/trpc` and `/api` to the backend. Images: `agent-board-backend` and `agent-board-web` on GHCR, built by `.github/workflows/ci.yml` on a push to main, only after its typecheck, lint and test job passed (a manual run builds them too), and rolled out by Flux image automation.

Environment of the backend:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres. |
| `PUBLIC_URL` | Where people open the board; task URLs are `<PUBLIC_URL>/t/<id>` (Slack links use them). |
| `ALLOWED_GROUPS` | Authelia groups that may use the UI, comma-separated. Default `admins`. |
| `DEV_AUTH_USER` | Local development only: act as this user without Authelia. The backend refuses to start with it in production. |
| `PORT` | Default 4000. |

Two ways in:

- **The UI** (`/trpc`): Traefik runs Authelia's forward-auth and strips client-sent `Remote-*` headers before it; the backend takes the user from `Remote-User` and requires one of `ALLOWED_GROUPS` in `Remote-Groups`.
- **The machine API** (`POST /api/machine/<subcommand>`): its own Traefik route skips Authelia, matched only for that path with an `Authorization: Bearer` header. The backend looks the token up by its sha256 (tokens are shown once, on the Settings page) and refuses a revoked one. A token claims tasks only under its own machine name.

The cluster side (namespace, Postgres, Deployments, IngressRoutes, Authelia rule, image policies, DNS, nightly `pg_dump` into the restic backup) is `infra/cloud-infra/add-agent-board.patch`, written against codeplant-de/cloud-infra: `git apply` it there, fill in and encrypt `cluster/apps/agent-board/env.sops.yaml` and the new `ghcr-pull` entry, and apply the DNS with tofu. The images come from `codeplant-de/agent-board` on GitHub (`ghcr.io/codeplant-de/agent-board-*`).

## Backend contract

The spec between the CLI and the board, contract version 5. The CLI calls the board's machine API from its own process (`apps/cli/src/backend.mts`); `apps/backend/src/machine-api.ts` serves it. Nothing else implements it.

`POST <url>/api/machine/<command>` with `Authorization: Bearer <machine token>` and a JSON body `{"id"?, "all"?, "machine"?, "author"?, "body"?}`: `id` is the task, `body` is the command's payload (JSON, or the text of a note). The answer is `{"result": ...}` with status 200, or `{"error": "one line"}` with a non-200 status. The token names the machine; it never appears in an error message. A call times out after 45 seconds.

### Rules

- Every command is atomic under concurrent calls: the dispatcher and intake of several machines, workers and people call at the same time.
- A write is visible to the next read.
- The server refuses an unsafe id or machine name with 400 and writes nothing; the CLI refuses it before it sends anything.
- `claim-task` answers 409 when the task is not free for this machine ("lost"). The CLI treats that as an answer and moves on to the next task; every other non-200 answer is a failure.
- The CLI sends `version` once per process, before its first other call, and stops when the server's `contract` differs from its own (5), saying which side is older.
- `input` comes back verbatim, and a note with its text intact. The core parses `agent-board: started <iso>` notes (the start marker) and the first line of a review task's `input` (the PR URL); the PR head is the `head` field.
- A task an agent proposed (`createdBy: agent`) is the user's to start: the server refuses `update-task` with a new status and loses `claim-task` for it, whoever asks.
- The core never writes to a task that is `closed`. A worker that finds its task closed after the run, or running again with another `runStartedAt` than it started with (taken back and run on another machine), drops its result. Any other outcome is judged on the task's `status` after the run: anything but `running` counts as reported (the agent reported, you answered while it was still ending its turn, or the task was taken back). A todo task whose worker unit is still active is not started again until the unit is gone.

### Task

```json
{
  "id": "Ab3dEf9x",
  "title": "#17741 Show postal code (dev)",
  "input": "https://github.com/cosuno/cosuno/pull/17741",
  "labels": ["review-pr"],
  "status": "needs-me",
  "createdBy": "intake",
  "priority": "normal",
  "url": "https://board.codeplant.de/t/Ab3dEf9x",
  "closed": false,
  "machine": "laptop",
  "sessionId": "591d2ec1-d4ab-4e26-ac04-ed303f8fa44a",
  "workdir": "/home/me/workspace/cosuno/cosuno",
  "next": "fresh",
  "head": "56120dc60b",
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

All twenty-two fields are required.

| Field | Meaning |
| --- | --- |
| `id` | Opaque string, stable for the life of the task. It ends up in a systemd unit name, a log file name and argv, so the core refuses any id that does not match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, and the ids `dispatch` and `intake`. |
| `title` | One line, shown in lists and Slack. |
| `input` | What to work on. |
| `labels` | For display: the skill the prompt starts with, unless the creator gave others. |
| `createdBy` | `intake`, `user` or `agent`. Intake's tasks run with intake's narrow permissions and in the PR's checkout. |
| `status` | One of `backlog`, `todo`, `running`, `needs-me`, `done`. |
| `priority` | One of `urgent`, `high`, `normal`, `low`. |
| `url` | Link to the task for a human. It must match `^https?://` and hold no whitespace, `<`, `>` or `|` (it goes into a Slack link). |
| `closed` | `true` for a task out of the workflow. Closed tasks are only listed with `all`; the core never starts, requeues or writes to one. |
| `machine` | The machine that claimed it last, or `null`. A resume runs only there. |
| `sessionId` | The Claude session of the last skill run, or `null`. |
| `workdir` | The directory that session was in when it last stopped, on `machine`, or `null`. A resume starts there (see [Where a task runs](#where-a-task-runs)). |
| `next` | `fresh` or `resume`: what the next run does. |
| `head` | The PR head sha (7 to 40 hex characters) an intake review was made for, or `null`. Intake compares it with the PR's head to see that it moved. |
| `openQuestion` | The agent's last question has no answer yet. |
| `lane` | While running: the lane that runs it, from the last heartbeat; otherwise `null`. |
| `borrowed` | While running: the lane borrowed it; otherwise `false`. |
| `lastActiveAt` | While running: the last heartbeat, ISO 8601; otherwise `null`. |
| `runStartedAt` | While running: when the worker claimed it, ISO 8601; otherwise `null`. |
| `paused` | The last run gave up its slot (`pause`) and the task has not run since. Unlike the board's "Paused" badge, which shows it only in Todo, it stays `true` through the claim, so the worker that resumes the task can tell the agent; the worker's first `update-task` of the run clears it, as does the task leaving Running another way. |
| `notBefore` | Todo only: no machine may claim the task before this time, ISO 8601; otherwise `null`. The server clears it whenever the task leaves Todo, the claim included. |
| `scheduleId` | The schedule the task is an occurrence of, or `null`. Set by the server when a schedule makes the task; no draft or patch can set it. It becomes `null` when the schedule is removed. |

Pickup order is the order of the array that `list-tasks` returns: within a status, the first task is the top. In Todo the store lists resumes (`next: resume`) first, then by `priority`, then by manual order; the lanes pick from that order. Waiting tasks (`notBefore` in the future) come last in Todo, by `notBefore`; once due they sort like any other. The dispatcher does not try to claim a waiting task.

### Schedule

```json
{
  "id": "Sc3dEf9x",
  "title": "Sweep stale branches",
  "input": "/sweep the stale branches",
  "priority": "normal",
  "machine": "laptop",
  "workdir": "/home/me/workspace/cosuno/cosuno",
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

All seventeen fields are required. Exactly one of `everyMs` (an interval in ms, at least one minute, on the grid `anchorAt + k * everyMs`) and `cron` (5 fields, read in the IANA zone `timezone`, which a cron rule needs) is set. `anchorAt` is the first run of an interval, or the time a cron rule matches from. `nextRunAt` is the start time of the pending occurrence (read from its task, so a changed delay shows), `occurrenceTaskId` its task; both are `null` while the schedule is paused with nothing waiting, and once it has ended. `nextRunAt` is also `null` while `occurrenceTaskId` is set when the pending task has no start time any more (it was told to run now): it is due now. `remaining` is the number of occurrences still to be made after the pending one (`null`: forever), `until` the last time an occurrence may start. `machine` and `workdir` pin the occurrences, or are both `null`.

A schedule always has at most one pending occurrence, a task in Todo with `scheduleId` set and `notBefore` at `nextRunAt` (until someone changes it); its `createdBy` is `user`. When that task leaves Todo (a claim, `update-task`, a move, a close), in the same transaction the server makes the next one: the first match of the rule after the previous occurrence's time that is not in the past, so missed runs are skipped. With nothing left (`remaining` used up, or the next match after `until`) the schedule ends (`ended: true`) and makes no more. A task that was an occurrence and returns to Todo later does not trigger another; only the pending one does.

### Note

```json
{ "id": "n1", "text": "…", "createdAt": "2026-11-13T10:00:00Z", "author": "agent", "kind": "comment" }
```

`author` is `agent`, `user` or `system`; `kind` is `comment`, `question`, `answer` or `event`. A question note adds `questions` (the list `ask` took); an answer note adds `questionNoteId` and `answers`, one `{"selected": [labels], "other"?: text}` per question. A resume prompt is built from the `user` notes after the last `agent` note.

### Commands

| Command | Request | `result` |
| --- | --- | --- |
| `version` | - | `{"contract": 5}` |
| `list-tasks` | `all?` | `[Task, ...]` in priority order |
| `get-task` | `id` | `Task` |
| `add-task` | `body`: `{"title", "input"?, "labels"?, "status"?, "priority"?, "dedupeKey"?, "parentId"?, "createdBy"?, "machine"?, "workdir"?, "head"?, "notBefore"?}` | `{"task": Task, "created": bool}` |
| `update-task` | `id`, `body`: `{"status"?, "priority"?, "input"?, "sessionId"?, "workdir"?, "next"?, "head"?, "notBefore"?, "expect"?}` | the updated `Task`, or status 409 |
| `claim-task` | `id`, `machine` | the claimed `Task`, or status 409 |
| `add-note` | `id`, `author?` (`agent` or `system`), `body`: the note text, verbatim | `null` |
| `ask` | `id`, `body`: `{"questions": [...]}` | `null` |
| `heartbeat` | `id`, `body`: `{"lane": string, "borrowed": bool}` | `null` |
| `pause` | `id`, `body`: the note | the updated `Task` |
| `fail` | `id`, `body`: the note | `{"applied": bool, "task": Task}` |
| `transcript` | `id`, `body`: `{"runId", "startedAt", "sessionId", "resumed", "events": [...]}` | `null` |
| `read-notes` | `id` | `[Note, ...]`, oldest first |
| `add-schedule` | `body`: `{"title", "input", "everyMs"? \| "cron"? + "timezone", "priority"?, "machine"?, "workdir"?, "startAt"?, "times"?, "until"?}` | `{"schedule": Schedule, "task": Task}` (the pending occurrence) |
| `list-schedules` | - | `[Schedule, ...]`: running ones first, then paused, then ended |
| `update-schedule` | `id`, `body`: `{"paused": bool}` | the updated `Schedule` |
| `remove-schedule` | `id` | `null` |

- `version`: see the rules above.
- `add-task`: `input` defaults to `""`, `labels` to the skill the prompt starts with, `status` to `todo`, `priority` to the parent's with a `parentId` and to `normal` without, `createdBy` (`intake`, `user`, `agent`) to `user`. `machine` and `workdir` come together and pin the task there. The new task goes to the bottom of its status. With a `dedupeKey` that a task already has, nothing is created: the answer is that task with `created: false`. `createdBy: agent` makes the task a proposal: it lands in `needs-me` whatever `status` the draft names. `head` is 7 to 40 hex characters. `notBefore` (ISO 8601) is accepted only with status `todo` (else 400).
- `update-task`: at least one key; unknown keys are a failure. A status or priority change puts the task at the bottom of its new place. A status change of a proposal is refused with 403. Leaving `needs-me` for `todo` or `done` clears `openQuestion`. `head` is 7 to 40 hex characters, or `null` to clear it. `expect` is a status and not a change: when the task's status differs under the update's lock, nothing is written and the answer is 409 (intake uses it, so a close or requeue planned from an earlier listing cannot hit a task a dispatcher claimed since). It does not count as a key. `notBefore` is an ISO 8601 time, or `null` to clear it; a time is refused with 409 unless the task ends up in `todo`.
- `claim-task`: `todo` to `running` for the machine, at the bottom of running, in one atomic step. Lost when the task is not in `todo` (a `backlog` task is never claimed), or when it is a resume (`next: resume` with a session) pinned to another machine. A token claims for its own machine only. Lost for a proposal. Sets `runStartedAt`; `paused` stays as it is. Lost while `notBefore` is in the future.
- `add-schedule`: exactly one of `everyMs` and `cron`; `cron` needs its `timezone`, and `timezone` goes only with `cron`. `title` and `input` must not be empty. `machine` and `workdir` come together. `startAt` (ISO 8601; default now) is the first run of an interval and the earliest match of a cron rule. `times` (a positive integer, the number of occurrences in all) and `until` (ISO 8601) exclude each other; neither means forever. The answer is 400 for a cron expression the server cannot read (6-field patterns included), an unknown time zone, an interval under a minute, or a rule with no run before `until`, and nothing is written. The schedule and its first card are made in one transaction.
- `update-schedule`: `paused: true` takes the pending occurrence off the board when it never ran (still in Todo, no session, no run) and gives its run back to `remaining`; `paused: false` makes the next occurrence at the first match from now. 409 for an ended schedule. Pausing a paused schedule, or resuming a running one, changes nothing.
- `remove-schedule`: deletes the schedule and a pending occurrence that never ran; tasks that ran stay, with `scheduleId` `null`. 404 for an unknown schedule.
- `add-note`: author `agent` makes a `comment`, `system` an `event`. An empty text is a failure.
- `heartbeat`: sets `lastActiveAt` to now with the lane, on a running task only; on any other it changes nothing.
- `transcript`: appends a run's condensed events (see `packages/shared/src/transcript.mts`; at most 5000 per call, each with an integer `seq` from 0 and a parseable `at`, or the call fails with 400); an event already stored (same run and `seq`) stays as it is, so a retried batch is harmless.
- `pause`: a running task only. Adds the note as a `system` event, then moves the task to Todo with `next: resume` (`fresh` without a session), at the top, and sets `paused`.
- `fail`: in one step, if the task is still `running` and not closed, adds the text as a `system` event and moves the task to `needs-me`, and answers `applied: true`; otherwise it changes nothing and answers `applied: false` with the task as it is.
- `ask`: validates the questions (1 to 4; a header of at most 16 characters; 2 to 4 options with different labels, at most one `recommended`), adds a question note, and moves the task to `needs-me` with `openQuestion: true`. Refused with 403 for a proposal.

## What a worker may do

There is no sandbox. A worker runs `claude` as you, with your home directory, your SSH agent and your `gh` login. How much it may do depends on who made the task:

- **Tasks you made** (`board schedule`, the New task form, and agent proposals once you start them) run as if you ran the prompt in your terminal: all your settings (user, project, local) and `--permission-mode auto`, Claude Code's classifier mode that lets safe actions through and refuses risky ones. Headless, a refusal cannot become a prompt; it shows in the log and usually in the agent's report.
- **Intake's reviews** run unattended on PR text nobody chose to read, so they get less: `--permission-mode dontAsk` with only `intake.allowedTools` allowed and `intake.disallowedTools` denied on top, and `--setting-sources user`, which keeps a checkout's own `.claude/settings*.json` (its allow rules and tokens) out of the run. The shipped list allows reading, `gh` reads, the pr-review scripts, `board comment`, `ask`, `add`, `show` and `move <task> needs-me` (it cannot `board schedule` or start work), CircleCI through the engineering plugin's `cci.sh`, a few Shortcut reads and `bin/replica-psql` (the production and staging read replicas); it cannot push, merge or approve. `intake.env` hands it `CIRCLECI_TOKEN`, `SHORTCUT_API_TOKEN` and the replica endpoints from the checkout's settings, and nothing else from there. A review that a PR's text turns against you can read production data through the replica, and could put it into the pending draft (which you see before submitting) or onto the board.

Every run gets `AGENT_BOARD_TASK=<id>` in its environment, and `board schedule` and the changes of `board schedules` refuse to run while it is set: an agent proposes follow-up work with `board add`, which waits in Needs me until you start it. A config that allows `Bash(board *)` covers `board schedule` and `board move <task> todo`; narrow it to the rules in `config.example.json` (`board comment *`, `board ask *`, `board add *`, `board show *`, `board move * needs-me`), and deny `Bash(board schedule *)` and `Bash(board schedules *)`.

Permission rules match the text of a call: they keep an agent on its task, but they are not a security boundary. A PR or story whose text turns the agent against you reaches whatever the run allows and whatever those commands can reach. A dedicated OS user for the workers, with its own checkouts and a narrowly scoped GitHub token, would make that a boundary again; it is not set up yet.

## How a task runs

A fresh run is

```
claude -p "<prompt>" --session-id <new uuid> --append-system-prompt "<the board's rules>" --settings '<hook>' <permissions>
```

in the task's directory (see [Where a task runs](#where-a-task-runs)). The prompt is the task's `input`, as written. The appended rules tell the agent its task id, to report with `board comment`, to ask with `board ask` instead of AskUserQuestion, to finish with `board move <task> needs-me`, and how to propose follow-ups. The hook is the [heartbeat, pause and question hook](#liveness-and-limits). A resumed run is `claude -p "<your reply>" --resume <session>` with the same flags (see [Ask and resume](#ask-and-resume)).

In intake's rules, `Bash(` rules expand `~/` to your home directory and `{<plugin>}` (such as `{pr-review}` or `{engineering}`) to the root Claude Code gives `<plugin>@ccc` as `${CLAUDE_PLUGIN_ROOT}`, resolved when the worker starts: for a marketplace added as a directory (`~/.claude/plugins/known_marketplaces.json`) that is the plugin's `source` in the marketplace's `.claude-plugin/marketplace.json` (Claude Code loads it from the checkout, not from the cache copy), otherwise the `installPath` in `~/.claude/plugins/installed_plugins.json`. A rule must not start with `*` before a script path: a leading `*` matches any command that merely contains the path. If the plugin path cannot be resolved the task goes to `needs-me` with the reason. `Read(...)` rules are passed on unchanged (they take `~/` themselves). Old `backend`, `labels`, `intakeLabel` and `sandbox` entries in a config are ignored.

A missing allowed tool in an intake review shows up as a failed run: the log says what was denied. Add it to `intake.allowedTools`.

## Commands

```
board tasks                     open tasks per status
board show <task>               the task and its thread as markdown (what a skill reads)
board comment <task> <text>     add a note; `-` reads the text from stdin
board comment <task> --file <p> add a note from a file in /tmp (what the reviewer uses)
board schedule [--priority p] [--title t] [--hold | --backlog] [--in <dur> | --at <time>] [--new] <prompt...>
                                a task from a prompt, run here on this machine; checks for duplicates first; refused inside a run
board schedule --every <dur> | --cron "<expr>" [--times <n> | --until <time>] ... <prompt...>
                                repeat the prompt (the flags above still apply; --in/--at is the first run)
board schedules                 list the repeating schedules
board schedules pause|resume|rm <id>
                                pause, resume or delete a schedule; refused inside a run
board delay <task> (--in <dur> | --at <time> | --now)
                                delay a task in Todo until then; --now makes it due at once
board ask <task> --file <p>     ask the user 1-4 questions (JSON in /tmp); moves the task to needs-me and notifies Slack
board add --title <t> --file <p> [--parent <task>] [--priority <p>]
                                propose a follow-up task; it waits in needs-me until the user starts it
board move <task> <status>      move to the bottom of a status
board notify <task> <text>      Slack message with the task link
dispatch                        one dispatcher tick
intake                          review requests to tasks
```

`<status>` is `backlog`, `todo`, `running`, `needs-me` or `done`; "Backlog", "Todo", "Running", "Needs me" and "Done" work too. `dispatch`, `intake` and `board` take `--dry-run`: reads happen, every write and process start is printed as `DRY ...`. An unknown argument is a usage error. The question file of `board ask` is `{"questions": [{"header", "question", "multiSelect", "options": [{"label", "description", "recommended"?}]}]}`; like `--file` of `board comment`, it is read only from a regular file in `/tmp`, without following a link.

`apps/cli/bin/dispatch` and `apps/cli/bin/intake` take their own lock (`$XDG_RUNTIME_DIR/agent-board-{dispatch,intake}.lock`), so a run by hand cannot overlap a timer run. When the lock is held they exit 75 without output.

## How it decides

Dispatcher, per tick:

1. For each task in `running` claimed by this machine, ask `systemctl --user is-active agent-board-<task>`. A task whose unit is gone moves to `needs-me` with the log tail, timed from the unit's own start (else the task's `runStartedAt`). So does one whose worker failed to enforce the [limits](#liveness-and-limits) for five minutes past them; its unit is stopped. If `systemctl` gives no known state, or the backend fails, the tick stops before starting anything and exits non-zero.
2. A task this machine cannot serve is skipped (see [Two machines](#two-machines)). The rest are planned into [lanes](#lanes): own work first, then borrowing. Each start is claimed, its lane written to the run directory, then `systemd-run --user --collect --unit agent-board-<task>` starts the worker and a start note names the machine, lane and PID. A lost claim hands its slot to the next task; the first failed start ends the tick's starting.
3. Lanes whose own work still waits ask one borrowed run each to pause.

Worker, per task: a task with `next: resume`, a session, and a user reply or a pause since the agent last spoke resumes that session with the reply (and "you were paused") as the prompt. Anything else starts a new session, whose id is stored on the task once the run is about to start (and cleared again if the process cannot be spawned). A fresh run's prompt is the task's prompt; when the thread already holds notes by you or the agent, it is followed by what you wrote since the previous run started and a line telling the agent to read the thread with `board show <task>`. Either way `next` goes back to `fresh`.

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

To point a worker at the local board: a token from http://localhost:5173/settings, `web.json` with `"url": "http://localhost:4000"`, and `AGENT_BOARD_CONFIG_DIR` / `AGENT_BOARD_STATE_DIR` at scratch directories so the real config and logs stay untouched.

CLI decision logic is in `apps/cli/src/decide.mts`, `planIntake` and the `run*` functions, which take a backend, GitHub and system interface as arguments; tests inject fakes (`apps/cli/test/helpers.mts`). Backend tests are integration tests against `board_test` (reset on every run), through `app.inject` for the machine API and tRPC callers for the UI. Three test skills in `apps/cli/test/skills` run real headless checks; link one into `~/.claude/skills` and schedule it with `board schedule /<name>`. `board-selftest-ask` asks one question through AskUserQuestion and reports the answer after you answer on the board. `board-selftest-slow` works through eight 15-second steps: with two lanes of one slot each (one owning it), schedule two so one lane borrows, then schedule own work for that lane, and the next tick after `pauseAfterMinutes` pauses the borrowed run, which later resumes in its session. `board-selftest-worktree` enters a worktree first, so a pause and resume show that the session continues in it.
