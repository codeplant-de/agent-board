# agent-board

A task backend is the queue. A systemd user timer runs a dispatcher every two minutes. The dispatcher takes tasks from the top of Todo and starts a headless `claude -p` worker for each, with a cap on parallel runs. The worker reports on the task. Phase 1 is PR review.

The backend is the only state. There is no database and no state file: the task's status says where it is, and the worker unit says when it started. The core talks to the backend through one configured CLI (see [Backend contract](#backend-contract)). This repo ships a Trello backend, `bin/trello-backend`; another one is any executable that implements the contract.

## Tasks

Four statuses: `todo`, `running`, `needs-me`, `done`. Order within `todo` is priority. A task's label picks the worker. The first line of its `input` is the PR URL; intake adds a `head: <sha>` line.

A finished task moves itself to `needs-me`. A task that fails, times out, has no known label, or whose worker disappears also ends in `needs-me`, with the reason and the end of the log as a note.

## Install

Needs Node 24+, `flock`, `systemd-run`, `gh`, `claude`, and for the reviewer's sandbox `bubblewrap` and `socat` (`sudo apt install bubblewrap socat`). No runtime dependencies; `npm install` only adds TypeScript for the type check. Without `bubblewrap` and `socat` a skill run does not start: Claude Code stops with "sandbox required but unavailable" (see [Reviewer isolation](#reviewer-isolation)). On Ubuntu 24.04 and later, AppArmor may also block unprivileged user namespaces for `bwrap`; Claude Code's sandboxing page describes the fix.

1. Set up a backend. For Trello (the one shipped here):
   1. Create a Trello board and note its ID or short link (the part after `/b/` in the URL).
   2. Create an API key and token at https://trello.com/power-ups/admin and put them in `~/.config/agent-board/env`, mode 600:

      ```
      TRELLO_API_KEY=...
      TRELLO_TOKEN=...
      ```

      The key and token are sent in the `Authorization` header and are never put in a URL or printed. A file with any other mode is refused. Only the Trello backend reads this file.
   3. Write `~/.config/agent-board/trello.json` with the board: `{ "boardId": "<id or short link>" }`.
2. Copy `config.example.json` to `~/.config/agent-board/config.json` and check `backend.command`.
3. `./install.sh` copies the units into `~/.config/systemd/user` and symlinks `bin/board` into `~/.local/bin` and the skill into `~/.claude/skills`. Run it again after changing a unit file. It enables and starts nothing.
4. `board setup` asks the backend to create what it needs. For Trello: the four lists and one label per entry in `labels`.
5. Enable when ready:

   ```
   systemctl --user enable --now agent-board-dispatch.timer
   systemctl --user enable --now agent-board-intake.timer
   ```

The units expect the repo at `~/workspace/agent-board`; edit `ExecStart` if it lives elsewhere. `install.sh` links `bin/.node` to a real Node 24+ binary (set `NODE=` to choose one), because a mise shim does not resolve a version outside a project directory. Run it again after a Node upgrade.

User timers only run while you are logged in. For runs after logout: `loginctl enable-linger $USER`.

## Config

`~/.config/agent-board/config.json` (`AGENT_BOARD_CONFIG_DIR` changes the directory):

| Key | Meaning |
| --- | --- |
| `backend.command` | The backend: an executable and fixed arguments, run without a shell. `~/` is expanded in every element. |
| `maxParallel` | Tasks in `running` at once. Default 2. |
| `timeoutMinutes` | A worker is stopped after this long. Default 45. |
| `slackWebhookFile` | One-line file with the Slack incoming webhook URL, mode 600. |
| `intakeLabel` | Label intake puts on new tasks. Default `review-pr`. |
| `repos` | `owner/name` to local checkout. A PR in another repo is ignored by intake and sent to `needs-me` by the worker. |
| `labels` | Label name to worker, below. |

