# agent-board

A board for headless Claude Code runs. Each task is a conversation: the agent posts its findings as markdown, asks you questions with options to pick, and picks up where it left off when you answer. Phase 1 is PR review; any skill can be a task type.

Three parts, one repo (pnpm workspace):

| Part | Where it runs | What it does |
| --- | --- | --- |
| `apps/backend` and `apps/frontend` | board.codeplant.de (k3s, behind Authelia) | The board: tasks, threads, questions, the buttons. Postgres is the only state. |
| `apps/cli` | each worker machine (laptop, workstation) | systemd timers: `dispatch` claims tasks and starts `claude -p` workers, `intake` turns review requests into tasks. `board` is the command the agent uses to report. |
| `packages/shared` | both | The backend contract and the question schema. No dependencies; the CLI runs it from source. |

The CLI talks to the board through one configured executable, `apps/cli/bin/web-backend`, which implements the [backend contract](#backend-contract) over HTTPS with a machine token.

## Tasks

Four statuses: `todo`, `running`, `needs-me`, `done`. Order within `todo` is priority. A task's label picks the worker. For a PR review, the first line of `input` is the PR URL and intake adds a `head: <sha>` line; any other task's input is free markdown.

A run ends in `needs-me`: with a report, with a question, or, when it fails, times out or its worker disappears, with the reason and the end of the log. Nothing moves on until you press a button.

## Ask and resume

The agent asks with `board ask <task> --file /tmp/<file>.json`: one to four questions, each with two to four options, one of them marked recommended, single or multiple choice (the shape of Claude Code's AskUserQuestion). The task moves to `needs-me` with a **Question** badge, and Slack gets a message.

On the task page you pick options (number keys work), add text where none fits, and press **Answer & continue**. On a task without a question, write a reply and press **Send & continue**. Both put the task at the top of Todo with `next: resume`. The next dispatch tick on the machine that ran the session starts `claude -p "<your reply>" --resume <session>`, so the agent keeps its context. The other buttons:

| Button | Effect |
| --- | --- |
| Mark done | Done. |
| Re-run fresh | Back to Todo with a new session; the agent sees the thread, not the old context. |
| Comment without continuing | A note in the thread, nothing runs. Works while a task runs too. |
| Close / Reopen | Out of the workflow; workers ignore it, intake never makes a second task for its PR. |
| Start / Discard | On a task an agent proposed. |

An agent can propose follow-up work with `board add --label <l> --title <t> --file <path> --parent <task>`. A proposal lands in `needs-me` with a **Proposed** badge and runs only after you press **Start**, so a run that a PR's text turned against you cannot queue work by itself.

## Two machines

Every worker machine runs its own timers against the same board, under the name `machine` in its config.json (default: the host name).

- A claim is atomic on the server: of two machines claiming a task at once, one wins, and the other moves on to the next task.
- A machine skips a todo task it cannot serve, so the other one can take it: a label it has no worker for, a PR in a repository it has no checkout of, or a resume whose session lives on the other machine. Only a task without any label goes to `needs-me`.
- A machine sweeps only its own running tasks: the worker unit lives where the task was claimed.
- Intake runs on both. The PR URL is the task's dedupe key, so both create the same task once.

Tasks only move while a machine with the right setup is on.

## Install a worker machine

Needs Node 24+, pnpm, `flock`, `systemd-run`, `gh`, `claude`, and for the reviewer's sandbox `bubblewrap` and `socat` (`sudo apt install bubblewrap socat`). Without the last two a skill run does not start: Claude Code stops with "sandbox required but unavailable" (see [Reviewer isolation](#reviewer-isolation)). On Ubuntu 24.04 and later, AppArmor may also block unprivileged user namespaces for `bwrap`; Claude Code's sandboxing page describes the fix.

1. `pnpm install` in the repo. The CLI has no runtime dependencies, but it imports `@agent-board/shared` through the workspace link.
2. On the board's **Settings** page, create a token for this machine. Put it in `~/.config/agent-board/env`, mode 600 (a file with any other mode is refused):

   ```
   AGENT_BOARD_TOKEN=abm_...
   ```

3. Write `~/.config/agent-board/web.json`: `{ "url": "https://board.codeplant.de" }`.
4. Copy `apps/cli/config.example.json` to `~/.config/agent-board/config.json`. Set `machine` to the name you gave the token and `repos` to this machine's checkouts.
5. `apps/cli/install.sh` copies the units into `~/.config/systemd/user` and symlinks `board` into `~/.local/bin` and the skill into `~/.claude/skills`. Run it again after changing a unit file or moving the repo. It enables and starts nothing.
6. `board setup` creates this config's labels on the board.
7. Enable when ready:

   ```
   systemctl --user enable --now agent-board-dispatch.timer
   systemctl --user enable --now agent-board-intake.timer
   ```

The units expect the repo at `~/workspace/agent-board`; edit `ExecStart` if it lives elsewhere. `install.sh` links `apps/cli/bin/.node` to a real Node 24+ binary (set `NODE=` to choose one), because a mise shim does not resolve a version outside a project directory. Run it again after a Node upgrade.

User timers only run while you are logged in. For runs after logout: `loginctl enable-linger $USER`.

## Config

`~/.config/agent-board/config.json` (`AGENT_BOARD_CONFIG_DIR` changes the directory):

| Key | Meaning |
| --- | --- |
| `backend.command` | The backend: an executable and fixed arguments, run without a shell. `~/` is expanded in every element. Normally `~/workspace/agent-board/apps/cli/bin/web-backend`. |
| `machine` | This machine's name on the board. Default: the host name up to the first dot. Must match the name of its token. |
| `maxParallel` | Tasks this machine runs at once. Default 2. |
| `timeoutMinutes` | A worker is stopped after this long. Default 45. |
| `slackWebhookFile` | One-line file with the Slack incoming webhook URL, mode 600. |
| `intakeLabel` | Label intake puts on new tasks. Default `review-pr`. |
| `repos` | `owner/name` to local checkout. Intake ignores a PR in another repo, and dispatch leaves its task to a machine that has the checkout. |
| `labels` | Label name to worker, below. |

`web.json` next to it holds the board's `url`; plain `http` is refused except for localhost. The token comes from `env`. Only `web-backend` reads either file.

Logs: `~/.local/state/agent-board/logs/<task>.log`, one per task, emptied when a worker starts. The worker's own fatal errors are appended to it.

## The board server

`apps/backend`: Fastify, tRPC for the UI, Drizzle on Postgres; migrations run on start. `apps/frontend`: React, Mantine and TanStack Query, served by Caddy, which proxies `/trpc` and `/api` to the backend. Images: `agent-board-backend` and `agent-board-web` on GHCR, built by `.github/workflows/deploy.yml` on every push to main and rolled out by Flux image automation.

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

The cluster side (namespace, Postgres, Deployments, IngressRoutes, Authelia rule, image policies, DNS, nightly `pg_dump` into the restic backup) is `infra/cloud-infra/add-agent-board.patch`, written against codeplant-de/cloud-infra: `git apply` it there, fill in and encrypt `cluster/apps/agent-board/env.sops.yaml` and the new `ghcr-pull` entry, and apply the DNS with tofu. The image names assume the repo lives under `jascha-schiffer` on GitHub; change them in the patch if not.

## Backend contract

This is the spec between the CLI and the store, version 2. `web-backend` is the one implementation; `apps/cli/test/fixtures/fake-backend.mts` is a small second one that keeps tasks in a JSON file, for the tests. The core runs `<backend.command...> <subcommand> [args]` with an argument list (no shell), a timeout of 60 seconds per call, and kills the backend's process group when it is exceeded (also when its output passes 16 MiB).

### Rules

- Free text (a note, a task input, questions) travels on stdin, never in argv. Ids, flags and subcommands are the only arguments.
- Exit 0 means success. Where a command says it prints JSON, stdout is exactly one JSON value; anything else on stdout is a failure. Diagnostics go to stderr.
- A non-zero exit is a failure. Print a one-line reason on stderr, first. The core keeps the first 4000 characters of stderr and shows the first 200 of them as one line, so the reason is the first line, and never put secrets in it.
- Exit 64 means "I do not implement this subcommand". Only `setup` may be missing.
- Exit 75 from `claim-task` means "lost": the task is not free for this machine. The core moves on to the next task.
- Every subcommand is atomic under concurrent calls: the dispatcher and intake of several machines, workers and people call at the same time.
- A write is visible to the next read.
- A backend refuses an id outside its scope, with a non-zero exit and without writing.
- The backend loads its own credentials. The core never reads them and passes none on.
- `input` comes back verbatim, and a note with its text intact. The core parses `agent-board: started <iso>` notes (the start marker) and the `input` of a review task (first line PR URL, then `head: <sha>`).
- The core never writes to a task that is `closed`. A worker that finds its task closed after the run drops its result. Any other outcome is judged on the task's `status` after the run: `needs-me` or `done` counts as reported.

### Task

```json
{
  "id": "Ab3dEf9x",
  "title": "#17741 Show postal code (dev)",
  "input": "https://github.com/cosuno/cosuno/pull/17741\nhead: 56120dc60b",
  "labels": ["review-pr"],
  "status": "needs-me",
  "url": "https://board.codeplant.de/t/Ab3dEf9x",
  "closed": false,
  "machine": "laptop",
  "sessionId": "591d2ec1-d4ab-4e26-ac04-ed303f8fa44a",
  "next": "fresh",
  "openQuestion": true
}
```

All eleven fields are required.

| Field | Meaning |
| --- | --- |
| `id` | Opaque string, stable for the life of the task. It ends up in a systemd unit name, a log file name and argv, so the core refuses any id that does not match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, and the ids `dispatch` and `intake`. |
| `title` | One line, shown in lists and Slack. |
| `input` | What to work on. |
| `labels` | Label names. The first one with a configured worker picks it. |
| `status` | One of `todo`, `running`, `needs-me`, `done`. |
| `url` | Link to the task for a human. It must match `^https?://` and hold no whitespace, `<`, `>` or `|` (it goes into a Slack link). |
| `closed` | `true` for a task out of the workflow. Closed tasks are only listed with `--all`; the core never starts, requeues or writes to one. |
| `machine` | The machine that claimed it last, or `null`. A resume runs only there. |
| `sessionId` | The Claude session of the last skill run, or `null`. |
| `next` | `fresh` or `resume`: what the next run does. |
| `openQuestion` | The agent's last question has no answer yet. |

Priority is the order of the array that `list-tasks` returns: within a status, the first task is the top.

### Note

```json
{ "id": "n1", "text": "…", "createdAt": "2026-11-13T10:00:00Z", "author": "agent", "kind": "comment" }
```

`author` is `agent`, `user` or `system`; `kind` is `comment`, `question`, `answer` or `event`. A question note adds `questions` (the list `ask` took); an answer note adds `questionNoteId` and `answers`, one `{"selected": [labels], "other"?: text}` per question. A resume prompt is built from the `user` notes after the last `agent` note.

### Subcommands

| Call | Stdin | Stdout |
| --- | --- | --- |
| `version` | - | `{"contract": 2}` |
| `list-tasks [--all]` | - | `[Task, ...]` in priority order |
| `get-task <id>` | - | `Task` |
| `add-task` | `{"title", "input"?, "labels"?, "status"?, "dedupeKey"?, "parentId"?, "createdBy"?}` | `{"task": Task, "created": bool}` |
| `update-task <id>` | `{"status"?, "input"?, "sessionId"?, "next"?}` | the updated `Task` |
| `claim-task <id> --machine <name>` | - | the claimed `Task`, or exit 75 |
| `add-note <id> [--author agent\|system]` | the note text, verbatim | nothing |
| `ask <id>` | `{"questions": [...]}` | nothing |
| `read-notes <id>` | - | `[Note, ...]`, oldest first |
| `setup [--dry-run]` | `{"labels": [...]}` | `{"created": [...]}` |

- `version`: the core calls it once per process, before its first real call, and refuses to go on when `contract` is not 2.
- `add-task`: `input` defaults to `""`, `labels` to `[]`, `status` to `todo`, `createdBy` (`intake`, `user`, `agent`) to `user`. The new task goes to the bottom of its status. A label the store does not know is a failure. With a `dedupeKey` that a task already has, nothing is created: the answer is that task with `created: false`. `createdBy: agent` marks the task as a proposal.
- `update-task`: at least one key; unknown keys are a failure. A status change puts the task at the bottom of the new status.
- `claim-task`: `todo` to `running` for the machine, at the bottom of running, in one atomic step. Lost when the task is not in `todo`, or when it is a resume (`next: resume` with a session) pinned to another machine.
- `add-note`: author `agent` makes a `comment`, `system` an `event`. An empty text is a failure.
- `ask`: validates the questions (1 to 4; a header of at most 16 characters; 2 to 4 options with different labels, at most one `recommended`), adds a question note, and moves the task to `needs-me` with `openQuestion: true`.
- `setup`: creates one label per name. Idempotent; with `--dry-run` it only names what it would create.

A backend can also be tested without the core: `echo '{"next":"fresh"}' | apps/cli/bin/web-backend update-task <id>`.

## Reviewer isolation

The review worker runs `claude -p` with headless permissions. Two layers hold it, and only the second one is a boundary:

1. **Permissions** (`allowedTools`, `disallowedTools`, `--permission-mode dontAsk`): a list of tool calls Claude Code approves. `Read(~/.config/**)` and the other `Read(...)` deny rules apply to the Read, Grep and Glob tools only. A `Bash(git diff *)` allow rule is a text match on the command line, and Claude Code adds a check of the path arguments of the commands it knows are read-only (`cat`, `git diff`, ...). In Claude Code 2.1.322 that check refused every variant of `git diff /dev/null <file outside the checkout>` I tried (absolute, `~`, `$HOME`, relative with `..`, glob, `--no-index`), so the leak a reviewer reported for git 2.43 does not reproduce here. But the check is a heuristic about command names, and any allowed command that opens a path by itself (a script that takes a file argument, for one) is not covered by it. Rules are a convenience, not a boundary.
2. **The Bash sandbox** ([Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing), settings reference `sandbox`): bubblewrap on Linux. It confines every Bash command, and every process the command starts, at the OS level. The worker derives it from the label's `sandbox` entry and the checkout and passes it with `--settings <json>`. The settings hold no secret.

What a sandboxed command can do:

| | |
| --- | --- |
| Read | The checkout, the entries of `allowRead` (the pr-review plugin and `~/.local/state/pr-review`), and everything outside the home directory (`/usr`, `/etc`, `/tmp`, ...). The home directory is denied (`denyRead: ["~/"]`): `~/.config`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.kube`, `~/.docker`, `~/.claude` and the rest are not there for it. |
| Write | The checkout's `.git`, `/tmp` and the entries of `allowWrite` (`~/.local/state/pr-review`, where `review-notes.sh` keeps its notes). Everything already in the checkout but `.git` is read-only; `.git/hooks` and `.git/config` stay protected by the sandbox itself. The sandbox cannot make the checkout read-only as a whole, so a command can still create a new top-level file in it. |
| Network | Only `api.github.com`, through Claude Code's proxy (`allowedDomains`). No other host, no `ssh`. |
| Leave the sandbox | No. `allowUnsandboxedCommands` is false, `failIfUnavailable` is true (no `bubblewrap` or `socat`: the run does not start), and `autoAllowBashIfSandboxed` is false. The last one matters: by default a sandboxed Bash command is approved without looking at `allowedTools`, which would turn the allow list off. |

Most of the allowed commands need no credentials the sandbox hides, or get them in a way that leaves the secret out of reach:

- **`gh` and the pr-review scripts** need the GitHub token. The worker runs the `maskedEnv` command (`gh auth token`) and puts the result in `GH_TOKEN` in the environment of `claude`. The sandbox masks it: a sandboxed command sees a placeholder (`fake_value_<uuid>`), and the proxy swaps in the real token on requests to `api.github.com` only (it terminates TLS for this). `~/.config/gh/hosts.yml` is not readable at all.
- **`board` and `git fetch origin`** run outside the sandbox (`excludedCommands`): the first has to read `~/.config/agent-board/env` in its backend, the second authenticates over `ssh` with your agent. Claude Code runs a command outside the sandbox when every command of the call matches an entry, as text. A call with a pipe, a redirect or a heredoc into `board`, or a `$(...)`, does not match and stays sandboxed, where `board` cannot find its config: a long note goes in as `board comment <task> --file /tmp/pr-<task>-findings.md`, which reads a regular file in `/tmp` (opened without following a link, checked to really live in `/tmp`). Two things are not matched by `Bash(board *)`: an environment prefix such as `AGENT_BOARD_CONFIG_DIR=/tmp/x board tasks` and `PATH=/tmp/x:$PATH board tasks`; both were denied in a headless run (Claude Code 2.1.322), so a reviewer cannot point the unsandboxed `board` at a config it wrote itself.

Setup, once: `sudo apt install bubblewrap socat`.

### What a prompt-injected reviewer can still do

Say a PR's text turns the reviewer against you. With the sandbox it cannot read your files through Bash, and it cannot reach the network except through the channels below. It can still:

1. Use the **Read, Grep and Glob tools**, which are not sandboxed, on any file the deny rules do not name. They name `~/.config`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.claude/.credentials.json`, `~/.local/share/keyrings` and `**/.env*`. A secret kept anywhere else under your home directory is readable by that route, and the content then leaves through the channels below.
2. **Write to GitHub** through the pr-review scripts, which are allowed to create and change your pending draft review (visible to you before anything is submitted), and read what your token can read through `gh pr view`, `gh pr diff`, `gh pr checks` and `gh search`, on any repository, not only the PR's.
3. **Write to the board and to Slack** through `board comment`, `board move`, `board ask` and `board notify`, on any task id, as text, and propose tasks with `board add`. A proposal never runs until you start it, and an answer to a question it planted only reaches the agent when you press a button.
4. **Fetch from `origin`** over `ssh` with every key in your agent, to any ref `git fetch origin` accepts (any argument with a `:` and any `--up*` option are denied; the deny rules are `Bash(git fetch *:**)` and `Bash(git fetch *--up*)`, written that way because Claude Code reads a rule that ends in `:*` as a literal prefix, so `Bash(git fetch *:*)` denies nothing. Checked in a scratch repo with headless runs: `git fetch origin <sha>` runs; refspecs, `--upload-pack`, its abbreviation `--upl`, another remote and a refspec after `&&` are refused).
5. Put text in its own answer, which Claude Code sends to Anthropic as usual.
6. Create new top-level files in the checkout and anything in `/tmp`.

The real GitHub token is in the environment of the `claude` process, which starts the commands outside the sandbox (`board`, `git fetch`) and any MCP server. The `Read` tool refuses `/proc` and a deny rule says so as well. A command that is allowed and prints its environment would leak it; none is on the list, and a new one must not be added.

Not covered: macOS (masked credential files and `ssh` through the sandbox behave differently there; the settings are not tried on it), and any host the worker's label adds to `allowedDomains`.

## Adding a label-to-worker mapping

Add the entry to `labels` in each machine's config.json that should run it, then run `board setup` there: it creates the label on the board. Two shapes:

```json
"review-pr": {
  "skill": "board-review-pr",
  "cwd": "pr-repo",
  "allowedTools": ["Read", "Bash(board *)"],
  "disallowedTools": ["Bash(git push *)"],
  "sandbox": {
    "allowRead": ["{pr-review}"],
    "allowWrite": [],
    "allowedDomains": ["api.github.com"],
    "excludedCommands": ["board *"],
    "maskedEnv": [{ "name": "GH_TOKEN", "command": ["gh", "auth", "token"], "injectHosts": ["api.github.com"] }]
  }
}
```

A fresh run is `claude -p "/<skill> <task> <PR URL>" --session-id <new uuid> --permission-mode dontAsk --setting-sources user --settings <sandbox json>` with these allow and deny rules and the sandbox described under [Reviewer isolation](#reviewer-isolation). A label whose `cwd` is not `pr-repo` gets `/<skill> <task>` and reads its task with `board show`. A resumed run is `claude -p "<the user's reply>" --resume <session>` with the same flags (see [Ask and resume](#ask-and-resume)). `dontAsk` denies everything not allowed, without prompting. `--setting-sources user` keeps the checkout's `.claude/settings*.json` (their allow rules and env tokens) out of the run; only `~/.claude/settings.json` loads. If you ever add `permissions.allow` rules there, they widen the reviewer's sandbox too. Rules starting with `Bash(` expand `~/` to your home directory and `{pr-review}` to the root Claude Code gives the `pr-review@ccc` plugin as `${CLAUDE_PLUGIN_ROOT}`, resolved when the worker starts: for a marketplace added as a directory (`~/.claude/plugins/known_marketplaces.json`) that is the plugin's `source` in the marketplace's `.claude-plugin/marketplace.json` (Claude Code loads it from the checkout, not from the cache copy), otherwise the `installPath` in `~/.claude/plugins/installed_plugins.json`. A rule must not start with `*` before a script path: a leading `*` matches any command that merely contains the path. If the plugin path cannot be resolved the task goes to `needs-me` with the reason. `Read(...)` rules are passed on unchanged (they take `~/` themselves).

`sandbox` is required for a skill label: the worker sends a task whose label has none to `needs-me` and starts nothing. Its keys, all lists except `maskedEnv`:

| Key | Meaning |
| --- | --- |
| `allowRead` | Paths the sandboxed commands may read in the home directory, besides the checkout. `~/` and `{pr-review}` are expanded. |
| `allowWrite` | Paths they may write, besides the checkout's `.git` and `/tmp`. |
| `allowedDomains` | Hosts they may reach through the proxy. |
| `excludedCommands` | Commands (Bash rule syntax, matched as text) that run outside the sandbox. Each one must also be in `allowedTools`. Never put a script, a shell or any command that takes a file or a command as its argument here. |
| `maskedEnv` | Per entry: `name`, `command` (run by the worker without a shell; its stdout is the value) and `injectHosts` (the only hosts the real value is sent to). The value goes into the environment of `claude`, where the sandbox masks it. A failing command sends the task to `needs-me` without its output. |

The worker adds the rest: the home directory is denied, the checkout is readable, its `.git` and `/tmp` are writable, and its other entries are read-only.

`cwd` is `pr-repo` (the checkout `repos` maps the PR's repository to) or a directory. The skill must exist in `~/.claude/skills`, and it should end by moving the task to `needs-me` or by asking with `board ask`.

```json
"selftest": { "command": ["sleep", "300"] }
```

Runs a plain command (optional `cwd`). Use it to test the cap and the sweep without spending tokens. An exit code other than 0 is a failure; exit 0 with the task in any status but `needs-me` or `done` is reported as "finished without reporting". A task that is closed after the run is left alone, whatever the outcome (see the contract). A command label runs without a sandbox.

Known gaps of the headless review: it loads no project settings, so the Shortcut MCP token from the project settings is missing and `mcp__shortcut__get_story` may fail (the skill treats the story lookup as best effort). The review is not mirrored into the brain journal; do that by hand if you want it.

A missing allowed tool shows up as a failed run: the log says what was denied. Add it to `allowedTools`.


## Commands

```
board tasks                     open tasks per status
board show <task>               the task and its thread as markdown (what a skill reads)
board comment <task> <text>     add a note; `-` reads the text from stdin
board comment <task> --file <p> add a note from a file in /tmp (what the reviewer uses)
board ask <task> --file <p>     ask the user 1-4 questions (JSON in /tmp); moves the task to needs-me and notifies Slack
board add --label <l> --title <t> --file <p> [--parent <task>]
                                propose a follow-up task; it waits in needs-me until the user starts it
board move <task> <status>      move to the bottom of a status
board notify <task> <text>      Slack message with the task link
board setup                     create this config's labels on the board; with --dry-run, list what it would create
dispatch                        one dispatcher tick
intake                          review requests to tasks
```

`<status>` is `todo`, `running`, `needs-me` or `done`; "Todo", "Running", "Needs me" and "Done" work too. `dispatch`, `intake` and `board` take `--dry-run`: reads happen, every write and process start is printed as `DRY ...`. An unknown argument is a usage error. The question file of `board ask` is `{"questions": [{"header", "question", "multiSelect", "options": [{"label", "description", "recommended"?}]}]}`; like `--file` of `board comment`, it is read only from a regular file in `/tmp`, without following a link.

`apps/cli/bin/dispatch` and `apps/cli/bin/intake` take their own lock (`$XDG_RUNTIME_DIR/agent-board-{dispatch,intake}.lock`), so a run by hand cannot overlap a timer run. When the lock is held they exit 75 without output.

## How it decides

Dispatcher, per tick:

1. For each task in `running` claimed by this machine, ask `systemctl --user is-active agent-board-<task>`. A task whose unit is gone, or whose unit started more than the timeout plus five minutes ago (the start note is the fallback), moves to `needs-me` with the log tail. If `systemctl` gives no known state, or the backend fails, the tick stops before starting anything and exits non-zero.
2. While fewer than `maxParallel` run here, walk Todo from the top. A task without a label goes to `needs-me`. A task this machine cannot serve is skipped (see [Two machines](#two-machines)). Otherwise claim it; a lost claim is skipped. Then start `systemd-run --user --collect --unit agent-board-<task>` and add a start note with the machine and PID. The first failed start ends the tick's starting.

Worker, per task: a skill label with `next: resume`, a session and a user reply since the agent last spoke resumes that session with the reply as the prompt. Anything else starts a new session, whose id is stored on the task before the run. Either way `next` goes back to `fresh`.

Intake, per run: search each repo in `repos` for open, non-draft PRs that request your review, then create one task per PR URL (the dedupe key), checked against every task, closed ones included. A PR that `gh pr view` cannot read is logged and skipped. A PR whose head moved and whose last commit is at least ten minutes old sends its task from `needs-me` or `done` back to `todo` with `next: fresh`. A failed task stays in `needs-me` until the head moves. A failed GitHub search or backend listing changes nothing and exits non-zero.

## Development

```
docker compose up -d postgres        local Postgres on :54331 (board_dev, board_test)
cp apps/backend/.env.example apps/backend/.env
pnpm dev:backend                     :4000, as DEV_AUTH_USER
pnpm dev:frontend                    :5173, proxies /trpc and /api
pnpm typecheck && pnpm test
pnpm db:generate --name <change>     after editing apps/backend/src/db/schema.ts
```

To point a worker at the local board: a token from http://localhost:5173/settings, `web.json` with `"url": "http://localhost:4000"`, and `AGENT_BOARD_CONFIG_DIR` / `AGENT_BOARD_STATE_DIR` at scratch directories so the real config and logs stay untouched.

CLI decision logic is in `apps/cli/src/decide.mts`, `planIntake` and the `run*` functions, which take a backend, GitHub and system interface as arguments; tests inject fakes (`apps/cli/test/helpers.mts`). Backend tests are integration tests against `board_test` (reset on every run), through `app.inject` for the machine API and tRPC callers for the UI. `apps/cli/test/skills/board-selftest-ask` is a skill that asks one question and reports the answer after the resume: link it into `~/.claude/skills`, give it a skill label with `"cwd": "/tmp"`, `Edit(//tmp/pr-selftest-*)` and `Bash(board *)`, and run a task through a real ask and resume.
