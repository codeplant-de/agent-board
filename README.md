# agent-board

A task backend is the queue. A systemd user timer runs a dispatcher every two minutes. The dispatcher takes tasks from the top of Todo and starts a headless `claude -p` worker for each, with a cap on parallel runs. The worker reports on the task. Phase 1 is PR review.

The backend is the only state. There is no database and no state file: the task's status says where it is, and the worker unit says when it started. The core talks to the backend through one configured CLI (see [Backend contract](#backend-contract)). This repo ships a Trello backend, `bin/trello-backend`; another one is any executable that implements the contract.

## Tasks

Four statuses: `todo`, `running`, `needs-me`, `done`. Order within `todo` is priority. A task's label picks the worker. The first line of its `input` is the PR URL; intake adds a `head: <sha>` line.

A finished task moves itself to `needs-me`. A task that fails, times out, has no known label, or whose worker disappears also ends in `needs-me`, with the reason and the end of the log as a note.

## Install

Needs Node 24+, `flock`, `systemd-run`, `gh` and `claude`. No runtime dependencies; `npm install` only adds TypeScript for the type check.

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
3. `./install.sh` symlinks the units into `~/.config/systemd/user`, `bin/board` into `~/.local/bin` and the skill into `~/.claude/skills`. It enables and starts nothing.
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

This is the spec for backend authors. A backend is any executable, in any language, that implements the subcommands below. The core runs `<backend.command...> <subcommand> [args]` with an argument list (no shell), a timeout of 60 seconds per call, and kills the process when it is exceeded.

### Rules

- Free text (a note, a task input) travels on stdin, never in argv. Ids, flags and subcommands are the only arguments.
- Exit 0 means success. Where a command says it prints JSON, stdout is exactly one JSON value; anything else on stdout is a failure. Diagnostics go to stderr.
- A non-zero exit is a failure. Print a one-line reason on stderr. The core shows its first 200 characters, so never put secrets in it.
- Exit 64 means "I do not implement this subcommand". Only `setup` may be missing.
- The core treats a non-zero exit, a timeout, invalid JSON and a missing or mistyped field as a backend failure and fails with one line. A failed read changes nothing: a failed `list-tasks` starts no worker and creates no task.
- The backend loads its own credentials. The core never reads them and passes none on.
- Notes and `input` must come back verbatim. The core parses them: `agent-board: started <iso>` notes (the start marker) and the `input` of a review task (first line PR URL, then `head: <sha>`).

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
| `id` | Opaque string, stable for the life of the task. It ends up in a systemd unit name, a log file name and argv, so the core refuses any id that does not match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, whether a backend returns it or a user types it. |
| `title` | One line, shown in lists and Slack. |
| `input` | What to work on. The task description in most systems. |
| `labels` | Label names. The first one with a configured worker picks it. |
| `status` | One of `todo`, `running`, `needs-me`, `done`. |
| `url` | Link to the task for a human. |
| `closed` | `true` for archived tasks, or any task the backend wants out of the workflow. Closed tasks are only listed with `--all`; the core never starts or requeues one. |

Priority is the order of the array that `list-tasks` returns: within a status, the first task is the top. There is no rank field.

### Subcommands

| Call | Stdin | Stdout |
| --- | --- | --- |
| `version` | - | `{"contract": 1}` |
| `list-tasks [--all]` | - | `[Task, ...]` in priority order |
| `get-task <id>` | - | `Task` |
| `add-task` | `{"title": string, "input"?: string, "labels"?: string[], "status"?: Status}` | the created `Task` |
| `update-task <id>` | `{"status"?: Status, "input"?: string}` | the updated `Task` |
| `add-note <id>` | the note text, verbatim, any length | nothing |
| `read-notes <id>` | - | `[{"text": string, "createdAt": string}, ...]`, oldest first |
| `setup` | `{"labels": string[]}` | `{"created": string[]}` |

- `version`: the core calls it once per process, before its first real call, and refuses to go on when `contract` is not the number it was built for (1).
- `list-tasks`: open tasks only. `--all` adds closed ones; intake needs them so a closed task never gets a second one.
- `add-task`: `input` defaults to `""`, `labels` to `[]`, `status` to `todo`. The new task goes to the bottom of its status. A label the backend does not know is a failure.
- `update-task`: at least one key; unknown keys are a failure. A status change puts the task at the bottom of the new status. `input` replaces the whole input.
- `add-note`: if the store caps a note's length, the backend splits it. An empty text is a failure.
- `read-notes`: `createdAt` is an ISO 8601 timestamp. The core sorts by it and does not rely on the order.
- `setup`: creates whatever the backend needs to work: the four statuses where they are lists, one label per name in `labels`. Idempotent. `created` names what it made (the core prints `created <entry>` for each). Optional: exit 64 and `board setup` reports that the backend has none.