Logs: `~/.local/state/agent-board/logs/<task>.log`, one per task, emptied when a worker starts. The worker's own fatal errors are appended to it.

The core config holds nothing about a particular backend. The Trello backend reads its own `trello.json` next to `config.json`:

| Key | Meaning |
| --- | --- |
| `boardId` | Trello board ID or short link. |
| `lists` | Optional. Status to list name; the defaults are `todo` to "Todo", `running` to "Running", `needs-me` to "Needs me", `done` to "Done". |

## Backend contract

This is the spec for backend authors. A backend is any executable, in any language, that implements the subcommands below. The core runs `<backend.command...> <subcommand> [args]` with an argument list (no shell), a timeout of 60 seconds per call, and kills the backend's process group when it is exceeded (also when its output passes 16 MiB).

### Rules

- Free text (a note, a task input) travels on stdin, never in argv. Ids, flags and subcommands are the only arguments.
- Exit 0 means success. Where a command says it prints JSON, stdout is exactly one JSON value; anything else on stdout is a failure. Diagnostics go to stderr.
- A non-zero exit is a failure. Print a one-line reason on stderr, first. The core keeps the first 4000 characters of stderr and shows the first 200 of them as one line, so the reason is the first line, and never put secrets in it.
- Exit 64 means "I do not implement this subcommand". Only `setup` may be missing.
- Every subcommand is atomic under concurrent calls. The core, the intake timer, a worker and a person at the terminal call a backend at the same time, so two overlapping `add-note` calls must both land and two overlapping `update-task` calls must not leave a half-applied task.
- A write is visible to the next read. When `update-task` or `add-note` has exited 0, a `get-task`, `list-tasks` or `read-notes` that starts after it shows the change.
- A backend must refuse an id outside the scope it is configured for (the Trello backend: a card of another board), with a non-zero exit and without writing. The core passes ids from tasks it listed, but also ids a person typed.
- The backend inherits the cwd and the environment of the process that called it, and the core adds nothing. The timeout and the output cap kill the backend's whole process group, so a wrapper script does not leave its child behind. Do not rely on the cwd.
- The core treats a non-zero exit, a timeout, invalid JSON and a missing or mistyped field as a backend failure and fails with one line. A failed read changes nothing: a failed `list-tasks` starts no worker and creates no task.
- The backend loads its own credentials. The core never reads them and passes none on.
- `input` must come back verbatim, and a note must come back with its text intact. The core parses them: `agent-board: started <iso>` notes (the start marker) and the `input` of a review task (first line PR URL, then `head: <sha>`). A store with a length cap may split a long note into consecutive notes (the Trello backend starts each piece with a `(part i/n)` line). The notes the core parses are short and are never split.
- The core never writes to a task that is `closed`. A worker that finds its task closed after the run (archived or parked by hand while it ran) drops its result and writes nothing: the task left the workflow, so nobody is waiting for a report. Any other outcome is judged on the task's `status` after the run: `needs-me` or `done` counts as reported.

### Task

```json
{
  "id": "Ab3dEf9x",
  "title": "#17741 Show postal code (dev)",
  "input": "https://github.com/cosuno/cosuno/pull/17741\nhead: 56120dc60b",
  "labels": ["review-pr"],
  "status": "todo",
  "url": "https://trello.com/c/Ab3dEf9x",
  "closed": false
}
```

All seven fields are required.

| Field | Meaning |
| --- | --- |
| `id` | Opaque string, stable for the life of the task. It ends up in a systemd unit name, a log file name and argv, so the core refuses any id that does not match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, whether a backend returns it or a user types it. The ids `dispatch` and `intake` are refused as well: the unit `agent-board-<id>` would collide with the tool's own units. |
| `title` | One line, shown in lists and Slack. |
| `input` | What to work on. The task description in most systems. |
| `labels` | Label names. The first one with a configured worker picks it. |
| `status` | One of `todo`, `running`, `needs-me`, `done`. |
| `url` | Link to the task for a human. It must match `^https?://` and hold no whitespace, `<`, `>` or `|`: it goes into a Slack link, where those end the link. The core refuses a task with any other url. |
| `closed` | `true` for archived tasks, or any task the backend wants out of the workflow. Closed tasks are only listed with `--all`; the core never starts, requeues or writes to one. A closed task still carries one of the four statuses: the one it had when it closed, or `done` when the backend has none. The core ignores the status of a closed task. |

Priority is the order of the array that `list-tasks` returns: within a status, the first task is the top. There is no rank field. The array holds every task: there is no paging, and a backend with pages must read them all before it answers.

### Subcommands

| Call | Stdin | Stdout |
| --- | --- | --- |
| `version` | - | `{"contract": 1}` |
| `list-tasks [--all]` | - | `[Task, ...]` in priority order |
| `get-task <id>` | - | `Task`. Its `id` is the one the core uses for every call after it, so every subcommand must accept it; normally it equals the `<id>` asked for |
| `add-task` | `{"title": string, "input"?: string, "labels"?: string[], "status"?: Status}` | the created `Task` |
| `update-task <id>` | `{"status"?: Status, "input"?: string}` | the updated `Task` |
| `add-note <id>` | the note text, verbatim, any length | nothing |
| `read-notes <id>` | - | `[{"text": string, "createdAt": string}, ...]`, oldest first |
| `setup [--dry-run]` | `{"labels": string[]}` | `{"created": string[]}` |

- `version`: the core calls it once per process, before its first real call, and refuses to go on when `contract` is not the number it was built for (1).
- `list-tasks`: open tasks only, all of them. `--all` adds the closed ones; intake needs them so a closed task never gets a second one.
- `add-task`: `input` defaults to `""`, `labels` to `[]`, `status` to `todo`. The new task goes to the bottom of its status. A label the backend does not know is a failure.
- `update-task`: at least one key; unknown keys are a failure. A status change puts the task at the bottom of the new status. `input` replaces the whole input.
- `add-note`: if the store caps a note's length, the backend splits it into consecutive notes, in order. An empty text is a failure.
- `read-notes`: `createdAt` is an ISO 8601 timestamp. The core sorts by it and does not rely on the order.
- `setup`: creates whatever the backend needs to work: the four statuses where they are lists, one label per name in `labels`. Idempotent. `created` names what it made (the core prints `created <entry>` for each). With `--dry-run` it writes nothing and `created` names what it would make (`board setup --dry-run` prints `DRY create <entry>` for each). Optional: exit 64 and `board setup` reports that the backend has none.

An id the backend does not know (`get-task nope`) is an ordinary failure.

### Writing a backend