An id the backend does not know (`get-task nope`) is an ordinary failure.

### Writing a backend

1. Read `test/fixtures/fake-backend.mts`: a complete backend of about 100 lines that keeps tasks in a JSON file. `src/backends/trello.mts` is the real one.
2. Implement the subcommands above in any language and make the file executable.
3. Map your system's states onto the four statuses, and decide how it orders tasks within a status.
4. Set `"backend": { "command": ["~/path/to/your-backend"] }` in `config.json`. Fixed arguments go in the same list.
5. Put credentials where only your backend reads them. The review worker denies `Read(~/.config/**)`; if you keep secrets elsewhere, add a matching `Read(...)` deny rule to the label's `disallowedTools`.

A backend can also be tested without the core: `echo '{"status":"needs-me"}' | your-backend update-task <id>`.

### Trello backend

- A task's id is the card's short link; `url` is its short URL; `input` is the description; `labels` are the label names.
- Statuses are lists, named in `trello.json` (above). Order is the card position. A status change puts the card at the bottom of the list.
- A card in a list outside the four, or in an archived list, is parked: `closed: true`, listed only with `--all`.
- Every command that takes an id first checks that the card belongs to the configured board and refuses a foreign card without writing.
- `add-task` finds labels by name and fails with "run: board setup" when the board lacks one.
- Notes are card comments, split at 16000 characters. `--all` reads `/cards/all`.

## Reviewer isolation

The review worker may run `Bash(board *)` and nothing else that touches a backend. The backend's path is not on its allow list, `dontAsk` denies everything not allowed, and `Read(~/.config/**)` keeps it away from `~/.config/agent-board/env`. The core holds no backend credentials, and a backend loads its own only in its own process.

## Adding a label-to-worker mapping

Create a label in the backend with the same name as the key, or run `board setup`. Two shapes:

```json
"review-pr": {
  "skill": "board-review-pr",
  "cwd": "pr-repo",
  "allowedTools": ["Read", "Bash(board *)"],
  "disallowedTools": ["Bash(git push *)"]
}
```

Runs `claude -p "/<skill> <task> <first line of input>" --permission-mode dontAsk --setting-sources user` with these allow and deny rules. `dontAsk` denies everything not allowed, without prompting. `--setting-sources user` keeps the checkout's `.claude/settings*.json` (their allow rules and env tokens) out of the run; only `~/.claude/settings.json` loads. If you ever add `permissions.allow` rules there, they widen the reviewer's sandbox too. Rules starting with `Bash(` expand `~/` to your home directory and `{pr-review}` to the install path of the `pr-review@ccc` plugin, read from `~/.claude/plugins/installed_plugins.json` when the worker starts. A rule must not start with `*` before a script path: a leading `*` matches any command that merely contains the path. If the plugin path cannot be resolved the task goes to `needs-me` with the reason. `Read(...)` rules are passed on unchanged (they take `~/` themselves).

`cwd` is `pr-repo` (the checkout `repos` maps the PR's repository to) or a directory. The skill must exist in `~/.claude/skills`, and it should end by moving the task to `needs-me`.

```json
"selftest": { "command": ["sleep", "300"] }
```

Runs a plain command (optional `cwd`). Use it to test the cap and the sweep without spending tokens. An exit code other than 0 is a failure; exit 0 with the task in any status but `needs-me` or `done` is reported as "finished without reporting".

Known gaps of the headless review: it loads no project settings, so the Shortcut MCP token from the project settings is missing and `mcp__shortcut__get_story` may fail (the skill treats the story lookup as best effort). The review is not mirrored into the brain journal; do that by hand if you want it.

A missing allowed tool shows up as a failed run: the log says what was denied. Add it to `allowedTools`.

## Commands

```
board tasks                     open tasks per status
board comment <task> <text>     add a note; `-` reads the text from stdin
board move <task> <status>      move to the bottom of a status
board notify <task> <text>      Slack message with the task link
board setup                     ask the backend to create what it needs
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