1. Read `test/fixtures/fake-backend.mts`: a backend of about 150 lines that follows this contract (a lock around every call, atomic writes, a requeued task at the bottom of its status, unknown `update-task` keys refused) and keeps tasks in a JSON file. `src/backends/trello.mts` is the real one.
2. Implement the subcommands above in any language and make the file executable. Make every call atomic under concurrent calls (a lock, or the store's own transactions) and refuse ids outside your configured scope.
3. Map your system's states onto the four statuses, and decide how it orders tasks within a status.
4. Set `"backend": { "command": ["~/path/to/your-backend"] }` in `config.json`. The first element is an absolute path (`~/` is expanded) or a bare command name found on `PATH`; a relative path such as `bin/backend` is refused, because it would depend on the caller's cwd. Fixed arguments go in the same list.
5. Put credentials where only your backend reads them, and keep them out of the reviewer's reach: the reviewer's sandbox hides the home directory, and `board` runs outside it so that your backend can read its credentials (see [Reviewer isolation](#reviewer-isolation)). A credential that lives outside `~/.config/agent-board` needs no extra rule for the sandbox, but the reviewer's `Read` tool is not sandboxed: add a `Read(...)` deny rule for it to the label's `disallowedTools`.

A backend can also be tested without the core: `echo '{"status":"needs-me"}' | your-backend update-task <id>`.

### Trello backend

- A task's id is the card's short link; `url` is its short URL; `input` is the description; `labels` are the label names.
- Statuses are lists, named in `trello.json` (above). Order is the card position. A status change puts the card at the bottom of the list.
- A card in a list outside the four, or in an archived list, is parked: `closed: true`, listed only with `--all`.
- Every command that takes an id first checks that the card belongs to the configured board and refuses a foreign card without writing.
- All four lists must exist. A board that lacks one fails every command but `setup` with `board has no list "<name>" (run: board setup)`, before anything is written; without this a task that cannot be moved would be reported again on every tick. `trello.json` must map the four statuses to four different list names.
- An `update-task` is one request, and its answer is the card as the request left it. `get-task` reads the card, the board and the lists in one round.
- `add-task` finds labels by name and fails with "run: board setup" when the board lacks one.
- Notes are card comments, split at 16000 characters. `--all` reads `/cards/all`.

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
3. **Write to the board and to Slack** through `board comment`, `board move` and `board notify`, on any task id, as text.
4. **Fetch from `origin`** over `ssh` with every key in your agent, to any ref `git fetch origin` accepts (refspecs with a `:` and `--upload-pack` are denied).
5. Put text in its own answer, which Claude Code sends to Anthropic as usual.
6. Create new top-level files in the checkout and anything in `/tmp`.

The real GitHub token is in the environment of the `claude` process, which starts the commands outside the sandbox (`board`, `git fetch`) and any MCP server. The `Read` tool refuses `/proc` and a deny rule says so as well. A command that is allowed and prints its environment would leak it; none is on the list, and a new one must not be added.

Not covered: macOS (masked credential files and `ssh` through the sandbox behave differently there; the settings are not tried on it), and any host the worker's label adds to `allowedDomains`.

## Adding a label-to-worker mapping

Create a label in the backend with the same name as the key, or run `board setup`. Two shapes:

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

Runs `claude -p "/<skill> <task> <first line of input>" --permission-mode dontAsk --setting-sources user --settings <sandbox json>` with these allow and deny rules and the sandbox described under [Reviewer isolation](#reviewer-isolation). `dontAsk` denies everything not allowed, without prompting. `--setting-sources user` keeps the checkout's `.claude/settings*.json` (their allow rules and env tokens) out of the run; only `~/.claude/settings.json` loads. If you ever add `permissions.allow` rules there, they widen the reviewer's sandbox too. Rules starting with `Bash(` expand `~/` to your home directory and `{pr-review}` to the install path of the `pr-review@ccc` plugin, read from `~/.claude/plugins/installed_plugins.json` when the worker starts. A rule must not start with `*` before a script path: a leading `*` matches any command that merely contains the path. If the plugin path cannot be resolved the task goes to `needs-me` with the reason. `Read(...)` rules are passed on unchanged (they take `~/` themselves).

`sandbox` is required for a skill label: the worker sends a task whose label has none to `needs-me` and starts nothing. Its keys, all lists except `maskedEnv`:

| Key | Meaning |
| --- | --- |
| `allowRead` | Paths the sandboxed commands may read in the home directory, besides the checkout. `~/` and `{pr-review}` are expanded. |
| `allowWrite` | Paths they may write, besides the checkout's `.git` and `/tmp`. |
| `allowedDomains` | Hosts they may reach through the proxy. |
| `excludedCommands` | Commands (Bash rule syntax, matched as text) that run outside the sandbox. Each one must also be in `allowedTools`. Never put a script, a shell or any command that takes a file or a command as its argument here. |
| `maskedEnv` | Per entry: `name`, `command` (run by the worker without a shell; its stdout is the value) and `injectHosts` (the only hosts the real value is sent to). The value goes into the environment of `claude`, where the sandbox masks it. A failing command sends the task to `needs-me` without its output. |

The worker adds the rest: the home directory is denied, the checkout is readable, its `.git` and `/tmp` are writable, and its other entries are read-only.

`cwd` is `pr-repo` (the checkout `repos` maps the PR's repository to) or a directory. The skill must exist in `~/.claude/skills`, and it should end by moving the task to `needs-me`.

```json
"selftest": { "command": ["sleep", "300"] }
```

Runs a plain command (optional `cwd`). Use it to test the cap and the sweep without spending tokens. An exit code other than 0 is a failure; exit 0 with the task in any status but `needs-me` or `done` is reported as "finished without reporting". A task that is closed after the run is left alone, whatever the outcome (see the contract). A command label runs without a sandbox.

Known gaps of the headless review: it loads no project settings, so the Shortcut MCP token from the project settings is missing and `mcp__shortcut__get_story` may fail (the skill treats the story lookup as best effort). The review is not mirrored into the brain journal; do that by hand if you want it.

A missing allowed tool shows up as a failed run: the log says what was denied. Add it to `allowedTools`.

## Commands

```
board tasks                     open tasks per status
board comment <task> <text>     add a note; `-` reads the text from stdin
board comment <task> --file <p> add a note from a file in /tmp (what the reviewer uses)
board move <task> <status>      move to the bottom of a status
board notify <task> <text>      Slack message with the task link
board setup                     ask the backend to create what it needs; with --dry-run, list what it would create
dispatch                        one dispatcher tick
intake                          review requests to tasks
```

`<task>` is the task id the backend reports. `<status>` is `todo`, `running`, `needs-me` or `done`; the old names "Todo", "Running", "Needs me" and "Done" work too. `dispatch`, `intake` and `board` take `--dry-run`: reads happen, every write and process start is printed as `DRY ...` (for example `DRY update-task <id> {"status":"running"}`). An unknown argument is a usage error. Which tasks `board` may touch is the backend's call; the Trello backend serves only its configured board.

`bin/dispatch` and `bin/intake` take their own lock (`$XDG_RUNTIME_DIR/agent-board-{dispatch,intake}.lock`), so a run by hand cannot overlap a timer run. When the lock is held they exit 75 without output.

## How it decides

Dispatcher, per tick:

1. For each task in `running`, ask `systemctl --user is-active agent-board-<task>`. A task whose unit is gone, or whose unit started more than the timeout plus five minutes ago (the start note is the fallback), moves to `needs-me` with the log tail. If `systemctl` gives no known state, or the backend fails, the tick stops before starting anything and exits non-zero. The worker enforces the timeout itself; this catches a worker that died.
2. While fewer than `maxParallel` run (the larger of the tasks in `running` and the active `agent-board-*` units), take the top task of `todo`. No known label: `needs-me` with a note. Otherwise: `running`, start `systemd-run --user --collect --unit agent-board-<task>`, then add a note with the start time and PID. The first failed start ends the tick's starting.

Intake, per run: search each repo in `repos` for open, non-draft PRs that request your review, then create one task per PR URL, checked against every task, closed ones included (a closed task is never requeued). A PR that `gh pr view` cannot read is logged and skipped. A PR whose head moved and whose last commit is at least ten minutes old sends its task from `needs-me` or `done` back to `todo`. A failed task stays in `needs-me` until the head moves. A failed GitHub search or backend listing changes nothing and exits non-zero. The age of a head is the date of its last commit, so a push of old commits counts as settled.

## Development

```
npm test           node --test
npm run typecheck  tsc --noEmit
```

Decision logic is in `src/decide.mts`, `planIntake` and the `run*` functions, which take a backend, GitHub and system interface as arguments. `src/contract.mts` holds the backend interface and the checks on its JSON; `src/backend.mts` is the CLI adapter. Tests inject fakes (`test/helpers.mts`), and `test/backend.test.mts` runs the adapter against `test/fixtures/fake-backend.mts`.
